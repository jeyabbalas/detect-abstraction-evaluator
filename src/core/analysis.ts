/**
 * Everything the views need, computed once per loaded experiment:
 * recomputed scores (checked against each scores.json), per-cell outcomes,
 * value-domain and JSON Schema problems, and (lazily) bootstrap intervals.
 */

import { runBootstrap, type BootstrapInput, type BootstrapResult } from './bootstrap';
import {
  MISSING,
  Outcome,
  cellValue,
  compareScores,
  evaluate,
  isError,
  outcomeOf,
  populationIds,
  type EvaluationContext,
  type ScoreDifference,
} from './evaluate';
import { createValidator, validateAll, type SchemaIssue } from './validate';
import type { Experiment, Pipeline, PopulationName, PopulationScores, RecordId, Scores } from './types';

export type MetricSource = 'reported' | 'recomputed';

export interface InvalidValue {
  rid: RecordId;
  field: string;
  value: string;
}

export interface PipelineAnalysis {
  pipeline: Pipeline;
  /** Scores recomputed on the pipeline's own ids — the same scope as its scores.json. */
  computed: Scores;
  /** Recomputed vs reported differences; null when there is no scores.json. */
  differences: ScoreDifference[] | null;
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
  /** Scores of every pipeline on `commonIds` (identical to `computed` when sameIds). */
  commonScores: Scores[];
  /** True when every pipeline has a scores.json that matches its recomputation. */
  allReportedMatch: boolean;
  /** Source to show by default. */
  defaultSource: MetricSource;
  goldSchemaIssues: Map<RecordId, SchemaIssue[]> | null;
  validatorError: string | null;
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

  const validator = createValidator(schema);
  const validatorError = 'error' in validator ? validator.error : null;
  const canValidate = !('error' in validator);

  const pipelines: PipelineAnalysis[] = experiment.pipelines.map((pipeline) => {
    const computed = evaluate(ctx, pipeline.predictions, pipeline.ids);
    const differences = pipeline.reportedScores ? compareScores(pipeline.reportedScores, computed) : null;
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
      computed,
      differences,
      outcomes,
      errorCount,
      missing: pipeline.ids.filter((rid) => !pipeline.predictions.has(rid)),
      invalid,
      schemaIssues: canValidate ? validateAll(validator, pipeline.predictions) : null,
    };
  });

  const idSets = experiment.pipelines.map((p) => new Set(p.ids));
  const commonIds = experiment.goldIds.filter((rid) => idSets.every((s) => s.has(rid)));
  const sameIds = idSets.every((s) => s.size === commonIds.length);
  const commonScores = pipelines.map((pa) => (sameIds ? pa.computed : evaluate(ctx, pa.pipeline.predictions, commonIds)));
  const allReportedMatch = pipelines.every((pa) => pa.differences !== null && pa.differences.length === 0);
  const allReported = pipelines.every((pa) => pa.pipeline.reportedScores !== null);

  return {
    experiment,
    ctx,
    pipelines,
    commonIds,
    sameIds,
    commonScores,
    allReportedMatch,
    defaultSource: allReported && sameIds ? 'reported' : 'recomputed',
    goldSchemaIssues: canValidate ? validateAll(validator, experiment.gold) : null,
    validatorError,
  };
}

/** Record ids of a population within the records every pipeline was run on. */
export function comparisonIds(analysis: Analysis, population: PopulationName): RecordId[] {
  return populationIds(analysis.ctx, population, new Set(analysis.commonIds));
}

/** The population scores to display for a pipeline under a metric source. */
export function scoresFor(
  analysis: Analysis,
  index: number,
  source: MetricSource,
  population: PopulationName,
): PopulationScores | undefined {
  const pa = analysis.pipelines[index]!;
  if (source === 'reported' && pa.pipeline.reportedScores?.[population]) return pa.pipeline.reportedScores[population];
  return analysis.commonScores[index]?.[population];
}

export function duplicateConsistencyFor(analysis: Analysis, index: number, source: MetricSource) {
  const pa = analysis.pipelines[index]!;
  if (source === 'reported' && pa.pipeline.reportedScores?.duplicate_consistency) {
    return pa.pipeline.reportedScores.duplicate_consistency;
  }
  return analysis.commonScores[index]?.duplicate_consistency ?? null;
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

/**
 * Bootstrap intervals for a population (records every pipeline was run on).
 * Cached per analysis; yields to the event loop first so the UI can paint.
 */
export async function getBootstrap(analysis: Analysis, population: PopulationName, B = 2000): Promise<BootstrapResult | null> {
  let cache = bootstrapCache.get(analysis);
  if (!cache) bootstrapCache.set(analysis, (cache = new Map()));
  const key = `${population}:${B}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const ids = comparisonIds(analysis, population);
  if (ids.length < 2) return null;
  await new Promise((r) => setTimeout(r, 0));
  const result = runBootstrap(bootstrapInputs(analysis, ids), ids.length, B);
  cache.set(key, result);
  return result;
}
