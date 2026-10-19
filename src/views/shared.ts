/** Helpers shared by the views: metric metadata, the scope bar, run usage. */

import { comparisonIds, type Analysis, type PipelineAnalysis } from '../core/analysis';
import type { MetricKey } from '../core/bootstrap';
import { isError } from '../core/evaluate';
import type { Pipeline, PopulationName, RecordId } from '../core/types';
import type { State, StateKey } from '../state';
import { badge, callout, infoTip, pipelineLabel, segmented, withTooltip, type Segmented } from '../ui/components';
import { h, render } from '../ui/dom';
import { fmtInt } from '../ui/format';
import type { ViewContext } from './types';

export interface MetricMeta {
  label: string;
  short: string;
  help: string;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  informative_f1: {
    label: 'Informative F1',
    short: 'F1',
    help: 'Headline metric. Micro F1 over informative cells: a TP is a correct prediction whose gold value is not the default label; an FP is a wrong prediction that is not the default label; an FN is a wrong prediction whose gold value is not the default label. Agreement on default labels ("Cannot determine", "Not identified", "No") is not rewarded.',
  },
  informative_precision: {
    label: 'Precision',
    short: 'Precision',
    help: 'Informative precision: TP / (TP + FP). Low precision means over-calling — informative labels where the gold standard has none.',
  },
  informative_recall: {
    label: 'Recall',
    short: 'Recall',
    help: 'Informative recall: TP / (TP + FN). Low recall means misses — default labels where the gold standard is informative.',
  },
  mean_field_macro_f1: {
    label: 'Mean field macro-F1',
    short: 'Macro-F1',
    help: 'For each categorical field, the macro F1 over the labels present in gold or prediction; then the mean over fields. Weights every field and every rare class equally.',
  },
  cell_accuracy: {
    label: 'Cell accuracy',
    short: 'Accuracy',
    help: 'Share of categorical cells predicted exactly. Inflated by agreement on default labels, which dominate sparse records.',
  },
  error_free_rate: {
    label: 'Error-free records',
    short: 'Error-free',
    help: 'Share of records whose categorical variables are all exactly right.',
  },
};

export const POPULATION_HELP =
  'Unique reports: each distinct report text is scored once, using the lowest record_id of its identical-text group (the headline population). All records: every record, so duplicated texts count once per copy.';

/** Records with no categorical error, as a share of `ids`. */
export function errorFreeRate(pa: PipelineAnalysis, ids: readonly RecordId[]): number | null {
  if (!ids.length) return null;
  let ok = 0;
  for (const rid of ids) {
    const codes = pa.outcomes.get(rid);
    if (codes && !codes.some((o) => isError(o))) ok += 1;
  }
  return ok / ids.length;
}

