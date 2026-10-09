/** Helpers shared by the views: metric metadata, the scope bar, run costs. */

import { comparisonIds, type Analysis, type MetricSource, type PipelineAnalysis } from '../core/analysis';
import type { MetricKey } from '../core/bootstrap';
import { isError } from '../core/evaluate';
import type { Pipeline, PopulationName, RecordId } from '../core/types';
import type { State, StateKey } from '../state';
import { badge, callout, dataTable, infoTip, openDrawer, pipelineLabel, segmented, withTooltip, type Segmented } from '../ui/components';
import { h, render } from '../ui/dom';
import { fmtInt } from '../ui/format';
import { icon } from '../ui/icons';
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

export interface RunCost {
  calls: number | null;
  cachedCalls: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  /** prompt + output tokens. */
  totalTokens: number | null;
  wallSeconds: number | null;
  /** Sum of per-call latencies. */
  callSeconds: number | null;
  retries: number | null;
  failures: number | null;
  model: string | null;
  strategy: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function runCost(p: Pipeline): RunCost {
  const u = p.run?.usage ?? {};
  const prompt = num(u.prompt_tokens);
  const output = num(u.output_tokens);
  const model = p.run?.settings?.model;
  return {
    calls: num(u.calls),
    cachedCalls: num(u.cached_calls),
    promptTokens: prompt,
    outputTokens: output,
    thoughtTokens: num(u.thought_tokens),
    totalTokens: prompt !== null || output !== null ? (prompt ?? 0) + (output ?? 0) : null,
    wallSeconds: num(p.run?.wall_seconds),
    callSeconds: num(u.seconds),
    retries: num(u.retries),
    failures: p.run?.failures && typeof p.run.failures === 'object' ? Object.keys(p.run.failures).length : num(u.failures),
    model: typeof model === 'string' ? model : null,
    strategy: typeof p.run?.strategy === 'string' ? p.run.strategy : null,
  };
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
      const cost = runCost(pa.pipeline);
      const detail = [cost.strategy, cost.model].filter(Boolean).join(' · ');
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
export function scopeBar(ctx: ViewContext, opts: { source?: boolean; legend?: boolean } = {}): ScopeBar {
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

  // The switch only matters when the two sources can disagree.
  const hasReported = analysis.pipelines.some((pa) => pa.pipeline.reportedScores);
  const showSource = opts.source !== false && hasReported && (!analysis.allReportedMatch || !analysis.sameIds);
  const src: Segmented<MetricSource> | null = showSource
    ? segmented<MetricSource>({
        label: 'Metric source',
        value: store.get().source,
        options: [
          { value: 'reported', label: 'scores.json', title: 'Show the metrics each pipeline reported in its scores.json' },
          { value: 'recomputed', label: 'Recomputed', title: 'Show metrics recomputed in the browser on the records every pipeline was run on' },
        ],
        onChange: (source) => store.set({ source }),
      })
    : null;

  const status = verificationBadge(analysis);
  const notes = h('div', { class: 'scope-notes' });
  if (!analysis.sameIds) {
    notes.appendChild(
      callout(
        'warning',
        `Pipelines were run on different records. Recomputed metrics compare them on the ${fmtInt(analysis.commonIds.length)} records every pipeline was run on; scores.json values cover each pipeline's own records.`,
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
      src ? h('div', { class: 'field' }, h('span', null, 'Metrics'), src.el) : null,
      status,
      h('div', { class: 'spacer' }),
      opts.legend !== false ? pipelineLegend(analysis) : null,
    ),
    notes,
  );

  return {
    el,
    update(state, changed) {
      if (changed.has('population')) pop.set(state.population);
      if (changed.has('source')) src?.set(state.source);
    },
  };
}

/** Whether the browser's recomputation reproduces each scores.json. */
export function verificationBadge(analysis: Analysis): HTMLElement {
  const withScores = analysis.pipelines.filter((pa) => pa.differences !== null);
  if (!withScores.length) {
    return withTooltip(badge('Computed in browser', 'outline', 'info'), 'No pipeline has a scores.json; every metric is computed in the browser from predictions and the gold standard.');
  }
  const mismatched = withScores.filter((pa) => pa.differences!.length);
  if (!mismatched.length) {
    return withTooltip(
      badge(`Verified against scores.json`, 'good', 'checkCircle'),
      `Recomputing every metric in the browser from predictions.json and the gold standard reproduces the scores.json of all ${withScores.length} pipeline${withScores.length === 1 ? '' : 's'} exactly.`,
    );
  }
  const btn = h(
    'button',
    { type: 'button', class: 'badge warning', style: { border: '0', cursor: 'pointer' } },
    icon('alert'),
    `${mismatched.length} scores.json differ${mismatched.length === 1 ? 's' : ''}`,
  );
  btn.addEventListener('click', () => {
    openDrawer({
      title: 'scores.json vs. recomputed metrics',
      subtitle: 'The browser recomputes every metric from predictions.json and the gold standard. These values disagree with what the pipeline reported — usually because the gold standard or the scorer changed after the run.',
      body: mismatched.map((pa) => {
        const t = dataTable(
          [
            { key: 'path', label: 'Metric', value: (d) => d.path, cell: (d) => h('code', null, d.path) },
            { key: 'reported', label: 'scores.json', value: (d) => String(d.reported), numeric: true },
            { key: 'computed', label: 'Recomputed', value: (d) => String(d.computed), numeric: true },
          ],
          pa.differences!,
          { sortable: false },
        );
        return h('section', null, h('h3', { style: { fontSize: '14px', marginBottom: '8px' } }, pipelineLabel(pa.pipeline)), t.wrap);
      }),
    });
  });
  return btn;
}

/** Re-render helper for views that rebuild a region on state changes. */
export function swap(host: HTMLElement, content: HTMLElement | null): void {
  render(host, content);
}
