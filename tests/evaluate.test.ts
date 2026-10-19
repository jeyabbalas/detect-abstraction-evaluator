import { beforeAll, describe, expect, it } from 'vitest';
import { analyze, getBootstrap } from '../src/core/analysis';
import { cellValue, f1Triple, isError, pySum } from '../src/core/evaluate';
import { readRecordFile, withGoldStandard } from '../src/core/load';
import { ReportIndex, splitSnippets } from '../src/core/snippets';
import type { AbstractionRecord, Experiment } from '../src/core/types';
import { createValidator } from '../src/core/validate';
import { rerootFiles } from '../src/core/vfs';
import { EXAMPLE_NAME, hasExample, loadExample, readTree } from './helpers';

describe('numeric primitives', () => {
  it('sums floats with compensation', () => {
    expect(pySum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(pySum([1e16, 1, -1e16])).toBe(1);
  });
  it('handles F1 edge cases', () => {
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

describe.skipIf(!hasExample)(`examples/${EXAMPLE_NAME}`, () => {
  let experiment: Experiment;
  beforeAll(async () => {
    experiment = await loadExample();
  });

  it('re-roots and loads the schema, the runs and their record files', async () => {
    expect(rerootFiles(readTree(), EXAMPLE_NAME).name).toBe(EXAMPLE_NAME);
    const { schema } = experiment;
    expect(schema.categoricalFields).toHaveLength(58);
    expect(schema.textFields).toHaveLength(14);
    expect(schema.ruleCount).toBe(12);
    // Categories are the progressive stages; `residual` lists only fields `benign` already codes.
    expect(schema.categories.map((c) => c.key)).toEqual(['specimens', 'neoplasia', 'origin', 'precursors', 'secondary', 'uterine', 'adnexal', 'benign']);
    expect(schema.dictionary.categories.map((c) => c.id)).toEqual(schema.categories.map((c) => c.key));
    expect(schema.dictionary.categories.reduce((n, c) => n + c.rows.length, 0)).toBe(schema.fields.length + 1);
    expect(experiment.uniqueIds).toHaveLength(101);
    expect(experiment.issues.filter((i) => i.level !== 'info')).toEqual([]);
    expect(experiment.pipelines.length).toBeGreaterThan(0);
    for (const p of experiment.pipelines) {
      expect(p.config?.schema_sha256, p.name).toBe(experiment.schemaSha256);
      expect(p.recordFiles.size).toBe(p.summary!.records);
      expect(p.ids).toHaveLength(p.summary!.records!);
      expect(p.notes.size).toBe(Object.keys(p.summary!.issues ?? {}).length);
      const rid = p.ids[0]!;
      const file = await readRecordFile(p, rid);
      expect(file?.record).toEqual(p.predictions.get(rid));
    }
  });

  it('scores every pipeline; predictions satisfy the schema, as each run reports', async () => {
    const analysis = analyze(experiment);
    expect(analysis.validatorError).toBeNull();
    expect(analysis.sameIds).toBe(true);
    expect(analysis.goldSchemaIssues?.size).toBe(0);
    for (const pa of analysis.pipelines) {
      expect(pa.invalid).toEqual([]);
      expect(pa.missing).toEqual([]);
      expect(pa.schemaIssues?.size ?? 0, pa.pipeline.name).toBe(pa.pipeline.summary?.records_with?.schema_errors ?? 0);
      expect(pa.scores.unique!.summary.cells).toBe(101 * 58);
      expect(pa.scores.all!.summary.cells).toBe(128 * 58);
    }

    const t0 = performance.now();
    const boot = await getBootstrap(analysis, 'unique');
    const ms = performance.now() - t0;
    expect(boot).not.toBeNull();
    const f1 = boot!.intervals[0]!.informative_f1;
    const point = analysis.pipelines[0]!.scores.unique!.summary.informative_f1!;
    expect(f1.estimate!).toBeCloseTo(point, 12);
    expect(f1.lo!).toBeLessThanOrEqual(point);
    expect(f1.hi!).toBeGreaterThanOrEqual(point);
    console.log(`bootstrap (B=${boot!.B}, n=${boot!.n}, ${analysis.pipelines.length} pipelines): ${ms.toFixed(0)} ms`);
  });

  it('re-scores against another gold standard, and back', async () => {
    const gold = JSON.parse(await experiment.goldFiles[0]!.blob.text()) as AbstractionRecord[];
    // Half the records, one value changed.
    const half = gold.slice(0, 64).map((r) => ({ ...r }));
    const changed = half[0]!;
    changed.Hysterectomy = changed.Hysterectomy === 'Yes' ? 'No' : 'Yes';
    const next = await withGoldStandard(experiment, { name: experiment.goldFileName, blob: new Blob([JSON.stringify(half)]) });
    expect(next.goldFiles.map((g) => g.name)).toEqual([experiment.goldFileName, `${experiment.goldFileName} (2)`]);
    expect(next.goldFileName).toBe(`${experiment.goldFileName} (2)`);
    expect(next.goldIds).toHaveLength(64);
    for (const p of next.pipelines) {
      expect(p.ids).toHaveLength(64);
      expect(p.attempted).toHaveLength(128);
    }
    // Every pipeline has the same 64 records outside it: one note, not one per pipeline.
    expect(next.issues.filter((i) => /not in the gold standard/.test(i.message))).toEqual([
      expect.objectContaining({ level: 'info', message: expect.stringMatching(/^64 of the abstracted records/) }),
    ]);

    const a = analyze(next);
    const rid = changed.record_id as number;
    const col = next.schema.categoricalFields.indexOf('Hysterectomy');
    const pa = a.pipelines[0]!;
    const right = cellValue(pa.pipeline.predictions.get(rid), 'Hysterectomy') === changed.Hysterectomy;
    expect(isError(pa.outcomes.get(rid)![col]!)).toBe(!right);
    expect(a.pipelines[0]!.scores.all!.records).toBe(64);

    const back = analyze(await withGoldStandard(next, next.goldFiles[0]!));
    expect(back.experiment.goldFiles).toHaveLength(2);
    expect(back.pipelines[0]!.scores).toEqual(analyze(experiment).pipelines[0]!.scores);
  });

  it('numbers cross-field rule violations', () => {
    const validator = createValidator(experiment.schema);
    if ('error' in validator) throw new Error(validator.error);
    const record = { ...experiment.gold.get(experiment.goldIds.find((rid) => experiment.gold.get(rid)!.UC_histo_endometrioid === 'Yes')!)! };
    expect(validator.validate(record)).toEqual([]);
    record.Uterine_cancer_primary = 'No';
    const issues = validator.validate(record);
    expect(issues.some((i) => i.field === 'UC_histo_endometrioid' && /^Rule 6: /.test(i.rule ?? ''))).toBe(true);
    expect(validator.validate({ ...record, extra: 'x' }).some((i) => i.message === 'Unexpected variable extra')).toBe(true);
  });
});