/** What a run used, from its summary.json (self-hosted models: calls, tokens and time, not money). */
export interface RunCost {
  /** Records the run abstracted. */
  records: number | null;
  calls: number | null;
  repairRounds: number | null;
  promptTokens: number | null;
  /** Completion tokens, reasoning included. */
  completionTokens: number | null;
  /** prompt + completion tokens. */
  totalTokens: number | null;
  /** Summed model-call time. */
  modelSeconds: number | null;
  /** Replies cut off at the token limit (finish_reason "length"). */
  truncated: number | null;
  /** Records the run failed on or could not read. */
  failures: number;
  model: string | null;
  strategy: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function runCost(p: Pipeline): RunCost {
  const s = p.summary ?? {};
  const prompt = num(s.prompt_tokens);
  const completion = num(s.completion_tokens);
  const reasons = s.finish_reasons && typeof s.finish_reasons === 'object' ? s.finish_reasons : null;
  return {
    records: num(s.records),
    calls: num(s.calls),
    repairRounds: num(s.repair_rounds),
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt !== null || completion !== null ? (prompt ?? 0) + (completion ?? 0) : null,
    modelSeconds: num(s.model_seconds),
    truncated: reasons ? (num(reasons.length) ?? 0) : null,
    failures: p.failures.length,
    model: typeof p.config?.model === 'string' ? p.config.model : null,
    strategy: typeof p.config?.pipeline === 'string' ? p.config.pipeline : null,
  };
}

/** "progressive · Qwen3.5-9B" (either part may be missing). */
export function pipelineDetail(p: Pipeline): string {
  const c = runCost(p);
  return [c.strategy, c.model].filter(Boolean).join(' · ');
}

export function populationCount(analysis: Analysis, population: PopulationName): number {
  return comparisonIds(analysis, population).length;
}

// ------------------------------------------------------------------ legend

export function pipelineLegend(analysis: Analysis): HTMLElement {
  return h(
    'div',
    { class: 'legend', 'aria-label': 'Pipelines' },
    analysis.pipelines.map((pa) => {
      const detail = pipelineDetail(pa.pipeline);
      return withTooltip(h('span', { class: 'legend-item', tabIndex: 0 }, pipelineLabel(pa.pipeline)), () =>
        h('div', null, h('div', { class: 'tt-title' }, pa.pipeline.name), detail ? h('div', { class: 'tt-muted' }, detail) : null),
      );
    }),
  );
}

// --------------------------------------------------------------- scope bar

export interface ScopeBar {
  el: HTMLElement;
  update(state: State, changed: Set<StateKey>): void;
}

/** One row of controls that scope everything below it. */
export function scopeBar(ctx: ViewContext, opts: { legend?: boolean } = {}): ScopeBar {
  const { analysis, store } = ctx;
  const nUnique = populationCount(analysis, 'unique');
  const nAll = populationCount(analysis, 'all');
  const pop: Segmented<PopulationName> = segmented<PopulationName>({
    label: 'Population',
    value: store.get().population,
    options: [
      { value: 'unique', label: ['Unique reports', h('span', { class: 'count' }, fmtInt(nUnique))], disabled: !nUnique },
      { value: 'all', label: ['All records', h('span', { class: 'count' }, fmtInt(nAll))] },
    ],
    onChange: (population) => store.set({ population }),
  });

  const notes = h('div', { class: 'scope-notes' });
  if (!analysis.sameIds) {
    notes.appendChild(
      callout(
        'warning',
        `Pipelines were run on different records. They are compared on the ${fmtInt(analysis.commonIds.length)} gold-standard records every pipeline was run on.`,
      ),
    );
  }

  const el = h(
    'div',
    { class: 'scope' },
    h(
      'div',
      { class: 'scope-bar' },
      h('div', { class: 'field' }, h('span', null, 'Population'), pop.el, infoTip(POPULATION_HELP)),
      goldBadge(analysis),
      h('div', { class: 'spacer' }),
      opts.legend !== false ? pipelineLegend(analysis) : null,
    ),
    notes,
  );

  return {
    el,
    update(state, changed) {
      if (changed.has('population')) pop.set(state.population);
    },
  };
}

/** The gold standard the metrics are scored against. */
export function goldBadge(analysis: Analysis): HTMLElement {
  const { experiment } = analysis;
  return withTooltip(
    h('span', { class: 'scope-gold' }, badge(['Gold: ', h('span', { class: 'scope-gold-name' }, experiment.goldFileName)], 'outline', 'scale')),
    () =>
      h(
        'div',
        null,
        h('div', { class: 'tt-title' }, 'Gold standard'),
        h('div', null, `${experiment.goldFileName} · ${fmtInt(experiment.goldIds.length)} records`),
        h(
          'div',
          { class: 'tt-muted' },
          'Every metric is computed in the browser from the predictions and this gold standard. Switch it from the header to re-score.',
        ),
      ),
  );
}

/** Re-render helper for views that rebuild a region on state changes. */
export function swap(host: HTMLElement, content: HTMLElement | null): void {
  render(host, content);
}
