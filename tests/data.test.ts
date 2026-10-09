import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze, type Analysis } from '../src/core/analysis';
import { MISSING, Outcome, isError } from '../src/core/evaluate';
import { loadExperiment } from '../src/core/load';
import { rerootFiles } from '../src/core/vfs';
import type { VirtualFile } from '../src/core/types';
import {
  CELLS,
  GOLD,
  buildDataset,
  cellColumns,
  cellRowCount,
  datasetOptions,
  errorVector,
  mismatchMessage,
  placeAfter,
  recordsJson,
  resolveDatasetKey,
  rowIdMap,
  scoredIds,
  tableNames,
  type DatasetOption,
} from '../src/views/data/datasets';

describe('data view helpers', () => {
  it('maps record ids to __rowid__ from typed, bigint or plain column reads', () => {
    const rowids = BigInt64Array.from([0n, 1n, 2n, 3n]);
    expect([...rowIdMap(rowids, Int32Array.from([17, 3, 9, 4]))]).toEqual([
      [17, 0],
      [3, 1],
      [9, 2],
      [4, 3],
    ]);
    // NULL ids are skipped; bigint and string ids are converted.
    expect([...rowIdMap([2, 0, 1], [10n, null, '12'])]).toEqual([
      [10, 2],
      [12, 1],
    ]);
  });

  it('aligns a vector column to __rowid__ and leaves unscored rows NULL', () => {
    const counts = new Map([
      [17, 2],
      [9, 0],
    ]);
    const rowOf = new Map([
      [17, 2],
      [9, 0],
      [4, 1],
    ]);
    const v = errorVector(counts, rowOf, 3);
    expect(v[0]).toBe(0);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBe(2);
  });

  it('moves a column right after its anchor', () => {
    expect(placeAfter(['record_id', '__rowid__', 'a', 'b', 'errors'], 'errors', 'record_id')).toEqual([
      'record_id',
      'errors',
      '__rowid__',
      'a',
      'b',
    ]);
    expect(placeAfter(['a', 'b'], 'c', 'missing')).toEqual(['c', 'a', 'b']);
  });

  it('names tables readably and uniquely, ignoring case', () => {
    const options: DatasetOption[] = [
      { key: GOLD, kind: 'gold', label: 'Gold standard' },
      { key: 'Run-A', kind: 'pipeline', label: 'Run-A', pipeline: 0 },
      { key: 'run_a', kind: 'pipeline', label: 'run_a', pipeline: 1 },
      { key: '2024 run', kind: 'pipeline', label: '2024 run', pipeline: 2 },
      { key: 'gold standard', kind: 'pipeline', label: 'gold standard', pipeline: 3 },
      { key: CELLS, kind: 'cells', label: 'Cell comparison' },
    ];
    const names = tableNames(options);
    expect(names.get(GOLD)).toBe('gold_standard');
    expect(names.get(CELLS)).toBe('cell_comparison');
    expect(names.get('Run-A')).toBe('run_a');
    expect(names.get('run_a')).toBe('run_a_2');
    expect(names.get('2024 run')).toBe('pipeline_2024_run');
    expect(names.get('gold standard')).toBe('gold_standard_2');
    expect(resolveDatasetKey(options, 'run_a')).toBe('run_a');
    expect(resolveDatasetKey(options, 'nope')).toBeNull();
    expect(resolveDatasetKey(options, null)).toBeNull();
  });

  it('writes records with keys in column order, even integer-like ones', () => {
    const records = new Map<number, Record<string, unknown>>([
      [2, { b: 'x', record_id: 2, '1': 'one', a: 3 }],
      [5, { a: null }],
    ]);
    const json = recordsJson([2, 5, 7], (rid) => records.get(rid), 'record_id', ['record_id', 'a', 'b', '1']);
    const rows = JSON.parse(json) as Record<string, unknown>[];
    expect(rows).toEqual([
      { record_id: 2, a: 3, b: 'x', '1': 'one' },
      { record_id: 5, a: null, b: null, '1': null },
      { record_id: 7, a: null, b: null, '1': null },
    ]);
    // Text order (what DuckDB sees) follows the columns, not JS key order.
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"1"'));
  });

  it('explains a mismatch with the gold value and the outcome', () => {
    expect(mismatchMessage('Cannot determine', 'Yes', Outcome.FP)).toBe(
      "Gold: 'Cannot determine' · FP — predicted an informative label where gold has the default (over-call)",
    );
    expect(mismatchMessage('Yes', MISSING, Outcome.FPFN)).toContain('no prediction');
    expect(mismatchMessage(MISSING, 'No', Outcome.FN)).toMatch(/^Gold: no value · FN/);
  });
});

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

