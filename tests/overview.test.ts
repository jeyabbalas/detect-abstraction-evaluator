import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, getBootstrap, type Analysis } from '../src/core/analysis';
import type { PairInterval } from '../src/core/bootstrap';
import { loadExperiment } from '../src/core/load';
import type { Pipeline, RunMeta, VirtualFile } from '../src/core/types';
import { rerootFiles } from '../src/core/vfs';
import {
  axisDomain,
  bestIndices,
  buildSnapshot,
  experimentNotes,
  flattenLeaves,
  formatConfigValue,
  leaderboardCsv,
  orientPair,
  pairRows,
  placeLabels,
  rankRows,
  runConfigRows,
  toCsv,
  type PipelineRow,
} from '../src/views/overview/model';

const row = (pos: number, f1: number | null): PipelineRow =>
  ({ pos, summary: f1 === null ? null : { informative_f1: f1 } }) as unknown as PipelineRow;

describe('ranking and best values', () => {
  it('sorts by informative F1, ties share a rank, missing values last', () => {
    const { order, rank } = rankRows([row(0, 0.9), row(1, null), row(2, 0.95), row(3, 0.9)]);
    expect(order.map((r) => r.pos)).toEqual([2, 0, 3, 1]);
    expect(rank).toEqual([2, null, 1, 2]);
  });

  it('marks every cell that shows the best value, never when all agree or alone', () => {
    const three = (v: number) => v.toFixed(3);
    expect([...bestIndices([0.9951, 0.9949, 0.98], 'max', three)]).toEqual([0, 1]);
    expect([...bestIndices([0.9951, 0.9949, 0.98], 'max')]).toEqual([0]);
    expect([...bestIndices([12, 50, 112], 'min')]).toEqual([0]);
    expect([...bestIndices([3_452_339, 3_469_693, 4_350_768], 'min', (v) => `${(v / 1e6).toFixed(1)}M`)]).toEqual([0, 1]);
    expect(bestIndices([0.5, 0.5], 'max').size).toBe(0);
    expect(bestIndices([0.9951, 0.9949], 'max', three).size).toBe(0);
    expect(bestIndices([0.5, null, undefined], 'max').size).toBe(0);
  });
});

describe('pairwise orientation', () => {
  const iv = (estimate: number, lo: number, hi: number, pBetter: number): PairInterval => ({ estimate, lo, hi, pBetter });

  it('keeps a non-negative difference as is', () => {
    expect(orientPair(0, 1, iv(0.02, 0.005, 0.03, 0.99))).toEqual({ a: 0, b: 1, estimate: 0.02, lo: 0.005, hi: 0.03, pBetter: 0.99, excludesZero: true });
  });

  it('swaps a negative difference and mirrors its interval', () => {
    const p = orientPair(0, 1, iv(-0.004, -0.011, 0.003, 0.2));
    expect(p).toMatchObject({ a: 1, b: 0, estimate: 0.004, lo: -0.003, hi: 0.011, excludesZero: false });
    expect(p.pBetter).toBeCloseTo(0.8, 12);
  });

  it('lists every pair, largest difference first', () => {
    const rec = (estimate: number) => ({ informative_f1: iv(estimate, estimate - 0.01, estimate + 0.01, 0.5) });
    const boot = {
      B: 10,
      seed: 1,
      n: 5,
      intervals: [{}, {}, {}],
      pairs: new Map([
        ['0:1', rec(0.01)],
        ['0:2', rec(-0.05)],
        ['1:2', rec(0.02)],
      ]),
    } as never;
    expect(pairRows(boot, 'informative_f1').map((p) => [p.a, p.b])).toEqual([
      [2, 0],
      [1, 2],
      [0, 1],
    ]);
  });
});

