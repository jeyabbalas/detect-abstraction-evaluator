/**
 * The datasets the Data view loads into the data table, built as JSON text:
 * the gold standard, each pipeline's predictions (with the cells that disagree
 * with gold as annotations) and a long cell-by-cell comparison of every
 * pipeline. Pure functions — no DOM and no data-table runtime — so they can be
 * tested in Node.
 */

import type { ColumnHeaderTooltipContent, ColumnHeaderTooltipItem, NewAnnotation } from '@jeyabbalas/data-table';
import type { Analysis, PipelineAnalysis } from '../../core/analysis';
import { MISSING, Outcome, cellValue, isError } from '../../core/evaluate';
import type { AbstractionRecord, FieldInfo, RecordId, SchemaModel } from '../../core/types';
import type { SchemaIssue } from '../../core/validate';
import { OUTCOME_LABEL } from '../../ui/components';
import { fmtInt, truncate } from '../../ui/format';

export const GOLD = 'gold';
export const CELLS = 'cells';
/** The derived column added to pipeline datasets. */
export const ERRORS_COLUMN = 'errors_vs_gold';
/** The data table's reserved row-id column. */
export const ROWID = '__rowid__';

export type DatasetKind = 'gold' | 'pipeline' | 'cells';

export interface DatasetOption {
  /** URL value (`?dataset=`): 'gold', 'cells' or the pipeline id. */
  key: string;
  kind: DatasetKind;
  label: string;
  /** Position in `analysis.pipelines` (pipeline datasets). */
  pipeline?: number;
}

export interface DatasetStats {
  /** Categorical cells that disagree with gold (pipeline datasets). */
  mismatches: number;
  /** JSON Schema issues on the dataset's records. */
  schemaIssues: number;
  /** Records the run was asked for that have no prediction. */
  missing: number;
}

export interface Dataset {
  key: string;
  kind: DatasetKind;
  label: string;
  /** DuckDB table name; it also names the export files. */
  tableName: string;
  /** JSON array of row objects, keys in column order. */
  json: string;
  rowCount: number;
  /** Column names in load order. */
  columns: string[];
  tooltips: [string, ColumnHeaderTooltipContent][];
  /** Rows are records keyed by the id field (gold and pipeline datasets). */
  keyed: boolean;
  /** Categorical errors per scored record — the errors_vs_gold column (pipeline datasets). */
  errorCounts: ReadonlyMap<RecordId, number> | null;
  /** Annotations for the loaded rows, given record id → `__rowid__`. */
  annotations(rowOf: ReadonlyMap<RecordId, number>): NewAnnotation[];
  stats: DatasetStats;
}

// ---------------------------------------------------------------- options

/** Rows of the cell comparison: Σ over pipelines of scored records × categorical variables. */
export function cellRowCount(analysis: Analysis): number {
  const fields = analysis.experiment.schema.categoricalFields.length;
  let n = 0;
  for (const pa of analysis.pipelines) n += scoredIds(pa).length * fields;
  return n;
}

/** Gold standard, one entry per pipeline, then the cell comparison (when it has rows). */
export function datasetOptions(analysis: Analysis): DatasetOption[] {
  const out: DatasetOption[] = [{ key: GOLD, kind: 'gold', label: 'Gold standard' }];
  analysis.pipelines.forEach((pa, i) => {
    const id = pa.pipeline.id;
    // A pipeline folder literally named "gold" or "cells" keeps a distinct key.
    const key = id === GOLD || id === CELLS ? `pipeline:${id}` : id;
    out.push({ key, kind: 'pipeline', label: pa.pipeline.name, pipeline: i });
  });
  if (cellRowCount(analysis) > 0) out.push({ key: CELLS, kind: 'cells', label: 'Cell comparison' });
  return out;
}

/** The option a `?dataset=` value names, or null. */
export function resolveDatasetKey(options: readonly DatasetOption[], requested: string | null | undefined): string | null {
  if (!requested) return null;
  return options.find((o) => o.key === requested)?.key ?? null;
}

/**
 * Stable, readable DuckDB table names (they name the export files:
 * `<table>_export.csv`): `gold_standard`, `cell_comparison` and one per
 * pipeline from its folder name, made unique ignoring case as DuckDB does.
 */
