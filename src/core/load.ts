/**
 * Parses an uploaded experiment directory into an {@link Experiment}.
 * Problems are collected as issues rather than thrown, unless the experiment
 * cannot be shown at all (no schema, no gold standard, no pipelines).
 */

import { buildSchemaModel, type SchemaInput } from './schema';
import type {
  AbstractionRecord,
  Experiment,
  LoadIssue,
  Pipeline,
  RecordId,
  RunMeta,
  Scores,
  VirtualFile,
} from './types';
import type { FileSet } from './vfs';

export class LoadError extends Error {}

const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const basename = (path: string): string => path.split('/').pop()!;
const stem = (path: string): string => basename(path).replace(/\.[^.]+$/, '');

/** Integer record id from a file stem or a record value, else null. */
export function toRecordId(value: unknown): RecordId | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

async function readJson(file: VirtualFile): Promise<unknown> {
  const text = await file.blob.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LoadError(`${file.path} is not valid JSON (${(err as Error).message}).`);
  }
}

/** Python `load_records`: an array, `{records: [...]}`, or an object of records. */
function recordsFrom(data: unknown, idField: string, source: string, issues: LoadIssue[], pipeline?: string) {
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    list = Array.isArray(obj.records) ? obj.records : Object.values(obj);
  } else throw new LoadError(`${source} does not hold a JSON array of records.`);
  const map = new Map<RecordId, AbstractionRecord>();
  let skipped = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1;
      continue;
    }
    const rid = toRecordId((item as AbstractionRecord)[idField]);
    if (rid === null) {
      skipped += 1;
      continue;
    }
    if (map.has(rid)) issues.push({ level: 'warning', message: `${source}: duplicate ${idField} ${rid}; the last one is used.`, pipeline });
    map.set(rid, item as AbstractionRecord);
  }
  if (skipped) issues.push({ level: 'warning', message: `${source}: ${skipped} entries without a valid ${idField} were skipped.`, pipeline });
  return map;
}

/** Identical-text groups over all reports, lowest id first (evaluate.py `duplicate_groups`). */
export function duplicateGroups(reports: Map<RecordId, string>): RecordId[][] {
  const byText = new Map<string, RecordId[]>();
  for (const rid of [...reports.keys()].sort((a, b) => a - b)) {
    const text = reports.get(rid)!;
    const group = byText.get(text);
    if (group) group.push(rid);
    else byText.set(text, [rid]);
  }
  return [...byText.values()].sort((a, b) => a[0]! - b[0]!);
}

export interface LoadProgress {
  stage: string;
  done?: number;
  total?: number;
}

