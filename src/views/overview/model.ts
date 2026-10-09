/**
 * Pure data helpers for the overview: per-pipeline rows, ranking, axis
 * domains, pairwise orientation, run-configuration flattening, label
 * placement and CSV. No DOM access, so everything here is unit-tested.
 */

import { nice, tickStep, ticks } from 'd3';
import { comparisonIds, duplicateConsistencyFor, scoresFor, type Analysis, type MetricSource } from '../../core/analysis';
import type { BootstrapResult, MetricKey, PairInterval } from '../../core/bootstrap';
import type { DuplicateConsistency, IssueLevel, Pipeline, PopulationName, ScoreSummary } from '../../core/types';
import { fmtDuration, fmtInt, plural } from '../../ui/format';
import { errorFreeRate, runCost, type RunCost } from '../shared';

/** The six headline metrics, in display order. */
export const HEADLINE_METRICS: readonly MetricKey[] = [
  'informative_f1',
  'informative_precision',
  'informative_recall',
  'mean_field_macro_f1',
  'cell_accuracy',
  'error_free_rate',
];

// ------------------------------------------------------------------- rows

export interface PipelineRow {
  /** Position in `analysis.pipelines` (also the bootstrap index). */
  pos: number;
  pipeline: Pipeline;
  summary: ScoreSummary | null;
  /** Records behind `summary`. */
  records: number;
  /** Share of comparison records with no categorical error. */
  errorFree: number | null;
  errorFreeCount: number;
  /** Size of the comparison population (records every pipeline was run on). */
  n: number;
  dup: DuplicateConsistency | null;
  cost: RunCost;
}

export interface Snapshot {
  population: PopulationName;
  source: MetricSource;
  /** Whether every pipeline was run on the same records. */
  sameIds: boolean;
  /** By pipeline position. */
  rows: PipelineRow[];
  /** Leaderboard order (informative F1, best first). */
  order: PipelineRow[];
  /** Competition rank by pipeline position (ties share a rank); null without an F1. */
  rank: (number | null)[];
  n: number;
}

