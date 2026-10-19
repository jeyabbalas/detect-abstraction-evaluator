/**
 * Everything the views need, computed once per experiment and gold standard:
 * scores, per-cell outcomes, value-domain and JSON Schema problems, and
 * (lazily) bootstrap intervals.
 */

import { runBootstrap, type BootstrapInput, type BootstrapResult } from './bootstrap';
import { MISSING, Outcome, cellValue, evaluate, isError, outcomeOf, populationIds, type EvaluationContext } from './evaluate';
import { createValidator, validateAll, type SchemaIssue, type Validator } from './validate';
import type {
  AbstractionRecord,
  DuplicateConsistency,
  Experiment,
  Pipeline,
  PopulationName,
  PopulationScores,
  RecordId,
  SchemaModel,
  Scores,
} from './types';

export interface InvalidValue {
  rid: RecordId;
  field: string;
  value: string;
}

export interface PipelineAnalysis {
  pipeline: Pipeline;
  /** Scores on the records every pipeline was run on (`Analysis.commonIds`). */
  scores: Scores;
  /** Per gold record: categorical outcome codes, in schema.categoricalFields order. */
  outcomes: Map<RecordId, Uint8Array>;
  /** Per scored record: number of categorical errors. */
  errorCount: Map<RecordId, number>;
  /** Records in `pipeline.ids` with no prediction. */
  missing: RecordId[];
  /** Categorical values outside the field's domain (missing values excluded). */
  invalid: InvalidValue[];
  /** JSON Schema problems per record; null when validation is unavailable. */
  schemaIssues: Map<RecordId, SchemaIssue[]> | null;
}

export interface Analysis {
  experiment: Experiment;
  ctx: EvaluationContext;
  pipelines: PipelineAnalysis[];
  /** Records every pipeline was run on (∩ of run ids, within the gold standard). */
  commonIds: RecordId[];
  /** True when all pipelines were run on the same records. */
  sameIds: boolean;
  goldSchemaIssues: Map<RecordId, SchemaIssue[]> | null;
  validatorError: string | null;
}

// Validation does not depend on the gold standard: switching it reuses these.
const validators = new WeakMap<SchemaModel, Validator | { error: string }>();
const validated = new WeakMap<Map<RecordId, AbstractionRecord>, Map<RecordId, SchemaIssue[]>>();

function validatorFor(schema: SchemaModel): Validator | { error: string } {
  let v = validators.get(schema);
  if (!v) validators.set(schema, (v = createValidator(schema)));
  return v;
}

function issuesOf(validator: Validator, records: Map<RecordId, AbstractionRecord>): Map<RecordId, SchemaIssue[]> {
  let issues = validated.get(records);
  if (!issues) validated.set(records, (issues = validateAll(validator, records)));
  return issues;
}

export function analyze(experiment: Experiment): Analysis {
  const { schema } = experiment;
  const ctx: EvaluationContext = {
    schema,
    gold: experiment.gold,
    goldIds: experiment.goldIds,
    uniqueIds: experiment.uniqueIds,
    duplicateGroups: experiment.duplicateGroups,
  };
  const fields = schema.categoricalFields;
  const defaults = fields.map((f) => schema.byName.get(f)!.defaultLabel);
  const domains = fields.map((f) => new Set(schema.byName.get(f)!.domain));

  const validator = validatorFor(schema);
  const validatorError = 'error' in validator ? validator.error : null;

  const idSets = experiment.pipelines.map((p) => new Set(p.ids));
  const commonIds = experiment.goldIds.filter((rid) => idSets.every((s) => s.has(rid)));
  const sameIds = idSets.every((s) => s.size === commonIds.length);

  const pipelines: PipelineAnalysis[] = experiment.pipelines.map((pipeline) => {
    const scored = new Set(pipeline.ids);
    const outcomes = new Map<RecordId, Uint8Array>();
    const errorCount = new Map<RecordId, number>();
    const invalid: InvalidValue[] = [];
    for (const rid of experiment.goldIds) {
      const g = experiment.gold.get(rid);
      const p = pipeline.predictions.get(rid);
      const codes = new Uint8Array(fields.length);
      let errors = 0;
      fields.forEach((field, i) => {
        const gv = cellValue(g, field);
        const pv = cellValue(p, field);
        const o = outcomeOf(gv, pv, defaults[i]!);
        codes[i] = o;
        if (isError(o)) errors += 1;
        if (p && pv !== MISSING && !domains[i]!.has(pv)) invalid.push({ rid, field, value: pv });
      });
      outcomes.set(rid, codes);
      if (scored.has(rid)) errorCount.set(rid, errors);
    }
    return {
      pipeline,
      scores: evaluate(ctx, pipeline.predictions, commonIds),
      outcomes,
      errorCount,
      missing: pipeline.ids.filter((rid) => !pipeline.predictions.has(rid)),
      invalid,
      schemaIssues: 'error' in validator ? null : issuesOf(validator, pipeline.predictions),
    };
  });

  return {
    experiment,
    ctx,
    pipelines,
    commonIds,
    sameIds,
    goldSchemaIssues: 'error' in validator ? null : issuesOf(validator, experiment.gold),
    validatorError,
  };
}

