/**
 * A tiny synthetic experiment (no real data) exercising the paths the example
 * does not: no scores.json, a missing prediction, an out-of-domain value, a
 * schema violation, pipelines run on different records, and duplicate texts.
 */
import { describe, expect, it } from 'vitest';
import { analyze, comparisonIds, getBootstrap, scoresFor } from '../src/core/analysis';
import { loadExperiment } from '../src/core/load';
import type { VirtualFile } from '../src/core/types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Toy abstraction',
  type: 'array',
  items: {
    type: 'object',
    allOf: [{ $ref: '#/$defs/identification' }, { $ref: '#/$defs/findings' }],
    unevaluatedProperties: false,
  },
  $defs: {
    identification: {
      title: 'TOY — Identification',
      type: 'object',
      properties: { record_id: { type: 'integer', 'x-role': 'primary key' } },
      required: ['record_id'],
    },
    findings: {
      title: 'TOY — Findings',
      type: 'object',
      properties: {
        Cancer: { title: 'Cancer', type: 'string', oneOf: [{ const: 'Yes' }, { const: 'No' }, { const: 'Cannot determine' }] },
        Polyp: { title: 'Polyp', type: 'string', oneOf: [{ const: 'Yes' }, { const: 'Not identified' }] },
        Site_text: { title: 'Site', type: 'string', anyOf: [{ type: 'string', minLength: 1 }, { const: 'Not identified' }] },
      },
      required: ['Cancer', 'Polyp', 'Site_text'],
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

function experimentFiles(): VirtualFile[] {
  return [
    { path: 'data_dictionary/toy.schema.json', blob: json(schema) },
    { path: 'gold_standard/gold_standard.json', blob: json(gold) },
    { path: 'pathology_reports/1.txt', blob: text('UTERUS: CARCINOMA. POLYP PRESENT.') },
    { path: 'pathology_reports/2.txt', blob: text('BENIGN.') },
    { path: 'pathology_reports/3.txt', blob: text('BENIGN.') }, // duplicate of record 2
    { path: 'pathology_reports/4.txt', blob: text('OVARY: CARCINOMA.') },
    // Pipeline A: perfect on 1, over-calls on 2, out-of-domain value on 3, no prediction for 4. No scores.json.
    {
      path: 'abstractions/a/predictions.json',
      blob: json([
        { record_id: 1, Cancer: 'Yes', Polyp: 'Yes', Site_text: 'UTERUS' },
        { record_id: 2, Cancer: 'Yes', Polyp: 'Not identified', Site_text: 'Not identified' },
        { record_id: 3, Cancer: 'Maybe', Polyp: 'Not identified', Site_text: 'Not identified' },
      ]),
    },
    { path: 'abstractions/a/run.json', blob: json({ strategy: 'baseline', ids: [1, 2, 3, 4] }) },
    // Pipeline B: run on records 1–3 only; misses the polyp on 1.
    {
      path: 'abstractions/b/predictions.json',
      blob: json([
        { record_id: 1, Cancer: 'Yes', Polyp: 'Not identified', Site_text: 'UTERUS' },
        { record_id: 2, Cancer: 'No', Polyp: 'Not identified', Site_text: 'Not identified' },
        { record_id: 3, Cancer: 'Cannot determine', Polyp: 'Not identified', Site_text: 'Not identified', extra: 1 },
      ]),
    },
    { path: 'abstractions/b/run.json', blob: json({ strategy: 'pipeline', ids: [1, 2, 3] }) },
  ];
}

describe('synthetic experiment edge cases', () => {
  it('loads, scores and validates without scores.json', async () => {
    const exp = await loadExperiment({ name: 'toy', files: experimentFiles() });
    expect(exp.schema.categoricalFields).toEqual(['Cancer', 'Polyp']);
    expect(exp.schema.textFields).toEqual(['Site_text']);
    expect(exp.schema.byName.get('Cancer')!.defaultLabel).toBe('Cannot determine');
    expect(exp.schema.byName.get('Polyp')!.defaultLabel).toBe('Not identified');
    expect(exp.uniqueIds).toEqual([1, 2, 4]);
    expect(exp.issues.some((i) => i.pipeline === 'a' && /no prediction/.test(i.message))).toBe(true);

    const analysis = analyze(exp);
    const [a, b] = analysis.pipelines;
    expect(a!.missing).toEqual([4]);
    expect(a!.invalid).toEqual([{ rid: 3, field: 'Cancer', value: 'Maybe' }]);
    expect(a!.schemaIssues?.get(3)?.some((i) => i.field === 'Cancer')).toBe(true);
    expect(b!.schemaIssues?.get(3)?.some((i) => /Unexpected variable extra/.test(i.message))).toBe(true);

    // Different run ids: compare on the common records, recomputed.
    expect(analysis.sameIds).toBe(false);
    expect(analysis.commonIds).toEqual([1, 2, 3]);
    expect(analysis.defaultSource).toBe('recomputed');
    expect(comparisonIds(analysis, 'unique')).toEqual([1, 2]);

    // Pipeline A on all its own records (unique population 1, 2, 4): record 4 is missing → both fields wrong.
    const own = a!.computed.unique!.summary;
    // Cancer: 1 TP; 2 FP (Yes vs No: both informative → FP and FN); 4 missing vs Yes → FP and FN.
    // Polyp: 1 TP; 2 TN; 4 missing vs Not identified → FP.
    expect([own.tp, own.fp, own.fn]).toEqual([2, 3, 2]);

    const common = scoresFor(analysis, 1, 'recomputed', 'unique')!.summary;
    // Pipeline B on records 1, 2: Cancer 2 TP; Polyp misses record 1 (FN).
    expect([common.tp, common.fp, common.fn]).toEqual([2, 0, 1]);

    const boot = await getBootstrap(analysis, 'all');
    expect(boot?.n).toBe(3);
    expect(boot?.pairs.get('0:1')).toBeDefined();
  });

  it('rejects folders that cannot be evaluated', async () => {
    const files = experimentFiles().filter((f) => !f.path.startsWith('gold_standard/'));
    await expect(loadExperiment({ name: 'toy', files })).rejects.toThrow(/gold_standard/);
    const noPipelines = experimentFiles().filter((f) => !f.path.startsWith('abstractions/'));
    await expect(loadExperiment({ name: 'toy', files: noPipelines })).rejects.toThrow(/No pipelines/);
  });
});