export function buildSnapshot(analysis: Analysis, source: MetricSource, population: PopulationName): Snapshot {
  const ids = comparisonIds(analysis, population);
  const rows: PipelineRow[] = analysis.pipelines.map((pa, pos) => {
    const scores = scoresFor(analysis, pos, source, population);
    const errorFree = errorFreeRate(pa, ids);
    return {
      pos,
      pipeline: pa.pipeline,
      summary: scores?.summary ?? null,
      records: scores?.records ?? 0,
      errorFree,
      errorFreeCount: errorFree === null ? 0 : Math.round(errorFree * ids.length),
      n: ids.length,
      dup: duplicateConsistencyFor(analysis, pos, source),
      cost: runCost(pa.pipeline),
    };
  });
  const { order, rank } = rankRows(rows);
  return { population, source, sameIds: analysis.sameIds, rows, order, rank, n: ids.length };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A headline metric's value from the displayed scores (error-free from the outcomes). */
export function metricValue(row: PipelineRow, key: MetricKey): number | null {
  if (key === 'error_free_rate') return row.errorFree;
  const v = row.summary?.[key];
  return finite(v) ? v : null;
}

/** Point estimate: the displayed score, else the bootstrap estimate. */
export function pointEstimate(row: PipelineRow, key: MetricKey, boot: BootstrapResult | null): number | null {
  return metricValue(row, key) ?? boot?.intervals[row.pos]?.[key]?.estimate ?? null;
}

/** Sort by informative F1 (best first, missing last); ties share a competition rank. */
export function rankRows(rows: readonly PipelineRow[]): { order: PipelineRow[]; rank: (number | null)[] } {
  const f1 = (r: PipelineRow) => metricValue(r, 'informative_f1');
  const order = [...rows].sort((a, b) => {
    const fa = f1(a);
    const fb = f1(b);
    if (fa === null || fb === null) return fa === fb ? a.pos - b.pos : fa === null ? 1 : -1;
    return fb - fa || a.pos - b.pos;
  });
  const rank = rows.map((r) => {
    const v = f1(r);
    if (v === null) return null;
    return 1 + rows.filter((o) => {
      const w = f1(o);
      return w !== null && w > v;
    }).length;
  });
  return { order, rank };
}

/**
 * Indices of the cells that show the best value: the best raw value decides,
 * and every value that displays the same (`format`) is marked with it. Empty
 * when fewer than two values exist or when they all display alike.
 */
export function bestIndices(
  values: readonly (number | null | undefined)[],
  dir: 'max' | 'min',
  format: (v: number) => string = String,
): Set<number> {
  const present: [number, number][] = [];
  values.forEach((v, i) => {
    if (finite(v)) present.push([i, v]);
  });
  if (present.length < 2) return new Set();
  const raw = present.map(([, v]) => v);
  const shown = format(dir === 'max' ? Math.max(...raw) : Math.min(...raw));
  if (present.every(([, v]) => format(v) === shown)) return new Set();
  return new Set(present.filter(([, v]) => format(v) === shown).map(([i]) => i));
}

// ------------------------------------------------------------------- axes

export interface AxisSpec {
  domain: [number, number];
  ticks: number[];
  /** Decimals that show every tick distinctly. */
  decimals: number;
}

/**
 * A tight, nice domain around the values (dot and interval plots need no
 * zero baseline). Kept inside `clamp` (e.g. [0, 1] for proportions).
 */
export function axisDomain(
  values: readonly (number | null | undefined)[],
  opts: { count?: number; minSpan?: number; pad?: number; clamp?: [number, number]; include?: number[] } = {},
): AxisSpec {
  const count = Math.max(2, opts.count ?? 4);
  const minSpan = opts.minSpan ?? 0.02;
  const vals = [...values, ...(opts.include ?? [])].filter(finite);
  let lo: number;
  let hi: number;
  if (!vals.length) [lo, hi] = opts.clamp ?? [0, 1];
  else {
    lo = Math.min(...vals);
    hi = Math.max(...vals);
    if (hi - lo < minSpan) {
      const mid = (lo + hi) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const pad = (hi - lo) * (opts.pad ?? 0.06);
    lo -= pad;
    hi += pad;
  }
  const clamp = opts.clamp;
  if (clamp) {
    // Shift (rather than cut) a window that pokes out of the allowed range.
    if (hi > clamp[1]) {
      lo -= hi - clamp[1];
      hi = clamp[1];
    }
    if (lo < clamp[0]) {
      hi = Math.min(clamp[1], hi + (clamp[0] - lo));
      lo = clamp[0];
    }
  }
  [lo, hi] = nice(lo, hi, count);
  if (clamp) {
    lo = Math.max(clamp[0], lo);
    hi = Math.min(clamp[1], hi);
  }
  const step = tickStep(lo, hi, count);
  return {
    domain: [lo, hi],
    ticks: ticks(lo, hi, count),
    decimals: step > 0 ? Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)) : 0,
  };
}

/** Plot height shared by the error profile and the cost scatter (they sit side by side). */
export function sharedHeight(pipelines: number): number {
  return Math.max(250, Math.min(440, pipelines * 44 + 120));
}

/** A readable unit for durations on an axis. */
export function durationUnit(maxSeconds: number): { div: number; label: string } {
  if (maxSeconds >= 3 * 3600) return { div: 3600, label: 'hours' };
  if (maxSeconds >= 180) return { div: 60, label: 'minutes' };
  return { div: 1, label: 'seconds' };
}

// ------------------------------------------------------------------ costs

export type CostKey = 'tokens' | 'calls' | 'wall' | 'thinking';

export const COST_META: Record<CostKey, { label: string; short: string; title: string; value: (c: RunCost) => number | null }> = {
  tokens: { label: 'Total tokens', short: 'Tokens', title: 'Total tokens (prompt + output)', value: (c) => c.totalTokens },
  calls: { label: 'LLM calls', short: 'Calls', title: 'LLM calls', value: (c) => c.calls },
  wall: { label: 'Wall-clock time', short: 'Time', title: 'Wall-clock time of the run', value: (c) => c.wallSeconds },
  thinking: { label: 'Thinking tokens', short: 'Thinking', title: 'Thinking (reasoning) tokens', value: (c) => c.thoughtTokens },
};

/** Cost measures at least one pipeline reports, in menu order. */
export function availableCosts(costs: readonly RunCost[]): CostKey[] {
  return (Object.keys(COST_META) as CostKey[]).filter((k) => costs.some((c) => finite(COST_META[k].value(c))));
}

// ------------------------------------------------------------------ pairs

export interface PairRow {
  /** The pipeline ahead on the point estimate (position). */
  a: number;
  b: number;
  /** a − b (≥ 0 unless null). */
  estimate: number | null;
  lo: number | null;
  hi: number | null;
  /** Share of replicates in which `a` beats `b`. */
  pBetter: number | null;
  excludesZero: boolean;
}