describe('axis domains', () => {
  it('zooms to the data, stays inside [0, 1] and picks tick decimals', () => {
    const ax = axisDomain([0.953, 0.927, 0.973, 0.995, 0.999], { clamp: [0, 1], count: 5 });
    expect(ax.domain[0]).toBeGreaterThan(0.85);
    expect(ax.domain[0]).toBeLessThanOrEqual(0.927);
    expect(ax.domain[1]).toBe(1);
    expect(ax.ticks.every((t) => t >= ax.domain[0] && t <= ax.domain[1])).toBe(true);
    expect(ax.decimals).toBeGreaterThanOrEqual(2);
  });

  it('widens a degenerate range and keeps it in bounds', () => {
    const ax = axisDomain([1, 1, null], { clamp: [0, 1] });
    expect(ax.domain[1]).toBe(1);
    expect(ax.domain[0]).toBeLessThan(1);
    expect(axisDomain([], { clamp: [0, 1] }).domain).toEqual([0, 1]);
  });

  it('includes zero for differences', () => {
    const ax = axisDomain([0.02, 0.03], { include: [0] });
    expect(ax.domain[0]).toBeLessThanOrEqual(0);
  });
});

describe('run configuration', () => {
  const pipeline = (name: string, run: RunMeta | null): Pipeline =>
    ({ id: name, name, index: 0, run, predictions: new Map(), reportedScores: null, scoresText: null, traceFiles: new Map(), ids: [1, 2, 3] }) as Pipeline;

  it('flattens leaves with dotted keys; arrays and empty objects are leaves', () => {
    const flat = flattenLeaves({ a: 1, b: { c: [1, 2], d: { e: null } }, f: {} });
    expect([...flat]).toEqual([
      ['a', 1],
      ['b.c', [1, 2]],
      ['b.d.e', null],
      ['f', {}],
    ]);
  });

  it('groups rows, lists differing rows first and ignores pipelines without run.json', () => {
    const rows = runConfigRows([
      pipeline('a', { strategy: 'x', ids: [1, 2], settings: { model: 'm', extra_body: { top_p: 0.9 } }, usage: { calls: 3 } }),
      pipeline('b', { strategy: 'y', ids: [1, 2], settings: { model: 'm', extra_body: { top_p: 0.9 }, seed: 7 }, usage: { calls: 3 } }),
      pipeline('c', null),
    ]);
    const key = (g: string) => rows.filter((r) => r.group === g).map((r) => `${r.key}${r.differs ? '*' : ''}`);
    expect(key('pipeline')).toEqual(['strategy*', 'records run']);
    expect(key('settings')).toEqual(['seed*', 'model', 'extra_body.top_p']);
    expect(key('usage')).toEqual(['calls']);
    expect(rows.find((r) => r.key === 'records run')!.values).toEqual([2, 2, undefined]);
  });

  it('formats values for reading', () => {
    expect(formatConfigValue('wall_seconds', 3725.5)).toMatchObject({ text: '1h 02m', kind: 'duration' });
    expect(formatConfigValue('prompt_tokens', 1234567).text).toBe('1,234,567');
    expect(formatConfigValue('seed', 20241009).text).toBe('20241009');
    expect(formatConfigValue('top_p', 0.95).text).toBe('0.95');
    expect(formatConfigValue('max_tokens', null)).toMatchObject({ text: 'null', kind: 'null' });
    expect(formatConfigValue('quantizations', ['fp8'])).toMatchObject({ text: '["fp8"]', kind: 'code' });
    expect(formatConfigValue('x', undefined).kind).toBe('missing');
  });
});

describe('direct labels', () => {
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
  const overlaps = (a: number[], b: number[]) => a[0]! < b[2]! && b[0]! < a[2]! && a[1]! < b[3]! && b[1]! < a[3]!;
  const box = (p: { x: number; y: number; w: number }, c: { textAnchor: string; dx: number; dy: number }) => {
    const x = p.x + c.dx;
    const x0 = c.textAnchor === 'start' ? x : c.textAnchor === 'end' ? x - p.w : x - p.w / 2;
    return [x0, p.y + c.dy - 7, x0 + p.w, p.y + c.dy + 7];
  };

  it('keeps labels inside the frame and apart from each other', () => {
    const pts = [
      { x: 390, y: 20, w: 120 },
      { x: 385, y: 30, w: 120 },
      { x: 200, y: 150, w: 80 },
    ];
    const placed = placeLabels(pts, bounds, { h: 14 });
    const boxes = pts.map((p, i) => box(p, placed[i]!));
    for (const b of boxes) {
      expect(b[0]).toBeGreaterThanOrEqual(0);
      expect(b[2]).toBeLessThanOrEqual(400);
    }
    expect(overlaps(boxes[0]!, boxes[1]!)).toBe(false);
    expect(placed[2]).toMatchObject({ textAnchor: 'start' }); // free space: the default (right) spot
  });
});

