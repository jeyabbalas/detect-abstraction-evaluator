/**
 * Parses an uploaded experiment directory into an {@link Experiment}.
 * Problems are collected as issues rather than thrown, unless the experiment
 * cannot be shown at all (no schema, no pipelines, no gold standard).
 *
 * The gold standard is applied last and can be swapped for another one
 * ({@link withGoldStandard}) without reading the folder again.
 */

import { buildSchemaModel, type SchemaInput } from './schema';
import type {
  AbstractionRecord,
  Experiment,
  GoldFile,
  LoadIssue,
  Pipeline,
  PipelineConfig,
  PipelineSummary,
  RecordId,
  RecordNotes,
  RunFailure,
  VirtualFile,
} from './types';
import type { FileSet } from './vfs';

export class LoadError extends Error {}

/** The folder has no gold_standard/*.json; one can be added from disk and the folder loaded again. */
export class MissingGoldError extends LoadError {}

const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const basename = (path: string): string => path.split('/').pop()!;
const stem = (path: string): string => basename(path).replace(/\.[^.]+$/, '');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Integer record id from a file stem or a record value, else null. */
export function toRecordId(value: unknown): RecordId | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

async function readJson(file: { path: string; blob: Blob }): Promise<unknown> {
  const text = await file.blob.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LoadError(`${file.path} is not valid JSON (${(err as Error).message}).`);
  }
}

/** Records from an array, `{records: [...]}`, or an object of records. */
function recordsFrom(data: unknown, idField: string, source: string, issues: LoadIssue[], pipeline?: string) {
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (isObj(data)) list = Array.isArray(data.records) ? data.records : Object.values(data);
  else throw new LoadError(`${source} does not hold a JSON array of records.`);
  const map = new Map<RecordId, AbstractionRecord>();
  let skipped = 0;
  for (const item of list) {
    if (!isObj(item)) {
      skipped += 1;
      continue;
    }
    const rid = toRecordId(item[idField]);
    if (rid === null) {
      skipped += 1;
      continue;
    }
    if (map.has(rid)) issues.push({ level: 'warning', message: `${source}: duplicate ${idField} ${rid}; the last one is used.`, pipeline });
    map.set(rid, item);
  }
  if (skipped) issues.push({ level: 'warning', message: `${source}: ${skipped} entries without a valid ${idField} were skipped.`, pipeline });
  return map;
}

/** Identical-text groups over all reports, lowest id first. */
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