const negate = (x: number | null): number | null => (x === null ? null : x === 0 ? 0 : -x);

/** Orient pair `i:j` (i − j) so the point estimate is not negative. */
export function orientPair(i: number, j: number, iv: PairInterval): PairRow {
  const swap = iv.estimate !== null && iv.estimate < 0;
  const base = swap
    ? { a: j, b: i, estimate: negate(iv.estimate), lo: negate(iv.hi), hi: negate(iv.lo), pBetter: iv.pBetter === null ? null : 1 - iv.pBetter }
    : { a: i, b: j, estimate: iv.estimate, lo: iv.lo, hi: iv.hi, pBetter: iv.pBetter };
  return { ...base, excludesZero: base.lo !== null && base.hi !== null && (base.lo > 0 || base.hi < 0) };
}

/** Every pair for a metric, largest difference first. */
export function pairRows(boot: BootstrapResult, metric: MetricKey): PairRow[] {
  const out: PairRow[] = [];
  const P = boot.intervals.length;
  for (let i = 0; i < P; i += 1) {
    for (let j = i + 1; j < P; j += 1) {
      const iv = boot.pairs.get(`${i}:${j}`)?.[metric];
      if (iv) out.push(orientPair(i, j, iv));
    }
  }
  return out.sort((x, y) => (y.estimate ?? -1) - (x.estimate ?? -1) || x.a - y.a || x.b - y.b);
}

// --------------------------------------------------------- run configuration

export type ConfigGroup = 'pipeline' | 'settings' | 'usage';

export const CONFIG_GROUPS: { key: ConfigGroup; label: string }[] = [
  { key: 'pipeline', label: 'Run' },
  { key: 'settings', label: 'Settings' },
  { key: 'usage', label: 'Usage' },
];

export interface ConfigRow {
  group: ConfigGroup;
  key: string;
  /** One value per pipeline; undefined = absent (or no run.json). */
  values: unknown[];
  differs: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every leaf of a JSON value as dotted paths (arrays and empty objects are leaves). */
export function flattenLeaves(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length && prefix) out.set(prefix, value);
    for (const [k, v] of entries) flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.set(prefix, value);
  return out;
}

const RUN_FIRST = ['strategy', 'records run', 'wall_seconds', 'failures'];

function flattenRun(p: Pipeline): Record<ConfigGroup, Map<string, unknown>> {
  const out: Record<ConfigGroup, Map<string, unknown>> = { pipeline: new Map(), settings: new Map(), usage: new Map() };
  const run = p.run ?? {};
  out.pipeline.set('records run', Array.isArray(run.ids) ? run.ids.length : p.ids.length);
  for (const [k, v] of Object.entries(run)) {
    if (k === 'ids') continue;
    if (k === 'settings' && isRecord(v)) flattenLeaves(v, '', out.settings);
    else if (k === 'usage' && isRecord(v)) flattenLeaves(v, '', out.usage);
    else if (k === 'failures' && isRecord(v)) out.pipeline.set('failures', Object.keys(v).length);
    else flattenLeaves(v, k, out.pipeline);
  }
  return out;
}

/** JSON with sorted keys, so equal values compare equal. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return '\u0000undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? String(v);
}

/**
 * Rows of the run-configuration table: run.json leaves per pipeline, grouped,
 * with rows that differ across pipelines first within each group. Pipelines
 * without a run.json neither contribute keys nor count as differing.
 */
export function runConfigRows(pipelines: readonly Pipeline[]): ConfigRow[] {
  const flat = pipelines.map((p) => (p.run ? flattenRun(p) : null));
  const rows: ConfigRow[] = [];
  for (const { key: group } of CONFIG_GROUPS) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const f of flat) {
      if (!f) continue;
      for (const k of f[group].keys()) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
    if (group === 'pipeline') {
      keys.sort((a, b) => {
        const ia = RUN_FIRST.indexOf(a);
        const ib = RUN_FIRST.indexOf(b);
        return (ia < 0 ? RUN_FIRST.length : ia) - (ib < 0 ? RUN_FIRST.length : ib);
      });
    }
    const groupRows = keys.map((key) => {
      const values = flat.map((f) => f?.[group].get(key));
      const compared = values.filter((_, i) => flat[i] !== null).map(stableStringify);
      return { group, key, values, differs: compared.length > 1 && new Set(compared).size > 1 };
    });
    // Stable: differing rows first, otherwise in first-seen order.
    rows.push(...groupRows.filter((r) => r.differs), ...groupRows.filter((r) => !r.differs));
  }
  return rows;
}

