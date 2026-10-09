import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, comparisonIds } from '../src/core/analysis';
import { MISSING, Outcome } from '../src/core/evaluate';
import { loadExperiment } from '../src/core/load';
import { ReportIndex } from '../src/core/snippets';
import { rerootFiles } from '../src/core/vfs';
import type { VirtualFile } from '../src/core/types';
import {
  FILTERS,
  buildSegments,
  countOutcomes,
  describeCounts,
  matchesFilter,
  maxErrors,
  navigableIds,
  nearest,
  neighbor,
  normText,
  parseRecordId,
  recordFacts,
  recordOptionLabel,
  shortNames,
  textDiffers,
} from '../src/views/records/model';

describe('shortNames', () => {
  it('drops the prefix and suffix every name shares, at token boundaries', () => {
    expect(shortNames(['full_pipeline_v4_or', 'full_baseline_v3_or', 'full_pipeline_v3_or'])).toEqual([
      'pipeline_v4',
      'baseline_v3',
      'pipeline_v3',
    ]);
    expect(shortNames(['pipeline_v3', 'pipeline_v4'])).toEqual(['v3', 'v4']);
    expect(shortNames(['run-a', 'run-b'])).toEqual(['a', 'b']);
  });

  it('keeps full names when shortening would be empty, ambiguous or impossible', () => {
    expect(shortNames(['only_one'])).toEqual(['only_one']);
    expect(shortNames(['run', 'run_b'])).toEqual(['run', 'run_b']);
    expect(shortNames(['x_a_x', 'x_x'])).toEqual(['a_x', 'x']);
    // Both would shorten to "a": keep the full names.
    expect(shortNames(['p_a', 'p__a'])).toEqual(['p_a', 'p__a']);
    expect(shortNames(['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });
});

describe('buildSegments', () => {
  it('cuts overlapping spans into non-overlapping covered segments', () => {
    const segs = buildSegments([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 20, end: 25 },
      { start: 3, end: 3 }, // empty: ignored
    ]);
    expect(segs).toEqual([
      { start: 0, end: 5, items: [0] },
      { start: 5, end: 10, items: [0, 1] },
      { start: 10, end: 15, items: [1] },
      { start: 20, end: 25, items: [2] },
    ]);
  });

  it('handles nested, identical and adjacent spans', () => {
    expect(buildSegments([{ start: 0, end: 10 }, { start: 2, end: 4 }])).toEqual([
      { start: 0, end: 2, items: [0] },
      { start: 2, end: 4, items: [0, 1] },
      { start: 4, end: 10, items: [0] },
    ]);
    expect(buildSegments([{ start: 1, end: 3 }, { start: 1, end: 3 }])).toEqual([{ start: 1, end: 3, items: [0, 1] }]);
    expect(buildSegments([{ start: 0, end: 2 }, { start: 2, end: 4 }])).toEqual([
      { start: 0, end: 2, items: [0] },
      { start: 2, end: 4, items: [1] },
    ]);
    expect(buildSegments([])).toEqual([]);
  });
});

describe('navigation helpers', () => {
  const ids = [2, 5, 9, 14];
  it('steps relative to a current id that may be outside the list', () => {
    expect(neighbor(ids, 5, 1)).toBe(9);
    expect(neighbor(ids, 5, -1)).toBe(2);
    expect(neighbor(ids, 14, 1)).toBeNull();
    expect(neighbor(ids, 2, -1)).toBeNull();
    expect(neighbor(ids, 7, 1)).toBe(9);
    expect(neighbor(ids, 7, -1)).toBe(5);
    expect(neighbor(ids, null, 1)).toBe(2);
    expect(neighbor(ids, null, -1)).toBe(14);
    expect(neighbor([], 3, 1)).toBeNull();
  });
  it('lands a new filter at or after the current record', () => {
    expect(nearest(ids, 5)).toBe(5);
    expect(nearest(ids, 6)).toBe(9);
    expect(nearest(ids, 99)).toBe(14);
    expect(nearest(ids, null)).toBe(2);
    expect(nearest([], 1)).toBeNull();
  });
  it('parses record ids from route segments', () => {
    expect(parseRecordId('17')).toBe(17);
    expect(parseRecordId(' 17 ')).toBe(17);
    expect(parseRecordId('-3')).toBe(-3);
    expect(parseRecordId('17a')).toBeNull();
    expect(parseRecordId('')).toBeNull();
    expect(parseRecordId(undefined)).toBeNull();
  });
});

describe('free text and outcomes', () => {
  it('compares free text like evaluate.py (whitespace and case ignored)', () => {
    expect(normText('  Left   OVARY\n')).toBe('left ovary');
    expect(textDiffers('LEFT OVARY', 'left  ovary')).toBe(false);
    expect(textDiffers('LEFT OVARY', 'RIGHT OVARY')).toBe(true);
    expect(textDiffers(MISSING, 'x')).toBe(false);
  });

  it('counts and describes error outcomes', () => {
    const codes = Uint8Array.from([Outcome.TN, Outcome.FN, Outcome.FP, Outcome.TP, Outcome.FPFN, Outcome.FN]);
    expect(countOutcomes(codes)).toEqual({ errors: 4, fn: 2, fp: 1, fpfn: 1 });
    expect(countOutcomes(codes, [0, 1, 3])).toEqual({ errors: 1, fn: 1, fp: 0, fpfn: 0 });
    expect(countOutcomes(undefined)).toEqual({ errors: 0, fn: 0, fp: 0, fpfn: 0 });
    expect(describeCounts({ errors: 2, fn: 1, fp: 1, fpfn: 0 })).toBe('2 errors (FN 1, FP 1)');
    expect(describeCounts({ errors: 0, fn: 0, fp: 0, fpfn: 0 })).toBe('no errors');
  });

  it('labels records in the selector', () => {
    const facts = { errors: Int32Array.from([2, 0, -1]), copies: 1 };
    expect(recordOptionLabel(17, facts, [0])).toBe('#17 · 2 errors');
    expect(recordOptionLabel(17, facts, [0, 1, 2])).toBe('#17 · 2 errors (2, 0, –)');
    expect(recordOptionLabel(17, facts, [1])).toBe('#17 · no errors');
    expect(recordOptionLabel(17, facts, [2])).toBe('#17 · not scored');
    expect(recordOptionLabel(17, undefined, [0])).toBe('#17');
  });
});

// ------------------------------------------------------------------ example

const EXAMPLE = join(__dirname, '..', 'examples', 'experiment_1');
const hasExample = existsSync(EXAMPLE);

function readTree(dir: string, base = dir): VirtualFile[] {
  const out: VirtualFile[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readTree(full, base));
    else out.push({ path: ['experiment_1', ...relative(base, full).split(sep)].join('/'), blob: new Blob([readFileSync(full)]) });
  }
  return out;
}

describe.skipIf(!hasExample)('records view on examples/experiment_1', () => {
  it('filters partition the navigable records consistently', async () => {
    const experiment = await loadExperiment(rerootFiles(readTree(EXAMPLE), 'experiment_1'));
    const analysis = analyze(experiment);
    const facts = recordFacts(analysis);
    const shown = analysis.pipelines.map((_, i) => i);
    expect(maxErrors(facts)).toBeGreaterThan(0);

    for (const population of ['unique', 'all'] as const) {
      const ids = navigableIds(analysis, population);
      expect(ids).toEqual([...(population === 'unique' ? comparisonIds(analysis, 'unique') : experiment.goldIds)].sort((a, b) => a - b));
      const count = (key: (typeof FILTERS)[number]['key']) => ids.filter((rid) => matchesFilter(analysis, facts.get(rid), key, rid, shown)).length;
      expect(count('all')).toBe(ids.length);
      // Every record every pipeline was scored on is either error-free or has errors.
      expect(count('errors') + count('clean')).toBe(ids.length);
      // Records with errors in some pipeline but not all are records where pipelines disagree.
      for (const rid of ids) {
        const f = facts.get(rid)!;
        const some = shown.some((i) => f.errors[i]! > 0);
        const all = shown.every((i) => f.errors[i]! > 0);
        if (some && !all) expect(matchesFilter(analysis, f, 'disagree', rid, shown)).toBe(true);
      }
      expect(count('dups')).toBe(ids.filter((rid) => (experiment.groupOf.get(rid)?.length ?? 1) > 1).length);
    }
    // A single shown pipeline never "disagrees".
    expect(experiment.goldIds.some((rid) => matchesFilter(analysis, facts.get(rid), 'disagree', rid, [0]))).toBe(false);
  });

  it('builds clean highlight segments for every record and source', async () => {
    const experiment = await loadExperiment(rerootFiles(readTree(EXAMPLE), 'experiment_1'));
    const { schema } = experiment;
    const t0 = performance.now();
    let records = 0;
    for (const rid of experiment.goldIds) {
      const text = experiment.reports.get(rid);
      if (text === undefined) continue;
      const index = new ReportIndex(text);
      const sources = [experiment.gold.get(rid), ...experiment.pipelines.map((p) => p.predictions.get(rid))];
      for (const record of sources) {
        const spans = schema.textFields.flatMap((f) => {
          const v = record?.[f];
          return typeof v === 'string' ? index.locate(v).matches : [];
        });
        const segs = buildSegments(spans);
        for (let k = 0; k < segs.length; k += 1) {
          const s = segs[k]!;
          expect(s.end).toBeGreaterThan(s.start);
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeLessThanOrEqual(text.length);
          if (k) expect(s.start).toBeGreaterThanOrEqual(segs[k - 1]!.end);
          for (const i of s.items) expect(spans[i]!.start <= s.start && spans[i]!.end >= s.end).toBe(true);
        }
        // Segments cover exactly the union of the matched spans.
        const covered = new Set<number>();
        for (const m of spans) for (let x = m.start; x < m.end; x += 1) covered.add(x);
        expect(segs.reduce((n, s) => n + s.end - s.start, 0)).toBe(covered.size);
      }
      records += 1;
    }
    expect(records).toBeGreaterThan(0);
    // Locating every source on every record stays far below a frame per record.
    expect((performance.now() - t0) / records).toBeLessThan(16);
  });
});
