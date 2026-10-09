/**
 * Nonparametric bootstrap over records (the unit of sampling: cells within a
 * report are correlated, so records — not cells — are resampled).
 *
 * For every replicate the same resampled records are used for all pipelines,
 * which gives paired confidence intervals for between-pipeline differences.
 * Seeded, so the intervals are reproducible.
 */

export const METRICS = [
  'informative_f1',
  'informative_precision',
  'informative_recall',
  'mean_field_macro_f1',
  'cell_accuracy',
  'error_free_rate',
] as const;
export type MetricKey = (typeof METRICS)[number];

/** Per-pipeline inputs over one fixed list of records (same order for every pipeline). */
export interface BootstrapInput {
  /** Per record: informative TP / FP / FN counts and correct cells. */
  tp: Int32Array;
  fp: Int32Array;
  fn: Int32Array;
  correct: Int32Array;
  /** Per categorical field: label index of gold and prediction per record. */
  fields: { gold: Uint16Array; pred: Uint16Array; nLabels: number }[];
}

export interface Interval {
  estimate: number | null;
  lo: number | null;
  hi: number | null;
}

export interface PairInterval extends Interval {
  /** Share of replicates in which the first pipeline beats the second. */
  pBetter: number | null;
}

export interface BootstrapResult {
  B: number;
  seed: number;
  n: number;
  /** pipeline index → metric → interval */
  intervals: Record<MetricKey, Interval>[];
  /** `${i}:${j}` (i < j) → metric → interval of (pipeline i − pipeline j) */
  pairs: Map<string, Record<MetricKey, PairInterval>>;
}

