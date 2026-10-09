/** Static overview sections: experiment notes, run configuration, how metrics are computed. */

import type { Analysis } from '../../core/analysis';
import { badge, downloadText, pipelineLabel } from '../../ui/components';
import { h, render, type Child } from '../../ui/dom';
import { fmtInt, plural } from '../../ui/format';
import { icon } from '../../ui/icons';
import { METRIC_META, POPULATION_HELP } from '../shared';
import { cardShell } from './dom';
import { DUP_HELP } from './leaderboard';
import { CONFIG_GROUPS, HEADLINE_METRICS, experimentNotes, formatConfigValue, runConfigRows, toCsv, type ConfigRow } from './model';

// ------------------------------------------------------------------ notes

/** A quiet disclosure listing what a reader should know about the inputs; null when there is nothing. */
export function notesSection(analysis: Analysis): HTMLElement | null {
  const notes = experimentNotes(analysis);
  if (!notes.length) return null;
  const count = (level: string) => notes.filter((n) => n.level === level).length;
  const errors = count('error');
  const warnings = count('warning');
  const infos = count('info');
  const meta = [errors ? plural(errors, 'error') : '', warnings ? plural(warnings, 'warning') : '', infos ? `${fmtInt(infos)} info` : '']
    .filter(Boolean)
    .join(' · ');
  return h(
    'details',
    { class: 'disclosure ov-notes', open: errors > 0 },
    h(
      'summary',
      null,
      icon('chevronRight'),
      h('span', { class: 'ov-notes-title' }, `${plural(notes.length, 'note')} about this experiment`),
      h('span', { class: 'ov-notes-meta' }, meta),
    ),
    h(
      'ul',
      { class: 'ov-notes-list' },
      notes.map((n) => {
        const pipeline = n.pos !== undefined ? analysis.pipelines[n.pos]?.pipeline : undefined;
        return h(
          'li',
          { class: n.level },
          h('span', { class: 'ov-note-icon', 'aria-hidden': 'true' }, icon(n.level === 'info' ? 'info' : 'alert')),
          h('span', { class: 'visually-hidden' }, n.level === 'info' ? 'Info: ' : n.level === 'error' ? 'Error: ' : 'Warning: '),
          h('div', null, pipeline ? [pipelineLabel(pipeline), h('span', { class: 'ov-note-sep' }, ' — '), n.message] : n.message),
        );
      }),
    ),
  );
}

// ------------------------------------------------------- run configuration

function valueCell(row: ConfigRow, value: unknown, hasRun: boolean): HTMLElement {
  if (!hasRun) return h('td', { class: 'ov-val' }, h('span', { class: 'muted' }, '—'));
  const v = formatConfigValue(row.key, value);
  const content: Child =
    v.kind === 'code'
      ? h('code', null, v.text)
      : v.kind === 'null'
        ? h('code', { class: 'muted' }, v.text)
        : v.kind === 'missing'
          ? h('span', { class: 'muted', title: 'Not in this run.json' }, v.text)
          : v.text;
  return h('td', { class: ['ov-val', (v.kind === 'number' || v.kind === 'duration') && 'ov-numval'], title: v.title }, content);
}