export interface ConfigValue {
  text: string;
  kind: 'missing' | 'null' | 'number' | 'duration' | 'text' | 'code';
  /** Exact value when the text is rounded or reformatted. */
  title?: string;
}

export function formatConfigValue(key: string, v: unknown): ConfigValue {
  if (v === undefined) return { text: '—', kind: 'missing' };
  if (v === null) return { text: 'null', kind: 'null' };
  if (typeof v === 'number') {
    if (/seconds/i.test(key) && Number.isFinite(v)) return { text: fmtDuration(v), kind: 'duration', title: `${v} s` };
    if (Number.isInteger(v)) return { text: Math.abs(v) >= 1000 && !/seed/i.test(key) ? fmtInt(v) : String(v), kind: 'number' };
    const short = String(Number(v.toPrecision(6)));
    return { text: short, kind: 'number', title: short === String(v) ? undefined : String(v) };
  }
  if (typeof v === 'string') return { text: v, kind: 'text' };
  if (typeof v === 'boolean') return { text: String(v), kind: 'code' };
  return { text: JSON.stringify(v), kind: 'code' };
}

// ------------------------------------------------------------------ notes

export interface Note {
  level: IssueLevel;
  message: string;
  /** Pipeline position the note is about (shown with its swatch). */
  pos?: number;
}

/**
 * Things a reader should know before trusting the numbers: load issues,
 * predictions without a value / outside the domain / failing the schema.
 * Errors and warnings first, infos last.
 */
export function experimentNotes(analysis: Analysis): Note[] {
  const perPipeline: Note[] = [];
  const foldedMissing = new Set<string>();
  analysis.pipelines.forEach((pa, pos) => {
    const parts: string[] = [];
    if (pa.missing.length) {
      const eg = pa.missing.slice(0, 5).join(', ');
      parts.push(`${plural(pa.missing.length, 'record')} without a prediction (e.g. ${eg}), scored as wrong`);
      foldedMissing.add(pa.pipeline.name);
    }
    if (pa.invalid.length) parts.push(`${plural(pa.invalid.length, 'value')} outside the allowed values, scored as wrong`);
    const schemaFailures = pa.schemaIssues?.size ?? 0;
    if (schemaFailures) parts.push(`${plural(schemaFailures, 'record')} failing JSON Schema validation`);
    if (parts.length) perPipeline.push({ level: 'warning', message: parts.join(' · '), pos });
  });

  // The loader's "no prediction" warning is folded into the per-pipeline line above.
  const issues = analysis.experiment.issues.filter(
    (issue) => !(issue.pipeline !== undefined && foldedMissing.has(issue.pipeline) && /no prediction/i.test(issue.message)),
  );
  const byLevel = (level: IssueLevel): Note[] => issues.filter((i) => i.level === level).map((i) => ({ level, message: i.message }));

  const checks: Note[] = [];
  if (analysis.validatorError) {
    checks.push({ level: 'warning', message: `JSON Schema validation is unavailable, so schema checks were skipped: ${analysis.validatorError}` });
  }
  const goldFailures = analysis.goldSchemaIssues?.size ?? 0;
  if (goldFailures) {
    checks.push({ level: 'warning', message: `${plural(goldFailures, 'gold-standard record')} ${goldFailures === 1 ? 'fails' : 'fail'} JSON Schema validation.` });
  }
  return [...byLevel('error'), ...byLevel('warning'), ...perPipeline, ...checks, ...byLevel('info')];
}

// ----------------------------------------------------------- label layout

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabelPoint {
  x: number;
  y: number;
  /** Label width in px. */
  w: number;
}

export interface LabelPlacement {
  textAnchor: 'start' | 'end' | 'middle';
  dx: number;
  dy: number;
}

const area = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

function outside(b: Box, bounds: Box): number {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return w * h - area(b, bounds);
}

function labelBox(p: LabelPoint, c: LabelPlacement, h: number): Box {
  const x = p.x + c.dx;
  const x0 = c.textAnchor === 'start' ? x : c.textAnchor === 'end' ? x - p.w : x - p.w / 2;
  const y = p.y + c.dy;
  return { x0, x1: x0 + p.w, y0: y - h / 2, y1: y + h / 2 };
}

