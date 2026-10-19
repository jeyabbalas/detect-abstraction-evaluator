/**
 * A tiny synthetic experiment (no real data) exercising the paths the example
 * does not: a failed record, an out-of-domain value, schema and rule
 * violations, pipelines run on different records, a run with neither
 * config.json nor summary.json, a run against another data dictionary,
 * duplicate texts, and gold standards that are missing or unusable.
 */
import { describe, expect, it } from 'vitest';
import { analyze, comparisonIds, getBootstrap, scoresFor } from '../src/core/analysis';
import { Outcome } from '../src/core/evaluate';
import { LoadError, MissingGoldError, failuresFrom, loadExperiment, readRecordFile, withGoldStandard } from '../src/core/load';
import { fieldNamed, runNotes } from '../src/core/notes';
import type { VirtualFile } from '../src/core/types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Toy abstraction',
  type: 'object',
  properties: {
    record_id: { type: 'integer', minimum: 1 },
    Cancer: { type: 'string', enum: ['Yes', 'No', 'Cannot determine'] },
    Polyp: { type: 'string', enum: ['Yes', 'Not identified'] },
    Site_text: { type: 'string' },
  },
  required: ['record_id', 'Cancer', 'Polyp', 'Site_text'],
  additionalProperties: false,
  allOf: [
    {
      $comment: 'A polyp names its site.',
      'x-rule': 1,
      if: { required: ['Polyp'], properties: { Polyp: { const: 'Yes' } } },
      then: { properties: { Site_text: { not: { const: 'Not identified' } } } },
    },
  ],
  'x-abstraction': {
    progressive: {
      stages: {
        screening: { $comment: 'Cancer screening.', fields: ['Cancer'] },
        findings: { $comment: 'Polyps and their sites.', fields: ['Polyp', 'Site_text'] },
        residual: { $comment: 'Codes nothing new.', fields: ['Site_text'] },
      },
    },
  },
};

const gold = [
  { record_id: 1, Cancer: 'Yes', Polyp: 'Yes', Site_text: 'UTERUS' },
  { record_id: 2, Cancer: 'No', Polyp: 'Not identified', Site_text: 'Not identified' },
  { record_id: 3, Cancer: 'Cannot determine', Polyp: 'Not identified', Site_text: 'Not identified' },
  { record_id: 4, Cancer: 'Yes', Polyp: 'Not identified', Site_text: 'OVARY' },
];

const json = (v: unknown) => new Blob([JSON.stringify(v)]);
const text = (v: string) => new Blob([v]);

const predA = [
  { record_id: 1, Cancer: 'Yes', Polyp: 'Yes', Site_text: 'UTERUS' },
  { record_id: 2, Cancer: 'Yes', Polyp: 'Not identified', Site_text: 'Not identified' },
  { record_id: 3, Cancer: 'Maybe', Polyp: 'Not identified', Site_text: 'Not identified' },
];
const predB = [
  { record_id: 1, Cancer: 'Yes', Polyp: 'Not identified', Site_text: 'UTERUS' },
  { record_id: 2, Cancer: 'No', Polyp: 'Yes', Site_text: 'Not identified' },
  { record_id: 3, Cancer: 'Cannot determine', Polyp: 'Not identified', Site_text: 'Not identified', extra: 1 },
];

function experimentFiles(): VirtualFile[] {
  return [
    { path: 'data_dictionary/toy.schema.json', blob: json(schema) },
    { path: 'gold_standard/gold_standard.json', blob: json(gold) },
    { path: 'pathology_reports/1.txt', blob: text('UTERUS: CARCINOMA. POLYP PRESENT.') },
    { path: 'pathology_reports/2.txt', blob: text('BENIGN.') },
    { path: 'pathology_reports/3.txt', blob: text('BENIGN.') }, // duplicate of record 2
    { path: 'pathology_reports/4.txt', blob: text('OVARY: CARCINOMA.') },
    // Pipeline A: perfect on 1, over-calls on 2, an out-of-domain value on 3, failed on 4; run with another dictionary.
    { path: 'abstractions/a/predictions.json', blob: json(predA) },
    { path: 'abstractions/a/config.json', blob: json({ pipeline: 'progressive', model: 'm-9b', schema_sha256: 'ab'.repeat(32), client_settings: { temperature: 0.6 } }) },
    {
      path: 'abstractions/a/summary.json',
      blob: json({
        records: 4,
        failures: [{ record_id: 4, error: 'server timeout' }],
        unreadable_records: [],
        records_with: { unresolved: 1, gate_changes: 1 },
        finish_reasons: { stop: 9, length: 1 },
        calls: 10,
        repair_rounds: 2,
        prompt_tokens: 1000,
        completion_tokens: 3000,
        model_seconds: 120.5,
        issues: {
          '2': { gate_changes: ["Cancer: 'No' -> 'Cannot determine'"] },
          '3': { unresolved: { screening: ['Cancer is "Maybe", which is not an allowed value.'] } },
        },
      }),
    },
    ...predA.map((r) => ({ path: `abstractions/a/records/${r.record_id}.json`, blob: json({ record_id: r.record_id, record: r, trace: { pipeline: 'progressive', stages: {} }, seconds: 30 }) })),
    // Pipeline B: run on records 1–3 only, with neither config.json nor summary.json; misses the polyp on 1.
    { path: 'abstractions/b/predictions.json', blob: json(predB) },
  ];
}