export async function loadExperiment(set: FileSet, onProgress?: (p: LoadProgress) => void): Promise<Experiment> {
  const issues: LoadIssue[] = [];
  const files = set.files;
  const under = (dir: string) => files.filter((f) => f.path.startsWith(`${dir}/`));

  // --- data dictionary ------------------------------------------------------
  onProgress?.({ stage: 'Reading the data dictionary' });
  const dictFiles = under('data_dictionary').filter((f) => /\.json$/i.test(f.path));
  if (!dictFiles.length) throw new LoadError('Missing data_dictionary/: add the JSON Schema of the abstraction (a .json file).');
  const schemaInputs: SchemaInput[] = [];
  for (const f of dictFiles) {
    try {
      schemaInputs.push({ name: f.path.slice('data_dictionary/'.length), json: await readJson(f) });
    } catch (err) {
      issues.push({ level: 'warning', message: (err as Error).message });
    }
  }
  const schema = buildSchemaModel(schemaInputs);
  if (!schema.categoricalFields.length) {
    throw new LoadError(`The data dictionary (${schema.rootName}) declares no categorical variables to evaluate.`);
  }

  // --- gold standard ---------------------------------------------------------
  onProgress?.({ stage: 'Reading the gold standard' });
  const goldFiles = under('gold_standard').filter((f) => /\.json$/i.test(f.path));
  if (!goldFiles.length) throw new LoadError('Missing gold_standard/: add the gold-standard records as one JSON array.');
  goldFiles.sort((a, b) => Number(!/gold/i.test(basename(a.path))) - Number(!/gold/i.test(basename(b.path))) || naturalCompare(a.path, b.path));
  const goldFile = goldFiles[0]!;
  if (goldFiles.length > 1) {
    issues.push({ level: 'warning', message: `gold_standard/ holds ${goldFiles.length} JSON files; using ${basename(goldFile.path)}.` });
  }
  const gold = recordsFrom(await readJson(goldFile), schema.idField, goldFile.path, issues);
  if (!gold.size) throw new LoadError(`${goldFile.path} holds no records with a ${schema.idField}.`);
  const goldIds = [...gold.keys()].sort((a, b) => a - b);
  const missingFields = new Set<string>();
  for (const rec of gold.values()) for (const f of schema.fields) if (!(f.name in rec)) missingFields.add(f.name);
  if (missingFields.size) {
    issues.push({
      level: 'warning',
      message: `Some gold records lack ${missingFields.size} variable(s) (e.g. ${[...missingFields].slice(0, 3).join(', ')}); they are scored as '<missing>'.`,
    });
  }

  // --- reports ----------------------------------------------------------------
  onProgress?.({ stage: 'Reading pathology reports' });
  const reportFiles = under('pathology_reports').filter((f) => /\.txt$/i.test(f.path));
  const reports = new Map<RecordId, string>();
  const badNames: string[] = [];
  await Promise.all(
    reportFiles.map(async (f) => {
      const rid = toRecordId(stem(f.path));
      if (rid === null) {
        badNames.push(basename(f.path));
        return;
      }
      // Python reads text with universal newlines.
      reports.set(rid, (await f.blob.text()).replace(/\r\n?/g, '\n'));
    }),
  );
  if (!reportFiles.length) issues.push({ level: 'warning', message: 'No pathology_reports/*.txt found: report text and the unique-text population are unavailable.' });
  if (badNames.length) issues.push({ level: 'warning', message: `${badNames.length} report file(s) are not named <record_id>.txt (e.g. ${badNames[0]}); skipped.` });
  const withoutReport = goldIds.filter((rid) => !reports.has(rid));
  if (reportFiles.length && withoutReport.length) {
    issues.push({ level: 'warning', message: `${withoutReport.length} gold record(s) have no report text (e.g. ${withoutReport.slice(0, 5).join(', ')}).` });
  }
  const groups = duplicateGroups(reports);
  const groupOf = new Map<RecordId, RecordId[]>();
  for (const g of groups) for (const rid of g) groupOf.set(rid, g);
  // As in evaluate.py, the unique population is empty without report texts.
  const uniqueIds = groups.map((g) => g[0]!).sort((a, b) => a - b);

  // --- pipelines -------------------------------------------------------------
  const runDirs = new Map<string, VirtualFile[]>();
  for (const f of under('abstractions')) {
    const parts = f.path.split('/');
    if (parts.length < 3) continue;
    const dir = parts[1]!;
    if (!runDirs.has(dir)) runDirs.set(dir, []);
    runDirs.get(dir)!.push(f);
  }
  const names = [...runDirs.keys()].sort(naturalCompare);
  const pipelines: Pipeline[] = [];
  let done = 0;
  for (const name of names) {
    onProgress?.({ stage: `Reading ${name}`, done, total: names.length });
    const dirFiles = runDirs.get(name)!;
    const at = (rel: string) => dirFiles.find((f) => f.path === `abstractions/${name}/${rel}`);
    const predFile = at('predictions.json');
    if (!predFile) {
      issues.push({ level: 'warning', message: `abstractions/${name}/ has no predictions.json; skipped.`, pipeline: name });
      done += 1;
      continue;
    }
    try {
      const predictions = recordsFrom(await readJson(predFile), schema.idField, predFile.path, issues, name);
      let run: RunMeta | null = null;
      const runFile = at('run.json');
      if (runFile) {
        try {
          run = (await readJson(runFile)) as RunMeta;
        } catch (err) {
          issues.push({ level: 'warning', message: (err as Error).message, pipeline: name });
        }
      } else issues.push({ level: 'info', message: `abstractions/${name}/ has no run.json; configuration and cost are unknown.`, pipeline: name });
      let reportedScores: Scores | null = null;
      const scoresFile = at('scores.json');
      if (scoresFile) {
        try {
          reportedScores = (await readJson(scoresFile)) as Scores;
        } catch (err) {
          issues.push({ level: 'warning', message: (err as Error).message, pipeline: name });
        }
      } else issues.push({ level: 'info', message: `abstractions/${name}/ has no scores.json; metrics are computed in the browser.`, pipeline: name });
      const scoresTxt = at('scores.txt');
      const traceFiles = new Map<RecordId, Blob>();
      for (const f of dirFiles) {
        const rel = f.path.slice(`abstractions/${name}/`.length);
        if (rel.startsWith('traces/') && /\.json$/i.test(rel)) {
          const rid = toRecordId(stem(rel));
          if (rid !== null) traceFiles.set(rid, f.blob);
        }
      }
      const runIds = Array.isArray(run?.ids) ? run!.ids.map(toRecordId).filter((x): x is RecordId => x !== null) : null;
      const ids = (runIds ?? goldIds).filter((rid) => gold.has(rid)).sort((a, b) => a - b);
      const outside = (runIds ?? []).filter((rid) => !gold.has(rid));
      if (outside.length) {
        issues.push({ level: 'warning', message: `${name}: ${outside.length} run id(s) are not in the gold standard (e.g. ${outside.slice(0, 5).join(', ')}).`, pipeline: name });
      }
      const missing = ids.filter((rid) => !predictions.has(rid));
      if (missing.length) {
        issues.push({
          level: 'warning',
          message: `${name}: ${missing.length} record(s) have no prediction (e.g. ${missing.slice(0, 5).join(', ')}); they are scored as wrong.`,
          pipeline: name,
        });
      }
      const failures = run?.failures && typeof run.failures === 'object' ? Object.keys(run.failures).length : 0;
      if (failures) issues.push({ level: 'warning', message: `${name}: run.json reports ${failures} failed record(s).`, pipeline: name });
      pipelines.push({
        id: name,
        name,
        index: pipelines.length,
        run,
        predictions,
        reportedScores,
        scoresText: scoresTxt ? await scoresTxt.blob.text() : null,
        traceFiles,
        ids,
      });
    } catch (err) {
      issues.push({ level: 'error', message: `${name}: ${(err as Error).message}`, pipeline: name });
    }
    done += 1;
  }
  if (!pipelines.length) {
    throw new LoadError('No pipelines found: add one folder per pipeline under abstractions/, each with a predictions.json.');
  }

  return {
    name: set.name,
    schema,
    gold,
    goldIds,
    goldFileName: basename(goldFile.path),
    reports,
    duplicateGroups: groups,
    groupOf,
    uniqueIds,
    pipelines,
    issues,
  };
}

/** Parse one pipeline trace (lazy; traces can be large). */
export async function readTrace(pipeline: Pipeline, rid: RecordId): Promise<Record<string, unknown> | null> {
  const blob = pipeline.traceFiles.get(rid);
  if (!blob) return null;
  try {
    return JSON.parse(await blob.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
