/**
 * Free-text diagnostics: exact match and presence agreement per free-text
 * variable, one dot per pipeline (small multiples side by side).
 */

import * as Plot from '@observablehq/plot';
import type { Analysis } from '../../core/analysis';
import { plotStyle, type TableView } from '../../ui/chart';
import { dataTable, emptyState, pipelineLabel, type Column } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtInt, fmtMetric } from '../../ui/format';
import { chrome, seriesColor, type Mode } from '../../ui/palette';
import { addRowHits, bindTargets, fitText, seriesLegend, textWidth } from './kit';
import { dotOffsets, type FieldsModel, type TextRow } from './model';

type RateKey = 'exact_match' | 'presence_agreement';

const PANELS: { key: RateKey; title: string }[] = [
  { key: 'exact_match', title: 'Exact match' },
  { key: 'presence_agreement', title: 'Presence agreement' },
];

const TICKS = [0, 0.25, 0.5, 0.75, 1];
const MARGIN_TOP = 6;
const MARGIN_BOTTOM = 26;
const MARGIN_RIGHT = 14;
/** Left margin of an unlabelled panel: room for half of the first tick label, which exports clip. */
const MARGIN_LEFT_BARE = 18;
const LABEL_GAP = 14;

interface Dot {
  row: TextRow;
  value: number;
}

export function renderTextDiagnostics(o: {
  width: number;
  mode: Mode;
  analysis: Analysis;
  model: FieldsModel;
  onField: (name: string) => void;
}): HTMLElement {
  const { width, mode, analysis, model } = o;
  const rows = model.text;
  if (!rows.some((r) => r.cells.some((c) => c.score))) {
    return emptyState({ icon: 'info', title: 'No free-text diagnostics', body: 'The scores in view carry no free-text results for this population.' });
  }
  const c = chrome(mode);
  const n = analysis.pipelines.length;
  const rowH = Math.max(26, Math.min(44, 12 + 7 * n));
  const offsets = dotOffsets(n, rowH);
  const names = rows.map((r) => r.field.name);
  const labelW = Math.ceil(Math.min(Math.max(...names.map((nm) => textWidth(nm))), 300, Math.max(110, width * 0.36)));
  const side = width >= 640;
  const ml = labelW + LABEL_GAP;
  const gap = 24;
  const plotW = side ? Math.floor((width - ml - gap - MARGIN_LEFT_BARE - 2 * MARGIN_RIGHT) / 2) : width - ml - MARGIN_RIGHT;
  const height = MARGIN_TOP + rows.length * rowH + MARGIN_BOTTOM;

  const panel = (key: RateKey, title: string, withLabels: boolean) => {
    const marginLeft = withLabels ? ml : MARGIN_LEFT_BARE;
    const w = marginLeft + plotW + MARGIN_RIGHT;
    const dots = analysis.pipelines.map((pa, pipe) =>
      Plot.dot(
        rows.flatMap((row): Dot[] => {
          const score = row.cells[pipe]?.score;
          return score ? [{ row, value: score[key] }] : [];
        }),
        {
          x: (d: Dot) => d.value,
          y: (d: Dot) => d.row.field.name,
          r: 4.5,
          fill: seriesColor(pa.pipeline.index, mode),
          stroke: c.surface,
          strokeWidth: 2,
          dy: offsets[pipe] ?? 0,
        },
      ),
    );
    const svg = Plot.plot({
      width: w,
      height,
      marginTop: MARGIN_TOP,
      marginBottom: MARGIN_BOTTOM,
      marginLeft,
      marginRight: MARGIN_RIGHT,
      style: plotStyle(mode),
      ariaLabel: `${title} by free-text variable and pipeline`,
      x: { domain: [0, 1], axis: null },
      y: { type: 'band', domain: names, padding: 0, axis: null },
      marks: [
        Plot.gridX(TICKS, { stroke: c.grid, strokeOpacity: 1 }),
        Plot.axisX(TICKS, { anchor: 'bottom', tickSize: 0, tickPadding: 8, tickFormat: (d: number) => d.toFixed(2), fill: c.ink3 }),
        ...dots,
        withLabels
          ? Plot.text(rows, {
              y: (d: TextRow) => d.field.name,
              text: (d: TextRow) => fitText(d.field.name, labelW),
              frameAnchor: 'left',
              dx: -LABEL_GAP,
              textAnchor: 'end',
              fill: c.ink,
              className: 'fx-labels',
            })
          : null,
      ],
    });
    addRowHits(svg, {
      group: 'txt',
      count: rows.length,
      top: MARGIN_TOP,
      rowH,
      x: 0,
      width: w,
      focusable: withLabels,
      label: (i) => `${rows[i]!.field.name}: open details`,
    });
    return h(
      'div',
      { class: 'fx-text-panel', style: { width: `${w}px` } },
      h('div', { class: 'fx-text-title', style: { paddingLeft: `${marginLeft}px` } }, h('span', { 'data-export-text': '' }, title)),
      svg,
    );
  };

  const legend = seriesLegend(
    analysis.pipelines.map((pa) => ({ label: pa.pipeline.name, color: seriesColor(pa.pipeline.index, mode) })),
    mode,
    width,
  );
  const el = h(
    'div',
    { class: 'fx-text' },
    n > 1 ? h('div', { class: 'fx-legend-row' }, legend) : null,
    h(
      'div',
      { class: ['fx-text-panels', side && 'side'] },
      PANELS.map((p, i) => panel(p.key, p.title, !side || i === 0)),
    ),
  );
  bindTargets(el, {
    txt: {
      tip: (i) => textRowTip(analysis, model, rows[i]!),
      activate: (i) => o.onField(rows[i]!.field.name),
    },
  });
  return el;
}

