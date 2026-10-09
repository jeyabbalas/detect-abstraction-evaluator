/**
 * Data model of the Fields view: per-category and per-variable scores of every
 * pipeline under the current population and metric source, plus the pure
 * helpers the charts and the drawer need. No DOM access here (unit-tested).
 */

import { comparisonIds, scoresFor, type Analysis, type MetricSource } from '../../core/analysis';
import { MISSING, cellValue, isError } from '../../core/evaluate';
import { TEXT_DEFAULT } from '../../core/schema';
import type {
  CategoryInfo,
  FieldInfo,
  FieldScore,
  PopulationName,
  PopulationScores,
  RecordId,
  ScoreSummary,
  TextScore,
} from '../../core/types';

/** Informative errors of a score: FP + FN (a wrong informative label counts twice). */
export const informativeErrors = (s: { fp: number; fn: number } | null | undefined): number => (s ? s.fp + s.fn : 0);

/** Informative gold values behind a score: TP + FN (identical for every pipeline on the same records). */
export const goldInformative = (s: { tp: number; fn: number }): number => s.tp + s.fn;

export interface CategoryCell {
  /** Index into `analysis.pipelines`. */
  pipe: number;
  summary: ScoreSummary | null;
  errors: number;
}

export interface CategoryRow {
  category: CategoryInfo;
  /** Distinct gold-informative counts across pipelines (one value unless they were scored on different records). */
  gold: number[];
  cells: CategoryCell[];
  /** Sum of informative errors over pipelines. */
  errors: number;
}

export interface FieldCell {
  pipe: number;
  score: FieldScore | null;
  errors: number;
}

export interface FieldRow {
  field: FieldInfo;
  category: CategoryInfo;
  gold: number[];
  cells: FieldCell[];
  errors: number;
}

export interface TextRow {
  field: FieldInfo;
  cells: { pipe: number; score: TextScore | null }[];
}

export interface FieldsModel {
  population: PopulationName;
  source: MetricSource;
  /** Records compared (population ∩ records every pipeline was run on). */
  ids: RecordId[];
  scores: (PopulationScores | null)[];
  /** Categories with at least one categorical variable, in schema order. */
  categories: CategoryRow[];
  /** Categorical variables per category key, in schema order. */
  fieldsByCategory: Map<string, FieldRow[]>;
  fieldByName: Map<string, FieldRow>;
  text: TextRow[];
  /** Largest informative-error count of any category × pipeline cell. */
  categoryMax: number;
  /** Largest informative-error count of any variable × pipeline cell. */
  fieldMax: number;
  /** True when at least one pipeline has scores for the population. */
  hasScores: boolean;
}

const distinctSorted = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

export function buildModel(analysis: Analysis, population: PopulationName, source: MetricSource): FieldsModel {
  const { schema } = analysis.experiment;
  const scores = analysis.pipelines.map((_, i) => scoresFor(analysis, i, source, population) ?? null);

  const categories: CategoryRow[] = [];
  const fieldsByCategory = new Map<string, FieldRow[]>();
  const fieldByName = new Map<string, FieldRow>();
  let categoryMax = 0;
  let fieldMax = 0;

  for (const category of schema.categories) {
    if (!category.categorical.length) continue;
    const cells: CategoryCell[] = scores.map((s, pipe) => {
      const summary = s?.per_category?.[category.key] ?? null;
      return { pipe, summary, errors: informativeErrors(summary) };
    });
    const row: CategoryRow = {
      category,
      gold: distinctSorted(cells.flatMap((c) => (c.summary ? [goldInformative(c.summary)] : []))),
      cells,
      errors: cells.reduce((sum, c) => sum + c.errors, 0),
    };
    categories.push(row);
    for (const c of cells) categoryMax = Math.max(categoryMax, c.errors);

    const rows: FieldRow[] = [];
    for (const name of category.categorical) {
      const field = schema.byName.get(name);
      if (!field) continue;
      const fcells: FieldCell[] = scores.map((s, pipe) => {
        const score = s?.per_field?.[name] ?? null;
        return { pipe, score, errors: informativeErrors(score) };
      });
      const frow: FieldRow = {
        field,
        category,
        gold: distinctSorted(fcells.flatMap((c) => (c.score ? [goldInformative(c.score)] : []))),
        cells: fcells,
        errors: fcells.reduce((sum, c) => sum + c.errors, 0),
      };
      for (const c of fcells) fieldMax = Math.max(fieldMax, c.errors);
      rows.push(frow);
      fieldByName.set(name, frow);
    }
    fieldsByCategory.set(category.key, rows);
  }

  const text: TextRow[] = schema.textFields.flatMap((name) => {
    const field = schema.byName.get(name);
    if (!field) return [];
    return [{ field, cells: scores.map((s, pipe) => ({ pipe, score: s?.text?.[name] ?? null })) }];
  });

  return {
    population,
    source,
    ids: comparisonIds(analysis, population),
    scores,
    categories,
    fieldsByCategory,
    fieldByName,
    text,
    categoryMax,
    fieldMax,
    hasScores: scores.some(Boolean),
  };
}

