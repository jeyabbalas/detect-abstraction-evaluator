/** Leaderboard: every pipeline on the headline metrics, its errors and what the run cost. */

import type { BootstrapResult, MetricKey } from '../../core/bootstrap';
import { downloadText, infoTip, pipelineLabel, tooltipBody, withTooltip } from '../../ui/components';
import { h, render, type Child } from '../../ui/dom';
import { fmtCI, fmtCompact, fmtDuration, fmtInt, fmtMetric } from '../../ui/format';
import { icon } from '../../ui/icons';
import { METRIC_META } from '../shared';
import { cardShell } from './dom';
import { bestIndices, leaderboardCsv, metricValue, type PipelineRow, type Snapshot } from './model';

export interface BootView {
  result: BootstrapResult | null;
  state: 'pending' | 'ready' | 'none';
}

export const ERRORS_HELP =
  'Informative errors in the population. FP (over-call): an informative label where the gold standard has the default label. FN (miss): the default label where the gold standard is informative. A wrong informative label counts once on each side.';

export const DUP_HELP =
  'For report texts that occur more than once, the share of categorical cells on which every copy received the same prediction. It measures consistency, not correctness, and does not depend on the population.';

interface Col {
  key: string;
  label: string;
  help?: string;
  /** Hairline before this column (starts a group). */
  sep?: boolean;
  cell: (r: PipelineRow, best: boolean) => Child;
  /** How to find the best cell: raw values, direction and the formatter the cell displays them with. */
  best?: { value: (r: PipelineRow) => number | null | undefined; dir: 'max' | 'min'; format?: (v: number) => string };
}

const NBSP = '\u00a0';
const missing = () => h('span', { class: 'muted' }, '—');

/** Header text whose last word stays glued to its info tip. */
function headLabel(label: string, help?: string): Child {
  if (!help) return label;
  const i = label.lastIndexOf(' ');
  return [
    i > 0 ? label.slice(0, i + 1) : null,
    h('span', { class: 'ov-nowrap' }, i > 0 ? label.slice(i + 1) : label, infoTip(help, `About ${label}`)),
  ];
}

/** A value with a hover/focus breakdown. */
function tipped(text: string, body: () => Child): HTMLElement {
  return withTooltip(h('span', { class: 'ov-tip', tabIndex: 0 }, text), body);
}

function metricCol(key: MetricKey, opts: { label?: string; sub?: (r: PipelineRow) => Child; help?: string } = {}): Col {
  return {
    key,
    label: opts.label ?? METRIC_META[key].label,
    help: opts.help ?? METRIC_META[key].help,
    best: { value: (r) => metricValue(r, key), dir: 'max', format: fmtMetric },
    cell: (r, best) => {
      const v = metricValue(r, key);
      return [
        v === null ? missing() : h('div', { class: ['ov-v', best && 'best'] }, fmtMetric(v)),
        opts.sub ? h('div', { class: 'ov-detail' }, opts.sub(r)) : null,
      ];
    },
  };
}