function textRowTip(analysis: Analysis, model: FieldsModel, row: TextRow): Child {
  return h(
    'div',
    null,
    h('div', { class: 'tt-title' }, row.field.title),
    h('div', { class: 'tt-muted' }, h('code', null, row.field.name)),
    h(
      'table',
      { class: 'fx-tt-table' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Exact'), h('th', null, 'Presence'))),
      h(
        'tbody',
        null,
        row.cells.map((cell) =>
          h(
            'tr',
            null,
            h('td', null, pipelineLabel(analysis.pipelines[cell.pipe]!.pipeline)),
            h('td', { class: 'num' }, cell.score ? fmtMetric(cell.score.exact_match) : '—'),
            h('td', { class: 'num' }, cell.score ? fmtMetric(cell.score.presence_agreement) : '—'),
          ),
        ),
      ),
    ),
    h('div', { class: 'tt-muted fx-tt-hint' }, `Over ${fmtInt(model.ids.length)} records. Click for the records that differ.`),
  );
}

export function textTable(analysis: Analysis, model: FieldsModel, onField: (name: string) => void): TableView {
  type R = { row: TextRow; pipe: number };
  const rows: R[] = model.text.flatMap((row) => row.cells.map((cell) => ({ row, pipe: cell.pipe })));
  const rate = (key: RateKey, label: string): Column<R> => ({
    key,
    label,
    numeric: true,
    value: (r) => r.row.cells[r.pipe]?.score?.[key] ?? null,
    cell: (r) => fmtMetric(r.row.cells[r.pipe]?.score?.[key]),
  });
  const t = dataTable<R>(
    [
      {
        key: 'variable',
        label: 'Variable',
        value: (r) => r.row.field.name,
        cell: (r) =>
          h('button', { type: 'button', class: 'fx-link', title: `${r.row.field.title} — open details`, onclick: () => onField(r.row.field.name) }, r.row.field.name),
      },
      { key: 'title', label: 'Title', value: (r) => r.row.field.title, className: () => 'muted' },
      {
        key: 'pipeline',
        label: 'Pipeline',
        value: (r) => analysis.pipelines[r.pipe]!.pipeline.name,
        cell: (r) => pipelineLabel(analysis.pipelines[r.pipe]!.pipeline),
      },
      rate('exact_match', 'Exact match'),
      rate('presence_agreement', 'Presence agreement'),
    ],
    rows,
    { caption: 'Free-text diagnostics by variable and pipeline' },
  );
  return { el: t.wrap, csv: t.toCsv };
}
