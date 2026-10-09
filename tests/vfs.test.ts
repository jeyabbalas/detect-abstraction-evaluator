import { describe, expect, it } from 'vitest';
import { duplicateGroups, toRecordId } from '../src/core/load';
import { rerootFiles } from '../src/core/vfs';

const file = (path: string) => ({ path, blob: new Blob(['x']) });

describe('rerootFiles', () => {
  it('re-roots at the folder that holds the experiment subfolders', () => {
    const set = rerootFiles(
      [
        file('exp_1/abstractions/run_a/predictions.json'),
        file('exp_1/gold_standard/gold.json'),
        file('exp_1/pathology_reports/1.txt'),
        file('exp_1/.DS_Store'),
        file('__MACOSX/exp_1/._gold.json'),
      ],
      'fallback',
    );
    expect(set.name).toBe('exp_1');
    expect(set.files.map((f) => f.path).sort()).toEqual([
      'abstractions/run_a/predictions.json',
      'gold_standard/gold.json',
      'pathology_reports/1.txt',
    ]);
  });

  it('handles a parent folder (or zip) that wraps the experiment', () => {
    const set = rerootFiles(
      [file('outer/exp_2/data_dictionary/schema.json'), file('outer/exp_2/abstractions/r/predictions.json'), file('outer/notes.md')],
      'outer',
    );
    expect(set.name).toBe('exp_2');
    expect(set.files.map((f) => f.path)).toEqual(['data_dictionary/schema.json', 'abstractions/r/predictions.json']);
  });

  it('accepts files already relative to the experiment root', () => {
    const set = rerootFiles([file('gold_standard/g.json'), file('abstractions/r/run.json')], 'picked');
    expect(set.name).toBe('picked');
    expect(set.files).toHaveLength(2);
  });
});

describe('loader helpers', () => {
  it('parses record ids from numbers and numeric strings only', () => {
    expect(toRecordId(12)).toBe(12);
    expect(toRecordId(' 7 ')).toBe(7);
    expect(toRecordId('7a')).toBeNull();
    expect(toRecordId(1.5)).toBeNull();
  });

  it('groups identical report texts, lowest id first', () => {
    const reports = new Map([
      [3, 'same'],
      [1, 'same'],
      [2, 'other'],
    ]);
    expect(duplicateGroups(reports)).toEqual([
      [1, 3],
      [2],
    ]);
  });
});
