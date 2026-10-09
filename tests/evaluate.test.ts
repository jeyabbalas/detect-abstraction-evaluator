import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, getBootstrap } from '../src/core/analysis';
import { f1Triple, pySum } from '../src/core/evaluate';
import { loadExperiment } from '../src/core/load';
import { ReportIndex, splitSnippets } from '../src/core/snippets';
import { rerootFiles } from '../src/core/vfs';
import type { VirtualFile } from '../src/core/types';

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

describe('python-compatible primitives', () => {
  it('sums floats like CPython 3.12+', () => {
    expect(pySum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(pySum([1e16, 1, -1e16])).toBe(1);
  });
  it('matches _f1 edge cases', () => {
    expect(f1Triple(0, 0, 0)).toEqual([null, null, null]);
    expect(f1Triple(0, 0, 3)).toEqual([0, 0, 0]);
    expect(f1Triple(2, 0, 0)).toEqual([1, 1, 1]);
  });
});

describe('snippet locator', () => {
  it('finds verbatim snippets across whitespace runs and constructed forms', () => {
    const report = 'A. UTERUS,   CERVIX:\n - ENDOMETRIOID   ADENOCARCINOMA.  B. LEFT OVARY: SEROUS CYST';
    const idx = new ReportIndex(report);
    const located = idx.locate('UTERUS, CERVIX || ENDOMETRIOID ADENOCARCINOMA || LEFT OVARY :: SEROUS CYST');
    expect(located.unlocated).toEqual([]);
    expect(located.matches.map((m) => report.slice(m.start, m.end))).toEqual([
      'UTERUS,   CERVIX',
      'ENDOMETRIOID   ADENOCARCINOMA',
      'LEFT OVARY',
      'SEROUS CYST',
    ]);
    expect(splitSnippets('Not identified')).toEqual([]);
  });
});

describe.skipIf(!hasExample)('examples/experiment_1', () => {
  it('re-roots, loads and reproduces every scores.json exactly', async () => {
    const set = rerootFiles(readTree(EXAMPLE), 'experiment_1');
    expect(set.name).toBe('experiment_1');
    const experiment = await loadExperiment(set);
    expect(experiment.schema.categoricalFields).toHaveLength(58);
    expect(experiment.schema.textFields).toHaveLength(14);
    expect(experiment.uniqueIds).toHaveLength(101);
    expect(experiment.pipelines.length).toBeGreaterThan(0);

    const analysis = analyze(experiment);
    expect(analysis.validatorError).toBeNull();
    for (const pa of analysis.pipelines) {
      expect(pa.differences, pa.pipeline.name).toEqual([]);
      expect(pa.invalid).toEqual([]);
      expect(pa.schemaIssues?.size ?? 0).toBe(0);
    }
    expect(analysis.allReportedMatch).toBe(true);
    expect(analysis.defaultSource).toBe('reported');

    const t0 = performance.now();
    const boot = await getBootstrap(analysis, 'unique');
    const ms = performance.now() - t0;
    expect(boot).not.toBeNull();
    const f1 = boot!.intervals[0]!.informative_f1;
    const reported = experiment.pipelines[0]!.reportedScores!.unique!.summary.informative_f1!;
    expect(f1.estimate!).toBeCloseTo(reported, 12);
    expect(f1.lo!).toBeLessThanOrEqual(reported);
    expect(f1.hi!).toBeGreaterThanOrEqual(reported);
    console.log(`bootstrap (B=${boot!.B}, n=${boot!.n}, ${analysis.pipelines.length} pipelines): ${ms.toFixed(0)} ms`);
  });
});