/** Hex SHA-256 of a file's bytes, or null where Web Crypto is unavailable (e.g. an insecure origin). */
export async function sha256Hex(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Records named by summary.json `failures` / `unreadable_records`: record ids,
 * report file names, objects with a `record_id`, or an object keyed by id.
 */
export function failuresFrom(value: unknown, fallback: string): RunFailure[] {
  const entries: [unknown, unknown][] = Array.isArray(value)
    ? value.map((v) => [v, null])
    : isObj(value)
      ? Object.entries(value)
      : [];
  const out: RunFailure[] = [];
  for (const [item, detail] of entries) {
    let rid = toRecordId(item) ?? (typeof item === 'string' ? toRecordId(stem(item)) : null);
    let message = typeof detail === 'string' && detail ? detail : fallback;
    if (rid === null && isObj(item)) {
      rid = toRecordId(item.record_id ?? item.id);
      const m = item.error ?? item.message ?? item.reason;
      if (typeof m === 'string' && m) message = m;
    }
    if (rid !== null) out.push({ rid, message });
  }
  return out;
}

/** summary.json `issues` keyed by record id. */
function notesFrom(issues: unknown): Map<RecordId, RecordNotes> {
  const out = new Map<RecordId, RecordNotes>();
  if (!isObj(issues)) return out;
  for (const [key, value] of Object.entries(issues)) {
    const rid = toRecordId(key);
    if (rid !== null && isObj(value) && Object.keys(value).length) out.set(rid, value as RecordNotes);
  }
  return out;
}

export interface LoadProgress {
  stage: string;
  done?: number;
  total?: number;
}

/** The gold-standard file used by default: one named like "gold", then natural order. */
function defaultGold(files: readonly GoldFile[]): GoldFile {
  return [...files].sort((a, b) => Number(!/gold/i.test(a.name)) - Number(!/gold/i.test(b.name)) || naturalCompare(a.name, b.name))[0]!;
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
  const rootFile = dictFiles.find((f) => f.path === `data_dictionary/${schema.rootName}`);
  const schemaSha256 = rootFile ? await sha256Hex(rootFile.blob) : null;

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
      // Universal newlines.
      reports.set(rid, (await f.blob.text()).replace(/\r\n?/g, '\n'));
    }),
  );
  if (!reportFiles.length) issues.push({ level: 'warning', message: 'No pathology_reports/*.txt found: report text and the unique-text population are unavailable.' });
  if (badNames.length) issues.push({ level: 'warning', message: `${badNames.length} report file(s) are not named <record_id>.txt (e.g. ${badNames[0]}); skipped.` });
  const groups = duplicateGroups(reports);
  const groupOf = new Map<RecordId, RecordId[]>();
  for (const g of groups) for (const rid of g) groupOf.set(rid, g);
  // Without report texts the unique population is empty.
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
    const optionalJson = async (rel: string): Promise<Record<string, unknown> | null> => {
      const file = at(rel);
      if (!file) return null;
      try {
        const data = await readJson(file);
        if (isObj(data)) return data;
        issues.push({ level: 'warning', message: `${file.path} does not hold a JSON object; ignored.`, pipeline: name });
      } catch (err) {
        issues.push({ level: 'warning', message: (err as Error).message, pipeline: name });
      }
      return null;
    };
    const predFile = at('predictions.json');
    if (!predFile) {
      issues.push({ level: 'warning', message: `abstractions/${name}/ has no predictions.json; skipped.`, pipeline: name });
      done += 1;
      continue;
    }
    try {
      const predictions = recordsFrom(await readJson(predFile), schema.idField, predFile.path, issues, name);
      const summary = (await optionalJson('summary.json')) as PipelineSummary | null;
      const config = ((await optionalJson('config.json')) ?? (isObj(summary?.config) ? summary.config : null)) as PipelineConfig | null;
      if (!config) issues.push({ level: 'info', message: `abstractions/${name}/ has no config.json; its model and settings are unknown.`, pipeline: name });
      if (!summary) issues.push({ level: 'info', message: `abstractions/${name}/ has no summary.json; its calls, tokens and time are unknown.`, pipeline: name });

      const recordFiles = new Map<RecordId, Blob>();
      for (const f of dirFiles) {
        const rel = f.path.slice(`abstractions/${name}/`.length);
        if (rel.startsWith('records/') && /\.json$/i.test(rel)) {
          const rid = toRecordId(stem(rel));
          if (rid !== null) recordFiles.set(rid, f.blob);
        }
      }

      const failed = failuresFrom(summary?.failures, 'The pipeline failed on this record.');
      const unreadable = failuresFrom(summary?.unreadable_records, 'The pipeline could not read this record.');
      if (failed.length) {
        issues.push({ level: 'warning', message: `${name}: summary.json lists ${failed.length} failed record(s) (e.g. ${failed.slice(0, 5).map((f) => f.rid).join(', ')}).`, pipeline: name });
      }
      if (unreadable.length) {
        issues.push({ level: 'warning', message: `${name}: summary.json lists ${unreadable.length} unreadable record(s) (e.g. ${unreadable.slice(0, 5).map((f) => f.rid).join(', ')}).`, pipeline: name });
      }
      const ranOn = typeof config?.schema_sha256 === 'string' ? config.schema_sha256.toLowerCase() : null;
      if (ranOn && schemaSha256 && ranOn !== schemaSha256) {
        issues.push({
          level: 'warning',
          message: `${name} was run with a different data dictionary (schema_sha256 ${ranOn.slice(0, 12)}…) than data_dictionary/${schema.rootName} (${schemaSha256.slice(0, 12)}…).`,
          pipeline: name,
        });
      }

      const attempted = [...new Set<RecordId>([...predictions.keys(), ...recordFiles.keys(), ...failed.map((f) => f.rid), ...unreadable.map((f) => f.rid)])].sort((a, b) => a - b);
      pipelines.push({
        id: name,
        name,
        index: pipelines.length,
        config,
        summary,
        predictions,
        recordFiles,
        notes: notesFrom(summary?.issues),
        failures: [...failed, ...unreadable],
        attempted,
        ids: attempted,
      });
    } catch (err) {
      issues.push({ level: 'error', message: `${name}: ${(err as Error).message}`, pipeline: name });
    }
    done += 1;
  }
  if (!pipelines.length) {
    throw new LoadError('No pipelines found: add one folder per pipeline under abstractions/, each with a predictions.json.');
  }

  // --- gold standard ---------------------------------------------------------
  const goldFiles: GoldFile[] = under('gold_standard')
    .filter((f) => /\.json$/i.test(f.path))
    .map((f) => ({ name: f.path.slice('gold_standard/'.length), blob: f.blob }))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!goldFiles.length) {
    throw new MissingGoldError('No gold standard: add the gold-standard records (one JSON array) under gold_standard/, or choose a gold-standard file.');
  }

  onProgress?.({ stage: 'Reading the gold standard' });
  const base: Experiment = {
    name: set.name,
    schema,
    schemaSha256,
    goldFiles,
    goldFileName: '',
    gold: new Map(),
    goldIds: [],
    reports,
    duplicateGroups: groups,
    groupOf,
    uniqueIds,
    pipelines,
    issues,
    baseIssues: issues,
  };
  return withGoldStandard(base, defaultGold(goldFiles));
}