describe.skipIf(!hasExample)('data view datasets on examples/experiment_1', () => {
  let analysis: Analysis;
  beforeAll(async () => {
    analysis = analyze(await loadExperiment(rerootFiles(readTree(EXAMPLE), 'experiment_1')));
  });

  it('offers gold, every pipeline and the cell comparison', () => {
    const options = datasetOptions(analysis);
    expect(options.map((o) => o.kind)).toEqual(['gold', ...analysis.pipelines.map(() => 'pipeline'), 'cells']);
    const names = new Set(tableNames(options).values());
    expect(names.size).toBe(options.length);
  });

  it('builds the gold standard in schema order, sorted by record id', () => {
    const { schema } = analysis.experiment;
    const option = datasetOptions(analysis)[0]!;
    const ds = buildDataset(analysis, option, 'gold_standard');
    const rows = JSON.parse(ds.json) as Record<string, unknown>[];
    expect(rows).toHaveLength(analysis.experiment.goldIds.length);
    expect(Object.keys(rows[0]!).slice(0, schema.fields.length + 1)).toEqual([schema.idField, ...schema.fields.map((f) => f.name)]);
    const ids = rows.map((r) => r[schema.idField] as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ds.tooltips.map(([c]) => c)).toEqual(ds.columns);
  });

  it('flags exactly the cells the scorer counts as errors', () => {
    const { schema } = analysis.experiment;
    const options = datasetOptions(analysis).filter((o) => o.kind === 'pipeline');
    for (const option of options) {
      const pa = analysis.pipelines[option.pipeline!]!;
      const ds = buildDataset(analysis, option, 'p');
      const rows = JSON.parse(ds.json) as Record<string, unknown>[];
      expect(rows.length).toBe(ds.rowCount);
      // Identity __rowid__ mapping, as a fresh load assigns it.
      const rowOf = new Map(rows.map((r, i) => [r[schema.idField] as number, i]));
      const notes = ds.annotations(rowOf);
      const mismatches = notes.filter((n) => n.code === 'MISMATCH');
      const expected = [...pa.errorCount.entries()].filter(([rid]) => rowOf.has(rid)).reduce((s, [, n]) => s + n, 0);
      expect(mismatches).toHaveLength(expected);
      expect(ds.stats.mismatches).toBe(expected);
      for (const n of mismatches) {
        expect(n.scope).toBe('cell');
        expect(n.severity).toBe('error');
        if (n.scope === 'cell') expect(schema.categoricalFields).toContain(n.column);
      }
      expect(ds.errorCounts).toBe(pa.errorCount);
    }
  });

  it('turns JSON Schema issues into warnings on the cell, or on the row when no column matches', () => {
    const { schema, goldIds } = analysis.experiment;
    const [first, second] = goldIds;
    const field = schema.categoricalFields[0]!;
    const injected: Analysis = {
      ...analysis,
      goldSchemaIssues: new Map([
        [first!, [{ field, message: `${field} is 'x', which is not an allowed value`, keyword: 'enum' }]],
        [second!, [{ field: '', message: 'Unexpected variable foo', keyword: 'unevaluatedProperties', rule: 'R1' }]],
      ]),
    };
    const ds = buildDataset(injected, datasetOptions(injected)[0]!, 'gold_standard');
    expect(ds.stats.schemaIssues).toBe(2);
    const notes = ds.annotations(new Map([[first!, 0], [second!, 1]]));
    expect(notes).toEqual([
      expect.objectContaining({ scope: 'cell', rowId: 0, column: field, severity: 'warning', code: 'SCHEMA_ENUM' }),
      expect.objectContaining({
        scope: 'row',
        rowId: 1,
        severity: 'warning',
        code: 'SCHEMA_UNEVALUATED_PROPERTIES',
        message: 'Unexpected variable foo (rule: R1)',
      }),
    ]);
  });

  it('builds one comparison row per pipeline × scored record × categorical variable', () => {
    const { schema, uniqueIds } = analysis.experiment;
    const option = datasetOptions(analysis).at(-1)!;
    const ds = buildDataset(analysis, option, 'cell_comparison');
    const rows = JSON.parse(ds.json) as Record<string, unknown>[];
    expect(rows.length).toBe(cellRowCount(analysis));
    expect(rows.length).toBe(analysis.pipelines.reduce((s, pa) => s + scoredIds(pa).length * schema.categoricalFields.length, 0));
    expect(Object.keys(rows[0]!)).toEqual(cellColumns(schema.idField));

    // Outcome tallies match the analysis, and `correct` agrees with the outcome.
    const unique = new Set(uniqueIds);
    analysis.pipelines.forEach((pa) => {
      const mine = rows.filter((r) => r.pipeline === pa.pipeline.name);
      let errors = 0;
      for (const rid of scoredIds(pa)) for (const o of pa.outcomes.get(rid)!) if (isError(o)) errors += 1;
      expect(mine.filter((r) => r.correct === false)).toHaveLength(errors);
      expect(mine.filter((r) => ['FP', 'FN', 'FP+FN'].includes(r.outcome as string))).toHaveLength(errors);
      for (const r of mine.slice(0, 500)) expect(r.unique_text).toBe(unique.has(r[schema.idField] as number));
    });
    expect(new Set(rows.map((r) => r.outcome))).toEqual(
      new Set(rows.map((r) => r.outcome).filter((o) => ['Correct (informative)', 'Correct (default)', 'FP', 'FN', 'FP+FN'].includes(o as string))),
    );
  });
});