/**
 * Greedy direct-label placement for a scatter: each label tries right, left,
 * above, below and the diagonals of its dot, taking the first spot that stays
 * inside `bounds` and clears other labels, dots and `obstacles` (e.g. error
 * bars). Falls back to the least-overlapping spot. Most constrained points
 * are placed first.
 */
export function placeLabels(
  points: readonly LabelPoint[],
  bounds: Box,
  opts: { r?: number; h?: number; gap?: number; obstacles?: readonly Box[] } = {},
): LabelPlacement[] {
  const r = opts.r ?? 5;
  const h = opts.h ?? 14;
  const gap = opts.gap ?? 6;
  const side = r + gap;
  const vert = r + gap / 2 + h / 2;
  const candidates: LabelPlacement[] = [
    { textAnchor: 'start', dx: side, dy: 0 },
    { textAnchor: 'end', dx: -side, dy: 0 },
    { textAnchor: 'middle', dx: 0, dy: -vert },
    { textAnchor: 'middle', dx: 0, dy: vert },
    { textAnchor: 'start', dx: r, dy: -(r + h / 2) },
    { textAnchor: 'start', dx: r, dy: r + h / 2 },
    { textAnchor: 'end', dx: -r, dy: -(r + h / 2) },
    { textAnchor: 'end', dx: -r, dy: r + h / 2 },
  ];
  const dots: Box[] = points.map((p) => ({ x0: p.x - r - 1, x1: p.x + r + 1, y0: p.y - r - 1, y1: p.y + r + 1 }));
  const obstacles = opts.obstacles ?? [];
  const freeSpots = (i: number) =>
    candidates.filter((c) => {
      const b = labelBox(points[i]!, c, h);
      return outside(b, bounds) === 0 && dots.every((d, j) => j === i || area(b, d) === 0);
    }).length;
  const order = points.map((_, i) => i).sort((a, b) => freeSpots(a) - freeSpots(b) || a - b);

  const placed: Box[] = [];
  const result: LabelPlacement[] = new Array(points.length);
  for (const i of order) {
    const p = points[i]!;
    let best = candidates[0]!;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const b = labelBox(p, c, h);
      let score = outside(b, bounds) * 1000;
      for (const q of placed) score += area(b, q) * 100;
      dots.forEach((d, j) => {
        if (j !== i) score += area(b, d) * 50;
      });
      for (const o of obstacles) score += area(b, o) * 10;
      if (score < bestScore) {
        bestScore = score;
        best = c;
        if (score === 0) break;
      }
    }
    placed.push(labelBox(p, best, h));
    result[i] = best;
  }
  return result;
}

// -------------------------------------------------------------------- CSV

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

/** The leaderboard as a tidy CSV (full precision; one row per pipeline). */
export function leaderboardCsv(snap: Snapshot, boot: BootstrapResult | null): string {
  const header = [
    'rank',
    'pipeline',
    'strategy',
    'model',
    'population',
    'metric_source',
    'records',
    'informative_f1',
    'informative_f1_ci_low',
    'informative_f1_ci_high',
    'informative_precision',
    'informative_recall',
    'mean_field_macro_f1',
    'cell_accuracy',
    'error_free_rate',
    'error_free_records',
    'comparison_records',
    'tp',
    'fp',
    'fn',
    'cells_with_error',
    'cells',
    'duplicate_agreement',
    'llm_calls',
    'cached_calls',
    'prompt_tokens',
    'output_tokens',
    'thinking_tokens',
    'total_tokens',
    'wall_seconds',
  ];
  const lines = snap.order.map((r) => {
    const s = r.summary;
    const ci = boot?.intervals[r.pos]?.informative_f1;
    return [
      snap.rank[r.pos],
      r.pipeline.name,
      r.cost.strategy,
      r.cost.model,
      snap.population,
      snap.source,
      r.records,
      s?.informative_f1,
      ci?.lo,
      ci?.hi,
      s?.informative_precision,
      s?.informative_recall,
      s?.mean_field_macro_f1,
      s?.cell_accuracy,
      r.errorFree,
      r.errorFreeCount,
      r.n,
      s?.tp,
      s?.fp,
      s?.fn,
      s?.errors,
      s?.cells,
      r.dup?.agreement,
      r.cost.calls,
      r.cost.cachedCalls,
      r.cost.promptTokens,
      r.cost.outputTokens,
      r.cost.thoughtTokens,
      r.cost.totalTokens,
      r.cost.wallSeconds,
    ];
  });
  return toCsv([header, ...lines]);
}
