import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis';
import { MISSING } from '../src/core/evaluate';
import { loadExperiment } from '../src/core/load';
import { rerootFiles } from '../src/core/vfs';
import type { VirtualFile } from '../src/core/types';
import { errorFill, errorRamp } from '../src/ui/palette';
import {
  buildModel,
  confusionGroups,
  dotOffsets,
  errorBins,
  errorStep,
  fieldErrorRecords,
  goldLabel,
  normalizeText,
  splitConfusion,
  textMismatches,
  truncateToWidth,
} from '../src/views/fields/model';

describe('fields view helpers', () => {
  it('bins error counts exactly as errorFill shades them', () => {
    for (const mode of ['light', 'dark'] as const) {
      const ramp = errorRamp(mode);
      for (const max of [1, 2, 4, 5, 6, 10, 37, 123]) {
        const bins = errorBins(max, ramp.length);
        expect(bins[0]!.lo).toBe(1);
        expect(bins[bins.length - 1]!.hi).toBe(max);
        for (const bin of bins) {
          for (let c = bin.lo; c <= bin.hi; c += 1) {
            expect(errorStep(c, max, ramp.length)).toBe(bin.step);
            expect(errorFill(c, max, mode)).toBe(ramp[bin.step]);
          }
        }
        // Consecutive bins step through the ramp in order.
        bins.forEach((b, i) => i && expect(b.step).toBeGreaterThan(bins[i - 1]!.step));
      }
      expect(errorStep(0, 10, ramp.length)).toBe(-1);
      expect(errorBins(0, ramp.length)).toEqual([]);
    }
  });

  it('splits confusion keys, preferring a known gold value', () => {
    expect(splitConfusion('Cannot determine -> No', new Set(['Cannot determine', 'No']))).toEqual(['Cannot determine', 'No']);
    expect(splitConfusion('A -> B -> C', new Set(['A -> B', 'C']))).toEqual(['A -> B', 'C']);
    expect(splitConfusion('A -> B -> C', new Set(['A']))).toEqual(['A', 'B -> C']);
    expect(splitConfusion('odd', new Set())).toEqual(['odd', '']);
  });

  it('groups error records under the listed confusions', () => {
    const records = [
      { rid: 3, gold: 'Yes', pred: 'No', code: 3 },
      { rid: 9, gold: 'Yes', pred: 'No', code: 3 },
      { rid: 4, gold: 'No', pred: MISSING, code: 2 },
    ];
    const groups = confusionGroups({ 'Yes -> No': 2 }, ['Yes', 'No'], records);
    expect(groups).toEqual([
      { gold: 'Yes', pred: 'No', count: 2, records: [3, 9] },
      { gold: 'No', pred: MISSING, count: 1, records: [4] },
    ]);
  });

  it('formats gold support and spreads dots within a row', () => {
    expect(goldLabel([])).toBe('—');
    expect(goldLabel([28])).toBe('28');
    expect(goldLabel([26, 28])).toBe('26–28');
    expect(dotOffsets(1, 26)).toEqual([0]);
    const offsets = dotOffsets(3, 33);
    expect(offsets).toEqual([-7, 0, 7]);
    const many = dotOffsets(8, 44);
    expect(Math.max(...many) + 4.5).toBeLessThanOrEqual(22);
    expect(many[0]).toBeCloseTo(-many[7]!);
  });

  it('truncates to a measured width with an ellipsis', () => {
    const measure = (s: string) => s.length * 7;
    expect(truncateToWidth('Hysterectomy', 200, measure)).toBe('Hysterectomy');
    const cut = truncateToWidth('OCPeriFal_histo_other_non_epithelial', 140, measure);
    expect(cut.endsWith('…')).toBe(true);
    expect(measure(cut)).toBeLessThanOrEqual(140);
    expect(normalizeText('  Serous   CARCINOMA\n')).toBe('serous carcinoma');
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

describe.skipIf(!existsSync(EXAMPLE))('fields model on examples/experiment_1', () => {
  it('matches the reported scores and finds the records behind every confusion', async () => {
    const analysis = analyze(await loadExperiment(rerootFiles(readTree(EXAMPLE), 'experiment_1')));
    const { schema } = analysis.experiment;
    for (const population of ['unique', 'all'] as const) {
      const model = buildModel(analysis, population, 'reported');
      const reported = analysis.pipelines[0]!.pipeline.reportedScores![population]!;
      expect(model.categories.map((r) => r.category.key)).toEqual(Object.keys(reported.per_category));
      expect(model.fieldByName.size).toBe(schema.categoricalFields.length);
      expect(model.text.map((r) => r.field.name)).toEqual(schema.textFields);

      let fieldMax = 0;
      for (const row of model.fieldByName.values()) {
        // Gold support is the same for every pipeline on the same records.
        expect(row.gold).toHaveLength(1);
        for (const cell of row.cells) {
          const fs = cell.score!;
          fieldMax = Math.max(fieldMax, fs.fp + fs.fn);
          const records = fieldErrorRecords(analysis, cell.pipe, row.field.name, model.ids);
          const listed = Object.values(fs.confusion).reduce((a, b) => a + b, 0);
          expect(records).toHaveLength(listed);
          for (const g of confusionGroups(fs.confusion, row.field.domain, records)) expect(g.records).toHaveLength(g.count);
        }
      }
      expect(model.fieldMax).toBe(fieldMax);
      for (const row of model.categories) expect(row.gold).toHaveLength(1);

      for (const row of model.text) {
        for (const cell of row.cells) {
          const diff = textMismatches(analysis, cell.pipe, row.field.name, model.ids);
          const n = model.ids.length;
          expect((n - diff.presence.length) / n).toBeCloseTo(cell.score!.presence_agreement, 12);
          expect((n - diff.text.length) / n).toBeCloseTo(cell.score!.exact_match, 12);
        }
      }
    }
  });
});