describe('csv', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(toCsv([['a', 'b,c'], ['say "hi"', 'x\ny'], [null, 1.5]])).toBe('a,"b,c"\n"say ""hi""","x\ny"\n,1.5');
  });
});

describe('experiment notes', () => {
  it('folds the loader’s missing-prediction warning into the per-pipeline line', () => {
    const pa = (name: string, missing: number[], invalid = 0, schema = 0) => ({
      pipeline: { name },
      missing,
      invalid: Array.from({ length: invalid }, () => ({})),
      schemaIssues: new Map(Array.from({ length: schema }, (_, i) => [i, []])),
    });
    const analysis = {
      experiment: {
        issues: [
          { level: 'info', message: 'abstractions/b/ has no scores.json.', pipeline: 'b' },
          { level: 'warning', message: 'a: 2 record(s) have no prediction (e.g. 4, 9); they are scored as wrong.', pipeline: 'a' },
          { level: 'warning', message: 'gold_standard/ holds 2 JSON files.' },
        ],
      },
      pipelines: [pa('a', [4, 9]), pa('b', [], 1, 3)],
      validatorError: null,
      goldSchemaIssues: new Map(),
    } as unknown as Analysis;
    const notes = experimentNotes(analysis);
    expect(notes.map((n) => [n.level, n.pos ?? null])).toEqual([
      ['warning', null],
      ['warning', 0],
      ['warning', 1],
      ['info', null],
    ]);
    expect(notes[1]!.message).toContain('2 records without a prediction (e.g. 4, 9)');
    expect(notes[2]!.message).toBe('1 value outside the allowed values, scored as wrong · 3 records failing JSON Schema validation');
  });
});

const EXAMPLE = join(__dirname, '..', 'examples', 'experiment_1');

function readTree(dir: string, base = dir): VirtualFile[] {
  const out: VirtualFile[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readTree(full, base));
    else out.push({ path: ['experiment_1', ...relative(base, full).split(sep)].join('/'), blob: new Blob([readFileSync(full)]) });
  }
  return out;
}

describe.skipIf(!existsSync(EXAMPLE))('overview on examples/experiment_1', () => {
  it('builds consistent rows, ranks and a full-precision CSV', async () => {
    const analysis = analyze(await loadExperiment(rerootFiles(readTree(EXAMPLE), 'experiment_1')));
    const snap = buildSnapshot(analysis, analysis.defaultSource, 'unique');
    expect(snap.n).toBe(analysis.experiment.uniqueIds.length);
    expect(snap.order).toHaveLength(analysis.pipelines.length);
    const f1 = snap.order.map((r) => r.summary!.informative_f1!);
    expect([...f1].sort((a, b) => b - a)).toEqual(f1);
    expect(snap.rank[snap.order[0]!.pos]).toBe(1);
    for (const r of snap.rows) {
      expect(r.errorFreeCount).toBeLessThanOrEqual(r.n);
      expect(r.errorFree! * r.n).toBeCloseTo(r.errorFreeCount, 9);
    }
    const boot = await getBootstrap(analysis, 'unique');
    for (const r of snap.rows) {
      // Error-free rate agrees with the bootstrap's point estimate on the same records.
      expect(boot!.intervals[r.pos]!.error_free_rate.estimate).toBeCloseTo(r.errorFree!, 12);
    }
    const csv = leaderboardCsv(snap, boot).split('\n');
    expect(csv).toHaveLength(analysis.pipelines.length + 1);
    expect(csv[0]!.split(',')).toHaveLength(csv[1]!.split(',').length);
  });
});
