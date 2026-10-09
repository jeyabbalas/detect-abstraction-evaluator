/**
 * Pure helpers for the records view (no DOM): per-record facts and filters,
 * short pipeline names, highlight segments and neighbor navigation.
 */

import { comparisonIds, type Analysis } from '../../core/analysis';
import { MISSING, Outcome, cellValue } from '../../core/evaluate';
import type { PopulationName, RecordId } from '../../core/types';
import { plural } from '../../ui/format';

// ------------------------------------------------------------ pipeline names

const SEPARATOR = /[_\-\s.:/]/;
const EDGE_SEPARATORS = /^[_\-\s.:/]+|[_\-\s.:/]+$/g;

/**
 * Short, distinct display names: the prefix and suffix every name shares are
 * dropped at token boundaries (`full_pipeline_v4_or`, `full_baseline_v3_or` →
 * `pipeline_v4`, `baseline_v3`). Falls back to the full names when that would
 * leave an empty or ambiguous name.
 */
export function shortNames(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const first = names[0]!;
  let pre = 0;
  while (pre < first.length && names.every((n) => n[pre] === first[pre])) pre += 1;
  while (pre > 0 && !SEPARATOR.test(first[pre - 1]!)) pre -= 1;
  const fromEnd = (n: string, k: number) => n[n.length - 1 - k];
  let suf = 0;
  while (names.every((n) => n.length - suf > pre && fromEnd(n, suf) === fromEnd(first, suf))) suf += 1;
  while (suf > 0 && !SEPARATOR.test(first[first.length - suf]!)) suf -= 1;
  const out = names.map((n) => n.slice(pre, n.length - suf).replace(EDGE_SEPARATORS, ''));
  if (out.some((n) => !n) || new Set(out).size !== out.length) return [...names];
  return out;
}

// ------------------------------------------------------------ record facts

export interface RecordFacts {
  /** Categorical errors per pipeline (analysis order); −1 when the pipeline was not scored on the record. */
  errors: Int32Array;
  /** Size of the record's identical-text group (1 = its text is unique). */
  copies: number;
}

export function recordFacts(analysis: Analysis): Map<RecordId, RecordFacts> {
  const { experiment, pipelines } = analysis;
  const out = new Map<RecordId, RecordFacts>();
  for (const rid of experiment.goldIds) {
    const errors = new Int32Array(pipelines.length);
    pipelines.forEach((pa, i) => {
      errors[i] = pa.errorCount.get(rid) ?? -1;
    });
    out.set(rid, { errors, copies: experiment.groupOf.get(rid)?.length ?? 1 });
  }
  return out;
}

/** Largest error count of any pipeline on any record (at least 1). */
export function maxErrors(facts: Map<RecordId, RecordFacts>): number {
  let max = 1;
  for (const f of facts.values()) for (const e of f.errors) if (e > max) max = e;
  return max;
}

/** The records that can be stepped through under a population. */
export function navigableIds(analysis: Analysis, population: PopulationName): RecordId[] {
  const ids = population === 'unique' ? comparisonIds(analysis, 'unique') : [...analysis.experiment.goldIds];
  return ids.sort((a, b) => a - b);
}

// ------------------------------------------------------------------ filters

export type FilterKey = 'all' | 'errors' | 'disagree' | 'clean' | 'dups';

export const FILTERS: readonly { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All records' },
  { key: 'errors', label: 'With errors' },
  { key: 'disagree', label: 'Pipelines disagree' },
  { key: 'clean', label: 'Error-free' },
  { key: 'dups', label: 'Duplicated texts' },
];

/** True when the shown pipelines scored on `rid` predict different values for some categorical variable. */
export function pipelinesDisagree(analysis: Analysis, rid: RecordId, shown: readonly number[]): boolean {
  const scored = shown.filter((i) => analysis.pipelines[i]!.errorCount.has(rid));
  if (scored.length < 2) return false;
  const records = scored.map((i) => analysis.pipelines[i]!.pipeline.predictions.get(rid));
  for (const field of analysis.experiment.schema.categoricalFields) {
    const first = cellValue(records[0], field);
    for (let k = 1; k < records.length; k += 1) if (cellValue(records[k], field) !== first) return true;
  }
  return false;
}

export function matchesFilter(
  analysis: Analysis,
  facts: RecordFacts | undefined,
  filter: FilterKey,
  rid: RecordId,
  shown: readonly number[],
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'dups':
      return (facts?.copies ?? 1) > 1;
    case 'errors':
      return !!facts && shown.some((i) => facts.errors[i]! > 0);
    case 'clean': {
      if (!facts) return false;
      let scored = false;
      for (const i of shown) {
        const e = facts.errors[i]!;
        if (e > 0) return false;
        if (e === 0) scored = true;
      }
      return scored;
    }
    case 'disagree':
      return pipelinesDisagree(analysis, rid, shown);
  }
}

