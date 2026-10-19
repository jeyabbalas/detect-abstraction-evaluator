/**
 * The local example experiment (git-ignored: it may hold sensitive data).
 * Tests that need it are skipped when examples/new_experiment_1 is absent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadExperiment } from '../src/core/load';
import type { Experiment, VirtualFile } from '../src/core/types';
import { rerootFiles } from '../src/core/vfs';

export const EXAMPLE_NAME = 'new_experiment_1';
export const EXAMPLE = join(__dirname, '..', 'examples', EXAMPLE_NAME);
export const hasExample = existsSync(EXAMPLE);

/** Every file under `dir`, with paths that start at the example folder's name (as a folder pick gives them). */
export function readTree(dir: string = EXAMPLE, base = dir): VirtualFile[] {
  const out: VirtualFile[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readTree(full, base));
    else out.push({ path: [EXAMPLE_NAME, ...relative(base, full).split(sep)].join('/'), blob: new Blob([readFileSync(full)]) });
  }
  return out;
}

export function loadExample(): Promise<Experiment> {
  return loadExperiment(rerootFiles(readTree(), EXAMPLE_NAME));
}