export function runConfigSection(analysis: Analysis): HTMLElement {
  const pipelines = analysis.pipelines.map((pa) => pa.pipeline);
  const hasRun = pipelines.map((p) => p.run !== null);
  const runs = hasRun.filter(Boolean).length;
  const rows = runConfigRows(pipelines);
  const differing = rows.filter((r) => r.differs).length;
  const canFilter = runs >= 2;
  let only = canFilter;

  const body = h('div', { class: 'ov-config-body' });
  const subtitle =
    runs === 0
      ? 'No pipeline has a run.json, so settings and cost are unknown.'
      : canFilter
        ? `From each pipeline’s run.json. ${fmtInt(differing)} of ${plural(rows.length, 'setting')} ${differing === 1 ? 'differs' : 'differ'} across pipelines; they are listed first.`
        : pipelines.length > 1
          ? 'Only one pipeline has a run.json; the others show —.'
          : 'From the pipeline’s run.json.';

  const checkbox = h('input', { type: 'checkbox', checked: only });
  checkbox.addEventListener('change', () => {
    only = checkbox.checked;
    draw();
  });
  const csvBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Download the run configuration as CSV' }, icon('download'), 'CSV');
  csvBtn.addEventListener('click', () => {
    const csv = toCsv([
      ['group', 'setting', ...pipelines.map((p) => p.name), 'differs'],
      ...rows.map((r) => [r.group, r.key, ...r.values.map((v) => (v === undefined ? '' : v === null ? 'null' : v)), r.differs ? 'yes' : 'no']),
    ]);
    downloadText(csv, 'run-configuration.csv', 'text/csv');
  });

  function draw() {
    if (!runs) {
      render(body, h('div', { class: 'empty' }, icon('info'), h('strong', null, 'No run.json found'), h('div', null, 'Add run.json to a pipeline folder to compare settings, usage and cost.')));
      return;
    }
    const shown = only ? rows.filter((r) => r.differs) : rows;
    if (!shown.length) {
      render(body, h('p', { class: 'ov-config-same' }, icon('checkCircle'), `All ${plural(rows.length, 'setting')} are identical across pipelines.`));
      return;
    }
    const table = h(
      'table',
      { class: 'tbl ov-config-table' },
      h('caption', { class: 'visually-hidden' }, 'Run configuration per pipeline'),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col', class: 'ov-config-key' }, 'Setting'),
          pipelines.map((p, i) => h('th', { scope: 'col' }, pipelineLabel(p), hasRun[i] ? null : h('span', { class: 'ov-norun' }, 'no run.json'))),
        ),
      ),
      CONFIG_GROUPS.map(({ key, label }) => {
        const groupRows = shown.filter((r) => r.group === key);
        if (!groupRows.length) return null;
        return h(
          'tbody',
          null,
          h('tr', { class: 'ov-group' }, h('th', { scope: 'colgroup', colSpan: pipelines.length + 1 }, label)),
          groupRows.map((r) =>
            h(
              'tr',
              { class: { 'ov-differs': r.differs } },
              h('th', { scope: 'row', class: 'ov-config-key' }, h('code', null, r.key), r.differs && !only ? badge('differs') : null),
              r.values.map((v, i) => valueCell(r, v, hasRun[i]!)),
            ),
          ),
        );
      }),
    );
    render(body, h('div', { class: 'table-wrap' }, table));
  }
  draw();

  const actions = runs
    ? [canFilter ? h('label', { class: 'checkbox' }, checkbox, 'Only differences') : null, csvBtn]
    : null;
  return cardShell({ title: 'Run configuration', subtitle, actions, body, class: 'ov-config' });
}

// ------------------------------------------------- how metrics are computed

export function methodsSection(analysis: Analysis): HTMLElement {
  const { schema } = analysis.experiment;
  const nCat = schema.categoricalFields.length;
  const nText = schema.textFields.length;
  const defs: [string, Child][] = [
    [
      'What is scored',
      [
        `The ${plural(nCat, 'categorical variable')} of every record. `,
        nText
          ? `The ${plural(nText, 'free-text variable')} (names ending in _text) are excluded from every metric on this page and reported as diagnostics in the Fields view. `
          : '',
        'Missing or invalid predictions are scored as wrong, never dropped.',
      ],
    ],
    [
      'Default labels',
      'Each variable has a default label that records missing or negative information: the first of “Cannot determine”, “Not identified” and “No” that its allowed values include. Most cells hold it, so agreeing on it earns no credit in the informative metrics. Where the default is “Cannot determine” or “Not identified”, a “No” is informative.',
    ],
    [
      'TP, FP and FN',
      'A cell is a true positive (TP) when the prediction is right and the gold value is informative (not the default label); a false positive (FP, over-call) when the prediction is wrong and informative; a false negative (FN, miss) when the prediction is wrong and the gold value is informative. A wrong informative label — say, the wrong histologic type — is both an FP and an FN.',
    ],
    [
      'Metrics',
      h(
        'ul',
        { class: 'ov-defs-list' },
        HEADLINE_METRICS.map((m) => h('li', null, h('strong', null, METRIC_META[m].label), ' — ', METRIC_META[m].help)),
      ),
    ],
    ['Populations', POPULATION_HELP],
    ['Duplicate agreement', DUP_HELP],
    [
      'Confidence intervals',
      'Percentile bootstrap over records: 2,000 resamples of the records with a fixed seed, recomputing every metric on each. Records — not cells — are resampled because cells within a report are correlated. Pairwise differences resample the same records for both pipelines (a paired bootstrap), so the interval reflects the difference on identical reports.',
    ],
  ];
  return h(
    'details',
    { class: 'disclosure ov-methods' },
    h('summary', null, icon('chevronRight'), 'How metrics are computed'),
    h(
      'dl',
      { class: 'ov-defs' },
      defs.map(([term, desc]) => [h('dt', null, term), h('dd', null, desc)]),
    ),
  );
}