// ----------------------------------------------------------------- outcomes

export interface OutcomeCounts {
  errors: number;
  fn: number;
  fp: number;
  fpfn: number;
}

/** Error counts over outcome codes (all of them, or only the positions in `indices`). */
export function countOutcomes(codes: ArrayLike<number> | undefined, indices?: readonly number[]): OutcomeCounts {
  const c: OutcomeCounts = { errors: 0, fn: 0, fp: 0, fpfn: 0 };
  if (!codes) return c;
  const n = indices ? indices.length : codes.length;
  for (let k = 0; k < n; k += 1) {
    const o = codes[indices ? indices[k]! : k];
    if (o === Outcome.FN) c.fn += 1;
    else if (o === Outcome.FP) c.fp += 1;
    else if (o === Outcome.FPFN) c.fpfn += 1;
    else continue;
    c.errors += 1;
  }
  return c;
}

/** "2 errors (FN 1, FP 1)" or "no errors". */
export function describeCounts(c: OutcomeCounts): string {
  if (!c.errors) return 'no errors';
  const parts = [c.fn && `FN ${c.fn}`, c.fp && `FP ${c.fp}`, c.fpfn && `FP+FN ${c.fpfn}`].filter(Boolean);
  return `${plural(c.errors, 'error')} (${parts.join(', ')})`;
}

/** Record selector label: "#17 · 5 errors (2, 0, 3)" — errors summed over the shown pipelines. */
export function recordOptionLabel(rid: RecordId, facts: RecordFacts | undefined, shown: readonly number[]): string {
  if (!facts) return `#${rid}`;
  const per = shown.map((i) => facts.errors[i]!);
  const scored = per.filter((e) => e >= 0);
  if (!scored.length) return `#${rid} · not scored`;
  const total = scored.reduce((a, b) => a + b, 0);
  if (!total) return `#${rid} · no errors`;
  const head = `#${rid} · ${plural(total, 'error')}`;
  return per.length > 1 ? `${head} (${per.map((e) => (e < 0 ? '–' : String(e))).join(', ')})` : head;
}

// --------------------------------------------------------------- free text

/** Whitespace-collapsed, lower-cased text (how evaluate.py compares free text). */
export function normText(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

/** A pipeline's free-text value differs from gold (both present; whitespace and case ignored). */
export function textDiffers(gold: string, pred: string): boolean {
  if (gold === MISSING || pred === MISSING) return false;
  return normText(gold) !== normText(pred);
}

// ----------------------------------------------------------------- segments

export interface Span {
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
  /** Indices of the spans that cover this segment. */
  items: number[];
}

/**
 * Non-overlapping segments from possibly overlapping spans: every span
 * boundary is a cut, and each covered piece lists the spans covering it.
 * Uncovered gaps are omitted; empty spans are ignored.
 */
export function buildSegments(spans: readonly Span[]): Segment[] {
  const cuts = new Set<number>();
  for (const s of spans) {
    if (s.end > s.start) {
      cuts.add(s.start);
      cuts.add(s.end);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k + 1 < points.length; k += 1) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const items: number[] = [];
    spans.forEach((s, i) => {
      if (s.end > s.start && s.start <= a && s.end >= b) items.push(i);
    });
    if (items.length) out.push({ start: a, end: b, items });
  }
  return out;
}

// --------------------------------------------------------------- navigation

/**
 * The next (dir 1) or previous (dir −1) id in an ascending list, relative to
 * `current` — which need not be in the list. With no current record, the
 * first (or last) id.
 */
export function neighbor(ids: readonly RecordId[], current: RecordId | null, dir: 1 | -1): RecordId | null {
  if (!ids.length) return null;
  if (current === null) return dir > 0 ? ids[0]! : ids[ids.length - 1]!;
  if (dir > 0) {
    for (const id of ids) if (id > current) return id;
    return null;
  }
  for (let k = ids.length - 1; k >= 0; k -= 1) if (ids[k]! < current) return ids[k]!;
  return null;
}

/** The id at or after `current` (else the last one before it) — where a new filter should land. */
export function nearest(ids: readonly RecordId[], current: RecordId | null): RecordId | null {
  if (!ids.length) return null;
  if (current === null) return ids[0]!;
  for (const id of ids) if (id >= current) return id;
  return ids[ids.length - 1]!;
}

/** Parse a record id from a route segment. */
export function parseRecordId(raw: string | undefined): RecordId | null {
  if (raw === undefined || !/^\s*-?\d+\s*$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}