/** `name`, or `name (2)`, `name (3)`… — the first that `taken` does not hold. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let k = 2; ; k += 1) if (!taken.has(`${name} (${k})`)) return `${name} (${k})`;
}

/**
 * The experiment scored against another gold standard: one of its `goldFiles`,
 * or a new file (added to them; a clashing name gets a numeric suffix).
 * Throws a LoadError when the file holds no usable records.
 */
export async function withGoldStandard(experiment: Experiment, file: GoldFile): Promise<Experiment> {
  let goldFiles = experiment.goldFiles;
  let chosen = goldFiles.find((g) => g === file) ?? goldFiles.find((g) => g.name === file.name && g.blob === file.blob);
  if (!chosen) {
    chosen = { name: freeName(file.name, new Set(goldFiles.map((g) => g.name))), blob: file.blob };
    goldFiles = [...goldFiles, chosen];
  }
  const { schema, reports } = experiment;
  const issues: LoadIssue[] = [];
  const source = `gold_standard/${chosen.name}`;
  const gold = recordsFrom(await readJson({ path: source, blob: chosen.blob }), schema.idField, source, issues);
  if (!gold.size) throw new LoadError(`${source} holds no records with a ${schema.idField}.`);
  const goldIds = [...gold.keys()].sort((a, b) => a - b);

  const missingFields = new Set<string>();
  for (const rec of gold.values()) for (const f of schema.fields) if (!(f.name in rec)) missingFields.add(f.name);
  if (missingFields.size) {
    issues.push({
      level: 'warning',
      message: `Some gold records lack ${missingFields.size} variable(s) (e.g. ${[...missingFields].slice(0, 3).join(', ')}); they are scored as '<missing>'.`,
    });
  }
  const withoutReport = goldIds.filter((rid) => !reports.has(rid));
  if (reports.size && withoutReport.length) {
    issues.push({ level: 'warning', message: `${withoutReport.length} gold record(s) have no report text (e.g. ${withoutReport.slice(0, 5).join(', ')}).` });
  }

  // Records outside the gold standard: one note when every pipeline has the same ones.
  const outside = experiment.pipelines.map((p) => p.attempted.filter((rid) => !gold.has(rid)));
  const shared = outside.every((o) => o.join() === outside[0]!.join());
  if (shared && outside[0]!.length) {
    issues.push({
      level: 'info',
      message: `${outside[0]!.length} of the abstracted records are not in the gold standard and are not scored (e.g. ${outside[0]!.slice(0, 5).join(', ')}).`,
    });
  }

  const pipelines = experiment.pipelines.map((p, k): Pipeline => {
    const ids = p.attempted.filter((rid) => gold.has(rid));
    const out = outside[k]!;
    if (!shared && out.length) {
      issues.push({ level: 'info', message: `${p.name}: ${out.length} of its records are not in the gold standard and are not scored (e.g. ${out.slice(0, 5).join(', ')}).`, pipeline: p.name });
    }
    const missing = ids.filter((rid) => !p.predictions.has(rid));
    if (missing.length) {
      issues.push({
        level: 'warning',
        message: `${p.name}: ${missing.length} record(s) have no prediction (e.g. ${missing.slice(0, 5).join(', ')}); they are scored as wrong.`,
        pipeline: p.name,
      });
    }
    return { ...p, ids };
  });
  if (!pipelines.some((p) => p.ids.length)) {
    throw new LoadError(`None of the pipelines' records is in ${source}: check that its record_id values match the abstracted records.`);
  }

  return {
    ...experiment,
    goldFiles,
    goldFileName: chosen.name,
    gold,
    goldIds,
    pipelines,
    issues: [...experiment.baseIssues, ...issues],
  };
}

/** Parse one pipeline's record file (`records/<record_id>.json`; lazy, as they can be large). */
export async function readRecordFile(pipeline: Pipeline, rid: RecordId): Promise<Record<string, unknown> | null> {
  const blob = pipeline.recordFiles.get(rid);
  if (!blob) return null;
  try {
    const data = JSON.parse(await blob.text()) as unknown;
    return isObj(data) ? data : null;
  } catch {
    return null;
  }
}