/** Small, fast, seedable PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile with linear interpolation (numpy's default), ignoring NaN. */
export function quantile(sorted: Float64Array | number[], q: number): number | null {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

function f1(tp: number, fp: number, fn: number): number {
  const p = tp + fp ? tp / (tp + fp) : null;
  const r = tp + fn ? tp / (tp + fn) : null;
  if (p === null && r === null) return Number.NaN;
  if (!p || !r) return 0;
  return (2 * p * r) / (p + r);
}

/** Metrics for one weighting of the records (weights = multiplicity in the replicate). */
function metricsFor(
  input: BootstrapInput,
  idx: Int32Array,
  w: Int32Array,
  m: number,
  scratch: { tp: Float64Array; fp: Float64Array; fn: Float64Array },
  out: Float64Array,
): void {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  let total = 0;
  let errorFree = 0;
  const nFields = input.fields.length;
  for (let k = 0; k < m; k += 1) {
    const r = idx[k]!;
    const wt = w[k]!;
    tp += wt * input.tp[r]!;
    fp += wt * input.fp[r]!;
    fn += wt * input.fn[r]!;
    correct += wt * input.correct[r]!;
    total += wt;
    if (input.correct[r] === nFields) errorFree += wt;
  }
  const p = tp + fp ? tp / (tp + fp) : Number.NaN;
  const rc = tp + fn ? tp / (tp + fn) : Number.NaN;
  out[0] = f1(tp, fp, fn);
  out[1] = Number.isNaN(p) && !Number.isNaN(rc) ? 0 : p;
  out[2] = Number.isNaN(rc) && !Number.isNaN(p) ? 0 : rc;

  let macroSum = 0;
  for (const field of input.fields) {
    const L = field.nLabels;
    const ltp = scratch.tp;
    const lfp = scratch.fp;
    const lfn = scratch.fn;
    ltp.fill(0, 0, L);
    lfp.fill(0, 0, L);
    lfn.fill(0, 0, L);
    for (let k = 0; k < m; k += 1) {
      const r = idx[k]!;
      const wt = w[k]!;
      const g = field.gold[r]!;
      const pr = field.pred[r]!;
      if (g === pr) ltp[g]! += wt;
      else {
        lfp[pr]! += wt;
        lfn[g]! += wt;
      }
    }
    let sum = 0;
    let present = 0;
    for (let l = 0; l < L; l += 1) {
      const a = ltp[l]!;
      const b = lfp[l]!;
      const c = lfn[l]!;
      if (a + b + c === 0) continue;
      present += 1;
      if (a === 0) continue; // precision or recall is 0 → F1 0
      const pp = a / (a + b);
      const rr = a / (a + c);
      sum += (2 * pp * rr) / (pp + rr);
    }
    macroSum += present ? sum / present : 0;
  }
  out[3] = nFields ? macroSum / nFields : Number.NaN;
  out[4] = total ? correct / (total * nFields) : Number.NaN;
  out[5] = total ? errorFree / total : Number.NaN;
}

function interval(values: Float64Array, estimate: number): Interval {
  const finite = Array.from(values).filter((v) => Number.isFinite(v));
  finite.sort((a, b) => a - b);
  return {
    estimate: Number.isFinite(estimate) ? estimate : null,
    lo: quantile(finite, 0.025),
    hi: quantile(finite, 0.975),
  };
}

export function runBootstrap(inputs: BootstrapInput[], n: number, B = 2000, seed = 20241009): BootstrapResult {
  const P = inputs.length;
  const K = METRICS.length;
  const maxLabels = Math.max(1, ...inputs.flatMap((i) => i.fields.map((f) => f.nLabels)));
  const scratch = { tp: new Float64Array(maxLabels), fp: new Float64Array(maxLabels), fn: new Float64Array(maxLabels) };

  // Point estimates (every record once).
  const allIdx = Int32Array.from({ length: n }, (_, i) => i);
  const ones = new Int32Array(n).fill(1);
  const estimates = inputs.map((input) => {
    const out = new Float64Array(K);
    metricsFor(input, allIdx, ones, n, scratch, out);
    return out;
  });

  // reps[p][k * B + b]
  const reps = inputs.map(() => new Float64Array(K * B));
  const rand = mulberry32(seed);
  const counts = new Int32Array(n);
  const idx = new Int32Array(n);
  const w = new Int32Array(n);
  const out = new Float64Array(K);
  for (let b = 0; b < B; b += 1) {
    counts.fill(0);
    for (let i = 0; i < n; i += 1) counts[Math.floor(rand() * n)]! += 1;
    let m = 0;
    for (let r = 0; r < n; r += 1) {
      if (counts[r]) {
        idx[m] = r;
        w[m] = counts[r]!;
        m += 1;
      }
    }
    for (let p = 0; p < P; p += 1) {
      metricsFor(inputs[p]!, idx, w, m, scratch, out);
      for (let k = 0; k < K; k += 1) reps[p]![k * B + b] = out[k]!;
    }
  }

  const intervals = inputs.map((_, p) => {
    const rec = {} as Record<MetricKey, Interval>;
    METRICS.forEach((metric, k) => {
      rec[metric] = interval(reps[p]!.subarray(k * B, (k + 1) * B), estimates[p]![k]!);
    });
    return rec;
  });

  const pairs = new Map<string, Record<MetricKey, PairInterval>>();
  for (let i = 0; i < P; i += 1) {
    for (let j = i + 1; j < P; j += 1) {
      const rec = {} as Record<MetricKey, PairInterval>;
      METRICS.forEach((metric, k) => {
        const d = new Float64Array(B);
        let better = 0;
        let valid = 0;
        for (let b = 0; b < B; b += 1) {
          const v = reps[i]![k * B + b]! - reps[j]![k * B + b]!;
          d[b] = v;
          if (Number.isFinite(v)) {
            valid += 1;
            if (v > 0) better += 1;
          }
        }
        const base = interval(d, estimates[i]![k]! - estimates[j]![k]!);
        rec[metric] = { ...base, pBetter: valid ? better / valid : null };
      });
      pairs.set(`${i}:${j}`, rec);
    }
  }
  return { B, seed, n, intervals, pairs };
}