export function tableNames(options: readonly DatasetOption[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  const claim = (key: string, base: string) => {
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`;
    used.add(name);
    names.set(key, name);
  };
  for (const o of options) {
    if (o.kind === 'gold') claim(o.key, 'gold_standard');
    if (o.kind === 'cells') claim(o.key, 'cell_comparison');
  }
  for (const o of options) {
    if (o.kind !== 'pipeline') continue;
    let base = o.label
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
    if (!base || /^[0-9]/.test(base) || base.startsWith('__')) base = `pipeline_${base || (o.pipeline ?? 0) + 1}`;
    claim(o.key, base);
  }
  return names;
}

// ------------------------------------------------------------- row ids

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * record id → `__rowid__`, from two `getColumnValues` reads (both in
 * `__rowid__` order; typed arrays, bigints or plain values).
 */
export function rowIdMap(rowids: ArrayLike<unknown>, ids: ArrayLike<unknown>): Map<RecordId, number> {
  const out = new Map<RecordId, number>();
  const n = Math.min(rowids.length, ids.length);
  for (let i = 0; i < n; i += 1) {
    const rid = toNumber(ids[i]);
    const row = toNumber(rowids[i]);
    if (rid === null || row === null || out.has(rid)) continue;
    out.set(rid, row);
  }
  return out;
}

/** Values of a vector column aligned to `__rowid__` (NaN loads as NULL). */
export function errorVector(counts: ReadonlyMap<RecordId, number>, rowOf: ReadonlyMap<RecordId, number>, rows: number): number[] {
  const values = new Array<number>(rows).fill(Number.NaN);
  for (const [rid, row] of rowOf) {
    const c = counts.get(rid);
    if (c !== undefined && Number.isInteger(row) && row >= 0 && row < rows) values[row] = c;
  }
  return values;
}

/** `order` with `column` moved right after `anchor` (to the front when the anchor is absent). */
export function placeAfter(order: readonly string[], column: string, anchor: string): string[] {
  const rest = order.filter((c) => c !== column);
  rest.splice(rest.indexOf(anchor) + 1, 0, column);
  return rest;
}

// --------------------------------------------------------------- JSON

const RESERVED = ROWID.toLowerCase();

/**
 * Columns of a record dataset: the id, every schema variable in schema order,
 * then keys the records carry that the schema does not define (unique ignoring
 * case, as DuckDB binds names; the reserved row id is left out).
 */
export function recordColumns(schema: SchemaModel, records: Iterable<AbstractionRecord>): string[] {
  const columns = [schema.idField, ...schema.fields.map((f) => f.name)];
  const seen = new Set(columns.map((c) => c.toLowerCase()));
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      const lower = key.toLowerCase();
      if (!key || lower === RESERVED || seen.has(lower)) continue;
      seen.add(lower);
      columns.push(key);
    }
  }
  return columns;
}

const jsonValue = (v: unknown): string => {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
  return JSON.stringify(v) ?? 'null';
};

/**
 * A JSON array of records with keys in `columns` order (written by hand: a
 * JS object would list integer-like keys first). Values keep their JSON type;
 * absent values are null; the id is the record's key in the map.
 */
export function recordsJson(
  ids: readonly RecordId[],
  get: (rid: RecordId) => AbstractionRecord | undefined,
  idField: string,
  columns: readonly string[],
): string {
  const keys = columns.map((c) => `${JSON.stringify(c)}:`);
  const rows = ids.map((rid) => {
    const rec = get(rid);
    return `{${columns.map((c, i) => keys[i] + (c === idField ? jsonValue(rid) : jsonValue(rec?.[c]))).join(',')}}`;
  });
  return `[${rows.join(',\n')}]`;
}

// ----------------------------------------------------------- tooltips

const ID_TOOLTIP: ColumnHeaderTooltipContent = {
  title: 'Record ID',
  description: 'Primary key: one record per pathology report. Select a row, then Open record to see it next to its report.',
  items: [{ label: 'Type', value: 'identifier' }],
};

export const ERRORS_TOOLTIP: ColumnHeaderTooltipContent = {
  title: 'Errors vs. gold',
  description:
    'Categorical variables of this record whose prediction disagrees with the gold standard (FP, FN or FP+FN). Sort or filter by it to find the hardest records. Empty when the record is not scored (not in the gold standard, or not among the records the run was asked for).',
  items: [{ label: 'Type', value: 'derived (integer)' }],
};

const KIND_LABEL: Record<FieldInfo['kind'], string> = {
  categorical: 'categorical',
  text: 'free text (not scored)',
  id: 'identifier',
};

export interface Disagreements {
  /** Variable → number of scored records that disagree with gold. */
  counts: ReadonlyMap<string, number>;
  scored: number;
}

export function fieldTooltip(schema: SchemaModel, f: FieldInfo, compare: Disagreements | null = null): ColumnHeaderTooltipContent {
  const items: ColumnHeaderTooltipItem[] = [];
  const category = schema.categoryByKey.get(f.category)?.title;
  if (category) items.push({ label: 'Category', value: category });
  items.push({ label: 'Type', value: KIND_LABEL[f.kind] });
  if (f.kind === 'categorical' && f.domain.length) items.push({ label: 'Valid values', value: [...f.domain] });
  if (f.defaultLabel) items.push({ label: 'Default label', value: f.defaultLabel });
  if (compare) {
    const n = compare.counts.get(f.name) ?? 0;
    items.push({
      label: f.kind === 'categorical' ? 'Disagreements with gold' : 'Differs from gold (exact text)',
      value: `${fmtInt(n)} of ${fmtInt(compare.scored)} records`,
    });
  }
  const description = truncate(f.description.trim(), 700);
  return { title: f.title || f.name, ...(description ? { description } : {}), items };
}

function recordTooltips(schema: SchemaModel, columns: readonly string[], compare: Disagreements | null): [string, ColumnHeaderTooltipContent][] {
  return columns.map((col) => {
    if (col === schema.idField) return [col, ID_TOOLTIP];
    const f = schema.byName.get(col);
    if (!f) return [col, { title: col, description: 'Not defined in the data dictionary.' }];
    return [col, fieldTooltip(schema, f, compare)];
  });
}

// --------------------------------------------------------- annotations

const MISMATCH_TAIL: Record<number, string> = {
  [Outcome.FP]: 'predicted an informative label where gold has the default (over-call)',
  [Outcome.FN]: 'predicted the default label where gold is informative (miss)',
  [Outcome.FPFN]: 'predicted a different informative label (counts as one FP and one FN)',
};

/** "Gold: 'Cannot determine' · FP — predicted an informative label where gold has the default (over-call)" */
export function mismatchMessage(gold: string, pred: string, outcome: number): string {
  const shown = gold === MISSING ? 'no value' : `'${gold}'`;
  const tail = pred === MISSING ? 'no prediction (a missing value is scored as wrong)' : MISMATCH_TAIL[outcome] ?? 'disagrees with gold';
  return `Gold: ${shown} · ${OUTCOME_LABEL[outcome] ?? 'Error'} — ${tail}`;
}

function issueAnnotations(
  issues: ReadonlyMap<RecordId, SchemaIssue[]> | null,
  rowOf: ReadonlyMap<RecordId, number>,
  columns: ReadonlySet<string>,
  out: NewAnnotation[],
): void {
  if (!issues) return;
  for (const [rid, list] of issues) {
    const rowId = rowOf.get(rid);
    if (rowId === undefined) continue;
    for (const issue of list) {
      const message = issue.rule ? `${issue.message} (rule: ${issue.rule})` : issue.message;
      const code = `SCHEMA_${issue.keyword.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
      const base = { severity: 'warning' as const, message, code, source: 'JSON Schema' };
      if (issue.field && columns.has(issue.field)) out.push({ scope: 'cell', rowId, column: issue.field, ...base });
      else out.push({ scope: 'row', rowId, ...base });
    }
  }
}

function countIssues(issues: ReadonlyMap<RecordId, SchemaIssue[]> | null, ids: readonly RecordId[]): number {
  if (!issues) return 0;
  let n = 0;
  for (const rid of ids) n += issues.get(rid)?.length ?? 0;
  return n;
}

// ------------------------------------------------------------ datasets

/** Records a pipeline is scored on: its run ids that are in the gold standard, sorted. */
export function scoredIds(pa: PipelineAnalysis): RecordId[] {
  return [...new Set(pa.pipeline.ids)].filter((rid) => pa.outcomes.has(rid)).sort((a, b) => a - b);
}

const normText = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

function goldDataset(analysis: Analysis, option: DatasetOption, tableName: string): Dataset {
  const { experiment } = analysis;
  const { schema } = experiment;
  const ids = [...experiment.goldIds].sort((a, b) => a - b);
  const columns = recordColumns(schema, experiment.gold.values());
  const issues = analysis.goldSchemaIssues;
  const columnSet = new Set(columns);
  return {
    key: option.key,
    kind: 'gold',
    label: option.label,
    tableName,
    json: recordsJson(ids, (rid) => experiment.gold.get(rid), schema.idField, columns),
    rowCount: ids.length,
    columns,
    tooltips: recordTooltips(schema, columns, null),
    keyed: true,
    errorCounts: null,
    annotations(rowOf) {
      const out: NewAnnotation[] = [];
      issueAnnotations(issues, rowOf, columnSet, out);
      return out;
    },
    stats: { mismatches: 0, schemaIssues: countIssues(issues, ids), missing: 0 },
  };
}

function pipelineDataset(analysis: Analysis, option: DatasetOption, pa: PipelineAnalysis, tableName: string): Dataset {
  const { experiment } = analysis;
  const { schema } = experiment;
  const p = pa.pipeline;
  const ids = [...new Set<RecordId>([...p.predictions.keys(), ...pa.missing])].sort((a, b) => a - b);
  const columns = recordColumns(schema, p.predictions.values());
  const columnSet = new Set(columns);
  const fields = schema.categoricalFields;

  // Disagreements per variable over the scored records shown.
  const scored = ids.filter((rid) => pa.errorCount.has(rid) && pa.outcomes.has(rid));
  const counts = new Map<string, number>();
  let mismatches = 0;
  for (const rid of scored) {
    const codes = pa.outcomes.get(rid)!;
    fields.forEach((field, i) => {
      if (isError(codes[i]!)) {
        counts.set(field, (counts.get(field) ?? 0) + 1);
        mismatches += 1;
      }
    });
    const g = experiment.gold.get(rid);
    const pred = p.predictions.get(rid);
    for (const field of schema.textFields) {
      if (normText(cellValue(g, field)) !== normText(cellValue(pred, field))) counts.set(field, (counts.get(field) ?? 0) + 1);
    }
  }

  const missing = new Set(pa.missing);
  return {
    key: option.key,
    kind: 'pipeline',
    label: option.label,
    tableName,
    json: recordsJson(ids, (rid) => p.predictions.get(rid), schema.idField, columns),
    rowCount: ids.length,
    columns,
    tooltips: recordTooltips(schema, columns, { counts, scored: scored.length }),
    keyed: true,
    errorCounts: pa.errorCount,
    annotations(rowOf) {
      const out: NewAnnotation[] = [];
      for (const rid of missing) {
        const rowId = rowOf.get(rid);
        if (rowId === undefined) continue;
        out.push({
          scope: 'row',
          rowId,
          severity: 'error',
          code: 'NO_PREDICTION',
          source: 'predictions.json',
          message: 'No prediction for this record — the run was asked for it, and every variable counts as wrong.',
        });
      }
      for (const rid of scored) {
        const rowId = rowOf.get(rid);
        if (rowId === undefined) continue;
        const codes = pa.outcomes.get(rid)!;
        const g = experiment.gold.get(rid);
        const pred = p.predictions.get(rid);
        fields.forEach((field, i) => {
          const o = codes[i]!;
          if (!isError(o) || !columnSet.has(field)) return;
          out.push({
            scope: 'cell',
            rowId,
            column: field,
            severity: 'error',
            code: 'MISMATCH',
            source: 'gold standard',
            message: mismatchMessage(cellValue(g, field), cellValue(pred, field), o),
          });
        });
      }
      issueAnnotations(pa.schemaIssues, rowOf, columnSet, out);
      return out;
    },
    stats: { mismatches, schemaIssues: countIssues(pa.schemaIssues, ids), missing: pa.missing.length },
  };
}

/** Outcome text of the cell comparison, by outcome code. */
export const CELL_OUTCOME: Record<number, string> = {
  [Outcome.TP]: 'Correct (informative)',
  [Outcome.TN]: 'Correct (default)',
  [Outcome.FP]: 'FP',
  [Outcome.FN]: 'FN',
  [Outcome.FPFN]: 'FP+FN',
};

const OUTCOME_ORDER = [Outcome.TP, Outcome.TN, Outcome.FP, Outcome.FN, Outcome.FPFN];

/** Column names of the cell comparison. */
export function cellColumns(idField: string): string[] {
  return ['pipeline', idField, 'unique_text', 'category', 'variable', 'gold', 'prediction', 'outcome', 'correct'];
}

function cellsDataset(analysis: Analysis, option: DatasetOption, tableName: string): Dataset {
  const { experiment } = analysis;
  const { schema } = experiment;
  const fields = schema.categoricalFields;
  const q = (s: string) => JSON.stringify(s);
  const catTitle = (field: string) => schema.categoryByKey.get(schema.byName.get(field)?.category ?? '')?.title ?? '';
  const varQ = fields.map(q);
  const catQ = fields.map((f) => q(catTitle(f)));
  const outQ: Record<number, string> = {};
  for (const code of OUTCOME_ORDER) outQ[code] = q(CELL_OUTCOME[code]!);
  const values = new Map<string, string>();
  const val = (v: string): string => {
    if (v === MISSING) return 'null';
    let s = values.get(v);
    if (s === undefined) values.set(v, (s = q(v)));
    return s;
  };
  const unique = new Set(experiment.uniqueIds);
  const idKey = q(schema.idField);

  const rows: string[] = [];
  for (const pa of analysis.pipelines) {
    const name = q(pa.pipeline.name);
    for (const rid of scoredIds(pa)) {
      const codes = pa.outcomes.get(rid)!;
      const g = experiment.gold.get(rid);
      const pred = pa.pipeline.predictions.get(rid);
      const head = `{"pipeline":${name},${idKey}:${jsonValue(rid)},"unique_text":${unique.has(rid)},"category":`;
      for (let i = 0; i < fields.length; i += 1) {
        const field = fields[i]!;
        const o = codes[i]!;
        rows.push(
          `${head}${catQ[i]},"variable":${varQ[i]},"gold":${val(cellValue(g, field))},"prediction":${val(cellValue(pred, field))},"outcome":${outQ[o] ?? 'null'},"correct":${!isError(o)}}`,
        );
      }
    }
  }

  const pipelines = analysis.pipelines.map((pa) => pa.pipeline.name);
  const categories = [...new Set(fields.map(catTitle).filter(Boolean))];
  const columns = cellColumns(schema.idField);
  const tooltips: [string, ColumnHeaderTooltipContent][] = [
    ['pipeline', { title: 'Pipeline', description: 'The abstraction pipeline (its folder under abstractions/).', items: [{ label: 'Values', value: pipelines }] }],
    [schema.idField, { ...ID_TOOLTIP, description: 'The record (pathology report) the cell belongs to. Select a row, then Open record to see it next to its report.' }],
    [
      'unique_text',
      {
        title: 'Unique report text',
        description:
          'True for the lowest record_id of each group of records with identical report text — the records the headline "Unique reports" population scores. False for duplicate copies. Filter to true to reproduce the headline population.',
        items: [{ label: 'Type', value: 'boolean' }],
      },
    ],
    ['category', { title: 'Category', description: "The variable's group in the data dictionary.", items: [{ label: 'Values', value: categories }] }],
    ['variable', { title: 'Variable', description: 'The categorical variable. Free-text variables are not scored and not included.' }],
    ['gold', { title: 'Gold value', description: 'The gold-standard label. Empty when the gold record has no value for the variable.' }],
    ['prediction', { title: 'Prediction', description: "The pipeline's label. Empty when the pipeline produced no value (scored as wrong)." }],
    [
      'outcome',
      {
        title: 'Outcome',
        description: [
          'Correct (informative): matches gold, and gold is informative (a true positive).',
          'Correct (default): matches gold, and both are the default label (not rewarded by the informative metrics).',
          'FP: an informative label where gold has the default label (over-call).',
          'FN: the default label where gold is informative (miss).',
          'FP+FN: a different informative label (one FP and one FN).',
        ].join('\n'),
        items: [{ label: 'Values', value: OUTCOME_ORDER.map((c) => CELL_OUTCOME[c]!) }],
      },
    ],
    ['correct', { title: 'Correct', description: 'True when the prediction equals the gold value (either correct outcome).', items: [{ label: 'Type', value: 'boolean' }] }],
  ];

  return {
    key: option.key,
    kind: 'cells',
    label: option.label,
    tableName,
    json: `[${rows.join(',\n')}]`,
    rowCount: rows.length,
    columns,
    tooltips,
    keyed: false,
    errorCounts: null,
    annotations: () => [],
    stats: { mismatches: 0, schemaIssues: 0, missing: 0 },
  };
}

/** Build a dataset (JSON text, tooltips, annotation builder) for an option. */
export function buildDataset(analysis: Analysis, option: DatasetOption, tableName: string): Dataset {
  if (option.kind === 'gold') return goldDataset(analysis, option, tableName);
  if (option.kind === 'cells') return cellsDataset(analysis, option, tableName);
  const pa = analysis.pipelines[option.pipeline ?? -1];
  if (!pa) throw new Error(`Unknown pipeline dataset "${option.key}"`);
  return pipelineDataset(analysis, option, pa, tableName);
}
