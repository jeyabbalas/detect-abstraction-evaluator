/**
 * Faithful port of the abstraction code's `evaluate.py`.
 *
 * Scope: the categorical fields. Free-text fields are excluded from the
 * headline metrics and reported only as diagnostics.
 *
 * Population: each distinct report text is scored once, using the lowest
 * record_id of its identical-text group ("unique"); all records are a
 * secondary, duplicate-weighted view ("all").
 *
 * Informative micro metrics (per cell):
 *   TP  prediction equals gold and gold is not the default label
 *   FP  prediction is wrong and is not the default label
 *   FN  prediction is wrong and gold is not the default label
 * A wrong non-default prediction against a non-default gold value is both an
 * FP and an FN. The secondary metric is the mean over fields of each field's
 * macro F1 across the labels present in gold or prediction. Missing or invalid
 * predictions are scored as wrong, never dropped.
 */

import type {
  AbstractionRecord,
  DuplicateConsistency,
  FieldScore,
  LabelScore,
  PopulationName,
  PopulationScores,
  RecordId,
  SchemaModel,
  ScoreSummary,
  Scores,
  TextScore,
} from './types';

export const MISSING = '<missing>';

/** Cell outcome codes (per record × categorical field). */
export const Outcome = {
  /** Correct, gold is the default label (agreement on "nothing to report"). */
  TN: 0,
  /** Correct and informative. */
  TP: 1,
  /** Wrong; predicted an informative label where gold is the default (over-call). */
  FP: 2,
  /** Wrong; predicted the default label where gold is informative (miss). */
  FN: 3,
  /** Wrong; both informative but different (counts as one FP and one FN). */
  FPFN: 4,
} as const;
export type OutcomeCode = (typeof Outcome)[keyof typeof Outcome];

export const isError = (o: number): boolean => o >= Outcome.FP;

/**
 * Python's built-in `sum()` over floats (CPython ≥ 3.12 uses Neumaier
 * compensated summation). Reproduces scores.json to the last bit.
 */