describe('synthetic experiment edge cases', () => {
  it('loads the run files, failures, notes and stage categories', async () => {
    const exp = await loadExperiment({ name: 'toy', files: experimentFiles() });
    const { schema: model } = exp;
    expect(model.categoricalFields).toEqual(['Cancer', 'Polyp']);
    expect(model.textFields).toEqual(['Site_text']);
    expect(model.categories.map((c) => [c.key, c.title, c.fields])).toEqual([
      ['screening', 'Screening', ['Cancer']],
      ['findings', 'Findings', ['Polyp', 'Site_text']],
    ]);
    expect(model.ruleCount).toBe(1);
    expect(model.byName.get('Cancer')!.defaultLabel).toBe('Cannot determine');
    expect(model.byName.get('Polyp')!.defaultLabel).toBe('Not identified');
    expect(exp.uniqueIds).toEqual([1, 2, 4]);
    expect(exp.schemaSha256).toMatch(/^[0-9a-f]{64}$/);

    const [a, b] = exp.pipelines;
    expect(a!.config?.model).toBe('m-9b');
    expect(a!.failures).toEqual([{ rid: 4, message: 'server timeout' }]);
    expect(a!.attempted).toEqual([1, 2, 3, 4]);
    expect(a!.recordFiles.size).toBe(3);
    expect((await readRecordFile(a!, 2))?.record).toEqual(predA[1]);
    expect(await readRecordFile(a!, 4)).toBeNull();
    expect([...a!.notes.keys()]).toEqual([2, 3]);
    expect(b!.config).toBeNull();
    expect(b!.summary).toBeNull();
    expect(b!.attempted).toEqual([1, 2, 3]);

    const issue = (re: RegExp, pipeline?: string) => exp.issues.find((i) => re.test(i.message) && (pipeline === undefined || i.pipeline === pipeline));
    expect(issue(/different data dictionary/, 'a')?.level).toBe('warning');
    expect(issue(/1 failed record/, 'a')?.level).toBe('warning');
    expect(issue(/no prediction \(e\.g\. 4\)/, 'a')?.level).toBe('warning');
    expect(issue(/no config\.json/, 'b')?.level).toBe('info');
    expect(issue(/no summary\.json/, 'b')?.level).toBe('info');
  });

  it('scores, validates and compares pipelines run on different records', async () => {
    const analysis = analyze(await loadExperiment({ name: 'toy', files: experimentFiles() }));
    const [a, b] = analysis.pipelines;
    expect(a!.missing).toEqual([4]);
    expect(a!.invalid).toEqual([{ rid: 3, field: 'Cancer', value: 'Maybe' }]);
    expect(a!.schemaIssues?.get(3)?.some((i) => i.field === 'Cancer')).toBe(true);
    expect(b!.schemaIssues?.get(3)?.some((i) => /Unexpected variable extra/.test(i.message))).toBe(true);
    expect(b!.schemaIssues?.get(2)?.find((i) => i.field === 'Site_text')?.rule).toBe('Rule 1: A polyp names its site.');

    // A failed record is scored as wrong: Cancer (Yes vs nothing) is both an FP and an FN; Polyp an FP.
    expect([...a!.outcomes.get(4)!]).toEqual([Outcome.FPFN, Outcome.FP]);
    expect(a!.errorCount.get(4)).toBe(2);
    expect(b!.errorCount.has(4)).toBe(false);

    // Different records: compared on the records both were run on.
    expect(analysis.sameIds).toBe(false);
    expect(analysis.commonIds).toEqual([1, 2, 3]);
    expect(comparisonIds(analysis, 'unique')).toEqual([1, 2]);
    // A on 1, 2: Cancer 1 TP + (Yes vs No) FP and FN; Polyp 1 TP.
    expect(scoresFor(analysis, 0, 'unique')!.summary).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    // B on 1, 2: Cancer 2 TP; Polyp misses record 1 (FN) and over-calls record 2 (FP).
    expect(scoresFor(analysis, 1, 'unique')!.summary).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(a!.scores.all!.records).toBe(3);

    const boot = await getBootstrap(analysis, 'all');
    expect(boot?.n).toBe(3);
    expect(boot?.pairs.get('0:1')).toBeDefined();
  });

  it('flattens run notes and finds the variable they name', async () => {
    const exp = await loadExperiment({ name: 'toy', files: experimentFiles() });
    const a = exp.pipelines[0]!;
    expect(runNotes(a.notes.get(2))).toEqual([{ kind: 'gate', label: 'Gate change', text: "Cancer: 'No' -> 'Cannot determine'" }]);
    const [note] = runNotes(a.notes.get(3));
    expect(note).toMatchObject({ kind: 'unresolved', stage: 'screening' });
    expect(fieldNamed(note!.text, exp.schema)).toBe('Cancer');
    expect(fieldNamed('screening: nothing to see', exp.schema)).toBeNull();
    expect(runNotes({ fixes: ['x'], fallbacks: ['y'], custom: 'z' }).map((n) => n.kind)).toEqual(['fallback', 'fix', 'other']);
  });

  it('reads failures in every shape summary.json may use', () => {
    expect(failuresFrom([7, '8', 'pathology_reports/9.txt', { record_id: 10, message: 'm' }, { nothing: 1 }], 'failed')).toEqual([
      { rid: 7, message: 'failed' },
      { rid: 8, message: 'failed' },
      { rid: 9, message: 'failed' },
      { rid: 10, message: 'm' },
    ]);
    expect(failuresFrom({ '11': 'timeout' }, 'failed')).toEqual([{ rid: 11, message: 'timeout' }]);
    expect(failuresFrom(undefined, 'failed')).toEqual([]);
  });

  it('switches gold standards, and rejects ones it cannot use', async () => {
    const exp = await loadExperiment({ name: 'toy', files: experimentFiles() });
    const fewer = await withGoldStandard(exp, { name: 'gold_v2.json', blob: json(gold.slice(0, 2)) });
    expect(fewer.goldFiles.map((g) => g.name)).toEqual(['gold_standard.json', 'gold_v2.json']);
    expect(fewer.goldFileName).toBe('gold_v2.json');
    expect(fewer.pipelines.map((p) => p.ids)).toEqual([[1, 2], [1, 2]]);
    // The failed record is outside this gold standard, so nothing is missing.
    expect(fewer.issues.some((i) => /no prediction/.test(i.message))).toBe(false);
    // A covered 3 and 4, B only 3: each pipeline gets its own note.
    expect(fewer.issues.filter((i) => /not in the gold standard/.test(i.message)).map((i) => i.pipeline)).toEqual(['a', 'b']);
    expect(analyze(fewer).sameIds).toBe(true);

    await expect(withGoldStandard(exp, { name: 'bad.json', blob: text('{') })).rejects.toThrow(LoadError);
    await expect(withGoldStandard(exp, { name: 'other.json', blob: json([{ ...gold[0], record_id: 99 }]) })).rejects.toThrow(/None of the pipelines/);
    await expect(withGoldStandard(exp, { name: 'empty.json', blob: json([]) })).rejects.toThrow(/no records/);
  });

  it('rejects folders that cannot be evaluated', async () => {
    const noGold = experimentFiles().filter((f) => !f.path.startsWith('gold_standard/'));
    await expect(loadExperiment({ name: 'toy', files: noGold })).rejects.toBeInstanceOf(MissingGoldError);
    const noPipelines = experimentFiles().filter((f) => !f.path.startsWith('abstractions/'));
    await expect(loadExperiment({ name: 'toy', files: noPipelines })).rejects.toThrow(/No pipelines/);
  });
});