/** Record ids of a population within the records every pipeline was run on. */
export function comparisonIds(analysis: Analysis, population: PopulationName): RecordId[] {
  return populationIds(analysis.ctx, population, new Set(analysis.commonIds));
}

/** A pipeline's scores for a population (on the records every pipeline was run on). */
export function scoresFor(analysis: Analysis, index: number, population: PopulationName): PopulationScores | undefined {
  return analysis.pipelines[index]?.scores[population];
}

export function duplicateConsistencyFor(analysis: Analysis, index: number): DuplicateConsistency | null {
  return analysis.pipelines[index]?.scores.duplicate_consistency ?? null;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const bootstrapCache = new WeakMap<Analysis, Map<string, BootstrapResult>>();

/** Build the per-pipeline bootstrap inputs over a fixed list of records. */
export function bootstrapInputs(analysis: Analysis, ids: readonly RecordId[]): BootstrapInput[] {
  const { schema } = analysis.experiment;
  const fields = schema.categoricalFields;
  return analysis.pipelines.map((pa) => {
    const n = ids.length;
    const tp = new Int32Array(n);
    const fp = new Int32Array(n);
    const fn = new Int32Array(n);
    const correct = new Int32Array(n);
    ids.forEach((rid, r) => {
      const codes = pa.outcomes.get(rid)!;
      for (const o of codes) {
        if (o === Outcome.TP) tp[r]! += 1;
        if (o === Outcome.FP || o === Outcome.FPFN) fp[r]! += 1;
        if (o === Outcome.FN || o === Outcome.FPFN) fn[r]! += 1;
        if (o === Outcome.TP || o === Outcome.TN) correct[r]! += 1;
      }
    });
    const perField = fields.map((field) => {
      const labels = new Map<string, number>();
      const index = (v: string) => {
        let i = labels.get(v);
        if (i === undefined) {
          i = labels.size;
          labels.set(v, i);
        }
        return i;
      };
      const gold = new Uint16Array(n);
      const pred = new Uint16Array(n);
      ids.forEach((rid, r) => {
        gold[r] = index(cellValue(analysis.experiment.gold.get(rid), field));
        pred[r] = index(cellValue(pa.pipeline.predictions.get(rid), field));
      });
      return { gold, pred, nLabels: labels.size };
    });
    return { tp, fp, fn, correct, fields: perField };
  });
}

/** Run the bootstrap in a Web Worker when the platform has one, else inline (tests, old browsers). */
async function computeBootstrap(inputs: BootstrapInput[], n: number, B: number): Promise<BootstrapResult> {
  if (typeof Worker === 'undefined') {
    await new Promise((r) => setTimeout(r, 0));
    return runBootstrap(inputs, n, B);
  }
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./bootstrap.worker.ts', import.meta.url), { type: 'module' });
    const w = worker;
    // The inputs are small (a few typed arrays per pipeline), so they are copied, not transferred.
    return await new Promise<BootstrapResult>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<{ ok: boolean; result?: BootstrapResult; error?: string }>) =>
        e.data.ok ? resolve(e.data.result!) : reject(new Error(e.data.error));
      w.onerror = (e) => reject(new Error(e.message || 'The bootstrap worker failed.'));
      w.postMessage({ inputs, n, B });
    });
  } catch (err) {
    console.warn('Bootstrap worker unavailable; computing on the main thread.', err);
    return runBootstrap(inputs, n, B);
  } finally {
    worker?.terminate();
  }
}

const inflight = new WeakMap<Analysis, Map<string, Promise<BootstrapResult | null>>>();

/**
 * Bootstrap intervals for a population (records every pipeline was run on).
 * Computed once per analysis and population (concurrent callers share the work).
 */
export function getBootstrap(analysis: Analysis, population: PopulationName, B = 2000): Promise<BootstrapResult | null> {
  let cache = bootstrapCache.get(analysis);
  if (!cache) bootstrapCache.set(analysis, (cache = new Map()));
  const key = `${population}:${B}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let pending = inflight.get(analysis);
  if (!pending) inflight.set(analysis, (pending = new Map()));
  const running = pending.get(key);
  if (running) return running;
  const ids = comparisonIds(analysis, population);
  if (ids.length < 2) return Promise.resolve(null);
  const job = computeBootstrap(bootstrapInputs(analysis, ids), ids.length, B).then((result) => {
    cache!.set(key, result);
    pending!.delete(key);
    return result;
  });
  pending.set(key, job);
  return job;
}