export function pySum(values: Iterable<number>): number {
  let s = 0;
  let c = 0;
  for (const x of values) {
    const t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += s - t + x;
    else c += x - t + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

/** Python `_f1`: precision/recall are null only when both denominators are empty. */
export function f1Triple(tp: number, fp: number, fn: number): [number | null, number | null, number | null] {
  const p = tp + fp ? tp / (tp + fp) : null;
  const r = tp + fn ? tp / (tp + fn) : null;
  if (p === null && r === null) return [p, r, null];
  if (!p || !r) return [p || 0, r || 0, 0];
  return [p, r, (2 * p * r) / (p + r)];
}

/** Python's default string ordering (by code point). */
export const pyCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Normalized cell value: strings as-is; null/absent → MISSING; anything else as JSON. */
export function cellValue(record: AbstractionRecord | undefined, field: string): string {
  if (!record) return MISSING;
  const v = record[field];
  if (v === undefined || v === null) return MISSING;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Outcome of one categorical cell. */
export function outcomeOf(gold: string, pred: string, defaultLabel: string | null): OutcomeCode {
  if (pred === gold) return gold !== defaultLabel ? Outcome.TP : Outcome.TN;
  const fp = pred !== defaultLabel;
  const fn = gold !== defaultLabel;
  if (fp && fn) return Outcome.FPFN;
  return fp ? Outcome.FP : Outcome.FN;
}

type RecordMap = Map<RecordId, AbstractionRecord>;

export function fieldScores(
  gold: RecordMap,
  pred: RecordMap,
  ids: readonly RecordId[],
  field: string,
  defaultLabel: string | null,
): FieldScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  const pairs: [string, string][] = [];
  for (const rid of ids) {
    const g = cellValue(gold.get(rid), field);
    const p = cellValue(pred.get(rid), field);
    pairs.push([g, p]);
    if (p === g) {
      correct += 1;
      if (g !== defaultLabel) tp += 1;
    } else {
      if (p !== defaultLabel) fp += 1;
      if (g !== defaultLabel) fn += 1;
    }
  }
  const labels = [...new Set(pairs.flat())].sort(pyCompare);
  const perLabel: Record<string, LabelScore> = {};
  for (const label of labels) {
    let ltp = 0;
    let lfp = 0;
    let lfn = 0;
    for (const [g, p] of pairs) {
      if (g === label && p === label) ltp += 1;
      else if (p === label) lfp += 1;
      else if (g === label) lfn += 1;
    }
    perLabel[label] = { support: ltp + lfn, f1: f1Triple(ltp, lfp, lfn)[2] || 0 };
  }
  const macro = pySum(Object.values(perLabel).map((v) => v.f1)) / labels.length;
  const [precision, recall, f1] = f1Triple(tp, fp, fn);
  const confusion: Record<string, number> = {};
  for (const [g, p] of pairs) {
    if (g !== p) {
      const key = `${g} -> ${p}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
    }
  }
  return {
    n: ids.length,
    accuracy: correct / ids.length,
    macro_f1: macro,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    per_label: perLabel,
    confusion: sortConfusion(confusion),
  };
}

/** Order like Python's Counter.most_common(): by count desc, then first-seen order. */
function sortConfusion(c: Record<string, number>): Record<string, number> {
  const entries = Object.entries(c);
  const order = new Map(entries.map(([k], i) => [k, i]));
  entries.sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!);
  return Object.fromEntries(entries);
}

export function summarize(perField: readonly FieldScore[]): ScoreSummary {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let cells = 0;
  for (const s of perField) {
    tp += s.tp;
    fp += s.fp;
    fn += s.fn;
    cells += s.n;
  }
  const [precision, recall, f1] = f1Triple(tp, fp, fn);
  const correct = pySum(perField.map((s) => s.accuracy * s.n));
  return {
    informative_precision: precision,
    informative_recall: recall,
    informative_f1: f1,
    tp,
    fp,
    fn,
    mean_field_macro_f1: pySum(perField.map((s) => s.macro_f1)) / perField.length,
    cell_accuracy: correct / cells,
    cells,
    errors: cells - Math.round(correct),
  };
}

const collapse = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ');

export function textDiagnostics(
  gold: RecordMap,
  pred: RecordMap,
  ids: readonly RecordId[],
  textFields: readonly string[],
): Record<string, TextScore> {
  const result: Record<string, TextScore> = {};
  for (const field of textFields) {
    let presence = 0;
    let exact = 0;
    for (const rid of ids) {
      const g = cellValue(gold.get(rid), field);
      const p = cellValue(pred.get(rid), field);
      if ((g === 'Not identified') === (p === 'Not identified')) presence += 1;
      if (collapse(g).toLowerCase() === collapse(p).toLowerCase()) exact += 1;
    }
    result[field] = { presence_agreement: presence / ids.length, exact_match: exact / ids.length };
  }
  return result;
}

/** Share of categorical cells on which every copy of a duplicated text agrees. */
export function duplicateConsistency(
  pred: RecordMap,
  groups: readonly RecordId[][],
  fields: readonly string[],
): DuplicateConsistency {
  let agree = 0;
  let total = 0;
  const unstable = new Map<string, number>();
  for (const group of groups) {
    if (group.length < 2 || !group.every((rid) => pred.has(rid))) continue;
    for (const field of fields) {
      const values = new Set(group.map((rid) => cellValue(pred.get(rid), field)));
      total += 1;
      if (values.size === 1) agree += 1;
      else unstable.set(field, (unstable.get(field) ?? 0) + 1);
    }
  }
  const order = new Map([...unstable.keys()].map((k, i) => [k, i]));
  const sorted = [...unstable.entries()].sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!);
  return { agreement: total ? agree / total : null, cells: total, unstable_fields: Object.fromEntries(sorted) };
}

export interface EvaluationContext {
  schema: SchemaModel;
  gold: RecordMap;
  goldIds: readonly RecordId[];
  uniqueIds: readonly RecordId[];
  duplicateGroups: readonly RecordId[][];
}

/** Record ids of a population, optionally restricted to `ids` (both sorted ascending). */
export function populationIds(ctx: EvaluationContext, name: PopulationName, ids?: Iterable<RecordId> | null): RecordId[] {
  const base = (name === 'unique' ? ctx.uniqueIds : ctx.goldIds).filter((rid) => ctx.gold.has(rid));
  if (!ids) return [...base];
  const keep = ids instanceof Set ? (ids as Set<RecordId>) : new Set(ids);
  return base.filter((rid) => keep.has(rid));
}

export function scorePopulation(ctx: EvaluationContext, pred: RecordMap, population: readonly RecordId[]): PopulationScores {
  const { schema } = ctx;
  const perField: Record<string, FieldScore> = {};
  for (const name of schema.categoricalFields) {
    perField[name] = fieldScores(ctx.gold, pred, population, name, schema.byName.get(name)!.defaultLabel);
  }
  const perCategory: Record<string, ScoreSummary> = {};
  for (const cat of schema.categories) {
    const subset = cat.categorical.filter((f) => f in perField).map((f) => perField[f]!);
    if (subset.length) perCategory[cat.key] = summarize(subset);
  }
  return {
    records: population.length,
    summary: summarize(Object.values(perField)),
    per_category: perCategory,
    per_field: perField,
    text: textDiagnostics(ctx.gold, pred, population, schema.textFields),
  };
}

/** Python `evaluate(pred, ids=...)`: both populations plus duplicate consistency. */
export function evaluate(ctx: EvaluationContext, pred: RecordMap, ids?: Iterable<RecordId> | null): Scores {
  const keep = ids ? new Set(ids) : null;
  const result: Scores = {};
  for (const name of ['unique', 'all'] as const) {
    const population = populationIds(ctx, name, keep);
    if (population.length) result[name] = scorePopulation(ctx, pred, population);
  }
  result.duplicate_consistency = duplicateConsistency(pred, ctx.duplicateGroups, ctx.schema.categoricalFields);
  return result;
}

// ---------------------------------------------------------------------------
// Comparing recomputed scores with a reported scores.json
// ---------------------------------------------------------------------------

export interface ScoreDifference {
  path: string;
  reported: unknown;
  computed: unknown;
}

const TOLERANCE = 1e-9;

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a));
  return a === b;
}

/** Differences between reported and recomputed scores (summary, categories, fields, text). */
export function compareScores(reported: Scores, computed: Scores, limit = 50): ScoreDifference[] {
  const diffs: ScoreDifference[] = [];
  const push = (path: string, r: unknown, c: unknown) => {
    if (diffs.length < limit && !sameValue(r, c)) diffs.push({ path, reported: r, computed: c });
  };
  for (const pop of ['unique', 'all'] as const) {
    const r = reported[pop];
    const c = computed[pop];
    if (!r && !c) continue;
    if (!r || !c) {
      diffs.push({ path: pop, reported: r ? 'present' : 'absent', computed: c ? 'present' : 'absent' });
      continue;
    }
    push(`${pop}.records`, r.records, c.records);
    for (const [k, v] of Object.entries(r.summary ?? {})) push(`${pop}.summary.${k}`, v, (c.summary as unknown as Record<string, unknown>)[k]);
    for (const [cat, rs] of Object.entries(r.per_category ?? {})) {
      const cs = c.per_category[cat] as unknown as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(rs)) push(`${pop}.per_category.${cat}.${k}`, v, cs?.[k]);
    }
    for (const [field, rf] of Object.entries(r.per_field ?? {})) {
      const cf = c.per_field[field];
      if (!cf) {
        push(`${pop}.per_field.${field}`, 'present', 'absent');
        continue;
      }
      for (const k of ['n', 'accuracy', 'macro_f1', 'tp', 'fp', 'fn', 'precision', 'recall', 'f1'] as const) {
        push(`${pop}.per_field.${field}.${k}`, rf[k], cf[k]);
      }
    }
    for (const [field, rt] of Object.entries(r.text ?? {})) {
      const ct = c.text[field];
      push(`${pop}.text.${field}.presence_agreement`, rt.presence_agreement, ct?.presence_agreement);
      push(`${pop}.text.${field}.exact_match`, rt.exact_match, ct?.exact_match);
    }
  }
  const rd = reported.duplicate_consistency;
  const cd = computed.duplicate_consistency;
  if (rd && cd) {
    push('duplicate_consistency.agreement', rd.agreement, cd.agreement);
    push('duplicate_consistency.cells', rd.cells, cd.cells);
  }
  return diffs;
}