function columns(boot: BootView): Col[] {
  const ci = (r: PipelineRow): Child => {
    if (boot.state !== 'ready') return NBSP;
    const iv = boot.result?.intervals[r.pos]?.informative_f1;
    return iv && iv.lo !== null && iv.hi !== null ? fmtCI(iv.lo, iv.hi) : NBSP;
  };
  return [
    metricCol('informative_f1', { sub: ci, help: `${METRIC_META.informative_f1.help} Beneath: 95% bootstrap interval.` }),
    metricCol('informative_precision'),
    metricCol('informative_recall'),
    metricCol('mean_field_macro_f1', { label: 'Macro-F1' }),
    metricCol('cell_accuracy', { label: 'Accuracy' }),
    metricCol('error_free_rate', {
      label: 'Error\u2011free records',
      help: `${METRIC_META.error_free_rate.help} Beneath: records without an error / records.`,
      sub: (r) => (r.errorFree === null ? NBSP : `${fmtInt(r.errorFreeCount)}/${fmtInt(r.n)}`),
    }),
    {
      key: 'errors',
      label: 'Errors',
      help: ERRORS_HELP,
      sep: true,
      best: { value: (r) => (r.summary ? r.summary.fp + r.summary.fn : null), dir: 'min' },
      cell: (r, best) =>
        r.summary
          ? h(
              'div',
              { class: ['ov-errs', best && 'best'] },
              h('span', { class: 'k' }, h('span', { class: 'ov-key fp', 'aria-hidden': 'true' }), 'FP'),
              h('span', null, fmtInt(r.summary.fp)),
              h('span', { class: 'k' }, h('span', { class: 'ov-key fn', 'aria-hidden': 'true' }), 'FN'),
              h('span', null, fmtInt(r.summary.fn)),
            )
          : missing(),
    },
    {
      key: 'dup',
      label: 'Dup. agreement',
      help: DUP_HELP,
      best: { value: (r) => r.dup?.agreement, dir: 'max', format: fmtMetric },
      cell: (r, best) => {
        const d = r.dup;
        if (!d || d.agreement === null) return missing();
        const unstable = Object.keys(d.unstable_fields).length;
        return h(
          'div',
          { class: ['ov-v', best && 'best'] },
          tipped(fmtMetric(d.agreement), () =>
            tooltipBody('Duplicate agreement', [
              ['Same answer on every copy', `${fmtInt(Math.round(d.agreement! * d.cells))} of ${fmtInt(d.cells)} cells`],
              ['Variables that varied', fmtInt(unstable)],
            ]),
          ),
        );
      },
    },
    {
      key: 'calls',
      label: 'LLM calls',
      help: 'Model requests made during the run (run.json usage.calls), cached calls included.',
      sep: true,
      best: { value: (r) => r.cost.calls, dir: 'min', format: fmtInt },
      cell: (r, best) => {
        const c = r.cost;
        if (c.calls === null) return missing();
        const rows: [Child, Child][] = [['Calls', fmtInt(c.calls)]];
        if (c.cachedCalls !== null) rows.push(['Cached', fmtInt(c.cachedCalls)]);
        if (c.retries !== null) rows.push(['Retries', fmtInt(c.retries)]);
        if (c.failures !== null) rows.push(['Failures', fmtInt(c.failures)]);
        if (c.callSeconds !== null) rows.push(['Summed call time', fmtDuration(c.callSeconds)]);
        return h('div', { class: ['ov-v', best && 'best'] }, tipped(fmtInt(c.calls), () => tooltipBody('LLM calls', rows)));
      },
    },
    {
      key: 'tokens',
      label: 'Tokens',
      help: 'Prompt + output tokens (run.json usage). Hover a value for the breakdown.',
      best: { value: (r) => r.cost.totalTokens, dir: 'min', format: fmtCompact },
      cell: (r, best) => {
        const c = r.cost;
        if (c.totalTokens === null) return missing();
        return h(
          'div',
          { class: ['ov-v', best && 'best'] },
          tipped(fmtCompact(c.totalTokens), () =>
            tooltipBody(
              'Tokens',
              [
                ['Prompt', fmtInt(c.promptTokens)],
                ['Output', fmtInt(c.outputTokens)],
                ['Thinking', fmtInt(c.thoughtTokens)],
                ['Total', fmtInt(c.totalTokens)],
              ],
              'Total = prompt + output, as run.json reports them.',
            ),
          ),
        );
      },
    },
    {
      key: 'wall',
      label: 'Wall time',
      help: 'Wall-clock duration of the run (run.json wall_seconds).',
      best: { value: (r) => r.cost.wallSeconds, dir: 'min', format: fmtDuration },
      cell: (r, best) => (r.cost.wallSeconds === null ? missing() : h('div', { class: ['ov-v', best && 'best'] }, fmtDuration(r.cost.wallSeconds))),
    },
  ];
}

function pipelineCell(r: PipelineRow): Child {
  const detail = [r.cost.strategy, r.cost.model].filter(Boolean).join(' · ');
  return [pipelineLabel(r.pipeline), detail ? h('div', { class: 'ov-sub', title: detail }, detail) : null];
}

function table(snap: Snapshot, boot: BootView): HTMLTableElement {
  const cols = columns(boot);
  const bests = cols.map((c) => (c.best ? bestIndices(snap.order.map(c.best.value), c.best.dir, c.best.format) : new Set<number>()));
  return h(
    'table',
    { class: 'tbl ov-lb-table' },
    h('caption', { class: 'visually-hidden' }, 'Pipelines ranked by informative F1, with errors and run cost'),
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', { scope: 'col', class: 'num ov-rank' }, '#'),
        h('th', { scope: 'col', class: 'ov-pipe' }, 'Pipeline'),
        cols.map((c) => h('th', { scope: 'col', class: ['num', c.sep && 'ov-sep'] }, headLabel(c.label, c.help))),
      ),
    ),
    h(
      'tbody',
      null,
      snap.order.map((r, i) =>
        h(
          'tr',
          null,
          h('td', { class: 'num ov-rank' }, snap.rank[r.pos] ?? '—'),
          h('th', { scope: 'row', class: 'ov-pipe' }, pipelineCell(r)),
          cols.map((c, k) => h('td', { class: ['num', c.sep && 'ov-sep'] }, c.cell(r, bests[k]!.has(i)))),
        ),
      ),
    ),
  );
}

export interface Leaderboard {
  el: HTMLElement;
  update(snap: Snapshot, boot: BootView): void;
}

export function leaderboardCard(): Leaderboard {
  const subtitle = h('span');
  const csvBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Download the leaderboard as CSV (full precision)' },
    icon('download'),
    'CSV',
  );
  const wrap = h('div', { class: 'table-wrap' });
  const el = cardShell({ title: 'Leaderboard', subtitle, actions: csvBtn, body: wrap, class: 'ov-lb' });
  let last: { snap: Snapshot; boot: BootView } | null = null;

  csvBtn.addEventListener('click', () => {
    if (!last) return;
    const { snap, boot } = last;
    downloadText(leaderboardCsv(snap, boot.state === 'ready' ? boot.result : null), `leaderboard-${snap.population}-${snap.source}.csv`, 'text/csv');
  });

  return {
    el,
    update(snap, boot) {
      last = { snap, boot };
      const scope = snap.population === 'unique' ? `${fmtInt(snap.n)} unique reports` : `all ${fmtInt(snap.n)} records`;
      const basis =
        snap.source === 'reported' && !snap.sameIds
          ? 'as each scores.json reports it (each pipeline on its own records)'
          : `on ${scope}`;
      subtitle.textContent = `Ranked by informative F1 ${basis}. Bold marks the best value in each column.`;
      render(wrap, table(snap, boot));
    },
  };
}