/** "28", or "26–28" when pipelines were scored on different records; "—" when unknown. */
export function goldLabel(values: readonly number[], fmt: (n: number) => string = String): string {
  if (!values.length) return '—';
  const lo = values[0]!;
  const hi = values[values.length - 1]!;
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

// ---------------------------------------------------------------------------
// Error ramp bins (mirror palette.errorFill so the legend matches the cells)
// ---------------------------------------------------------------------------

/** Ramp step (0-based) errorFill uses for a count; -1 for zero. */
export function errorStep(count: number, max: number, steps: number): number {
  if (!count) return -1;
  if (max <= steps) return Math.min(steps - 1, count - 1);
  const t = (count - 1) / Math.max(1, max - 1);
  return Math.min(steps - 1, Math.round(t * (steps - 1)));
}

export interface ErrorBin {
  step: number;
  lo: number;
  hi: number;
}

/** Consecutive count ranges that share a ramp step, from 1 to `max`. */
export function errorBins(max: number, steps: number): ErrorBin[] {
  const bins: ErrorBin[] = [];
  for (let c = 1; c <= max; c += 1) {
    const step = errorStep(c, max, steps);
    const last = bins[bins.length - 1];
    if (last && last.step === step) last.hi = c;
    else bins.push({ step, lo: c, hi: c });
  }
  return bins;
}

// ---------------------------------------------------------------------------
// Confusions and the records behind them
// ---------------------------------------------------------------------------

const ARROW = ' -> ';

/** Split a scores.json confusion key "gold -> pred", preferring a split whose gold side is a known value. */
export function splitConfusion(key: string, known: ReadonlySet<string>): [string, string] {
  const first = key.indexOf(ARROW);
  if (first < 0) return [key, ''];
  for (let i = first; i >= 0; i = key.indexOf(ARROW, i + 1)) {
    if (known.has(key.slice(0, i))) return [key.slice(0, i), key.slice(i + ARROW.length)];
  }
  return [key.slice(0, first), key.slice(first + ARROW.length)];
}

export interface ErrorRecord {
  rid: RecordId;
  gold: string;
  pred: string;
  code: number;
}

/** Records of `ids` on which a pipeline's categorical value for `field` is an error. */
export function fieldErrorRecords(analysis: Analysis, pipe: number, field: string, ids: readonly RecordId[]): ErrorRecord[] {
  const { schema, gold } = analysis.experiment;
  const col = schema.categoricalFields.indexOf(field);
  const pa = analysis.pipelines[pipe];
  if (col < 0 || !pa) return [];
  const out: ErrorRecord[] = [];
  for (const rid of ids) {
    const code = pa.outcomes.get(rid)?.[col];
    if (code === undefined || !isError(code)) continue;
    out.push({ rid, gold: cellValue(gold.get(rid), field), pred: cellValue(pa.pipeline.predictions.get(rid), field), code });
  }
  return out;
}

export interface ConfusionGroup {
  gold: string;
  pred: string;
  /** Count reported by the scores in view. */
  count: number;
  records: RecordId[];
}

/**
 * Confusions of a variable in the order the scores list them, each with the
 * records behind it. Errors the scores do not list (only possible when the
 * scores in view cover other records) are appended as their own groups.
 */
export function confusionGroups(confusion: Record<string, number> | undefined, domain: readonly string[], records: readonly ErrorRecord[]): ConfusionGroup[] {
  const known = new Set([...domain, MISSING]);
  const byPair = new Map<string, RecordId[]>();
  for (const r of records) {
    const key = `${r.gold}${ARROW}${r.pred}`;
    const list = byPair.get(key);
    if (list) list.push(r.rid);
    else byPair.set(key, [r.rid]);
  }
  const groups: ConfusionGroup[] = [];
  const seen = new Set<string>();
  for (const [key, count] of Object.entries(confusion ?? {})) {
    const [gold, pred] = splitConfusion(key, known);
    groups.push({ gold, pred, count, records: byPair.get(key) ?? [] });
    seen.add(key);
  }
  for (const [key, rids] of byPair) {
    if (seen.has(key)) continue;
    const [gold, pred] = splitConfusion(key, known);
    groups.push({ gold, pred, count: rids.length, records: rids });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

/** evaluate.py's exact-match normalisation: whitespace collapsed, case-insensitive. */
export const normalizeText = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

export interface TextMismatches {
  /** One side says "Not identified" and the other does not. */
  presence: RecordId[];
  /** The normalised texts differ. */
  text: RecordId[];
}

export function textMismatches(analysis: Analysis, pipe: number, field: string, ids: readonly RecordId[]): TextMismatches {
  const { gold } = analysis.experiment;
  const pa = analysis.pipelines[pipe];
  const out: TextMismatches = { presence: [], text: [] };
  if (!pa) return out;
  for (const rid of ids) {
    const g = cellValue(gold.get(rid), field);
    const p = cellValue(pa.pipeline.predictions.get(rid), field);
    if ((g === TEXT_DEFAULT) !== (p === TEXT_DEFAULT)) out.presence.push(rid);
    if (normalizeText(g) !== normalizeText(p)) out.text.push(rid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Vertical offsets that spread `n` dots within a row of height `rowH` (centred, ≤ 7 px apart). */
export function dotOffsets(n: number, rowH: number): number[] {
  if (n <= 1) return [0];
  const step = Math.min(7, Math.max(2, (rowH - 12) / (n - 1)));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
}

/** Longest prefix of `text` (plus "…") whose measured width fits `max`. */
export function truncateToWidth(text: string, max: number, measure: (s: string) => number): string {
  if (measure(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, Math.max(1, lo)).trimEnd()}…`;
}
