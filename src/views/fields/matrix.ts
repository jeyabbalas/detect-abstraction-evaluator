/**
 * The two heat grids of the Fields view: informative errors per category and
 * per variable, one column per pipeline. Both share one geometry so their
 * columns line up, a muted "Gold" column gives prevalence, and every row and
 * cell is a hover/click target.
 */

import * as Plot from '@observablehq/plot';
import type { Analysis } from '../../core/analysis';
import { MISSING } from '../../core/evaluate';
import type { FieldScore, ScoreSummary } from '../../core/types';
import { plotStyle, type TableView } from '../../ui/chart';
import { dataTable, emptyState, pipelineLabel, tooltipBody, type Column } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtInt, fmtMetric, plural } from '../../ui/format';
import { icon } from '../../ui/icons';
import { chrome, errorFill, inkOn, type Mode } from '../../ui/palette';
import { runCost } from '../shared';
import { addRowHits, bindTargets, fitText, neutralFill, rampLegend, tagMarks, textWidth } from './kit';
import { goldInformative, goldLabel, splitConfusion, type CategoryCell, type CategoryRow, type FieldCell, type FieldRow, type FieldsModel } from './model';

const ROW_H = 26;
const GAP_LABEL_GOLD = 14;
const GAP_GOLD_GRID = 10;
const COL_MIN = 44;
const COL_MAX = 168;
const LABEL_CAP = 300;
const ROTATED_NAME_MAX = 150;
const SIN45 = Math.SQRT1_2;

export type CategoryMetric = 'f1' | 'macro' | 'accuracy' | 'errors';

export interface PipeColumn {
  /** Index into analysis.pipelines. */
  pipe: number;
  id: string;
  name: string;
  short: string;
}

export interface MatrixGeom {
  width: number;
  labelW: number;
  goldW: number;
  marginLeft: number;
  marginRight: number;
  colW: number;
  /** Pipeline names rotated −45° because they do not fit their columns. */
  rotate: boolean;
  headH: number;
  pipes: PipeColumn[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** One geometry for both grids (labels = category titles and variable names), so their columns align. */
export function matrixGeom(width: number, analysis: Analysis, model: FieldsModel): MatrixGeom {
  const n = Math.max(1, analysis.pipelines.length);
  const labels = [...model.categories.map((r) => r.category.title), ...model.fieldByName.keys()];
  const golds = [...model.categories.map((r) => goldLabel(r.gold, fmtInt)), ...[...model.fieldByName.values()].map((r) => goldLabel(r.gold, fmtInt))];
  const goldW = Math.ceil(Math.max(textWidth('Gold', 12, 500), ...golds.map((g) => textWidth(g))));
  const fixed = (labelW: number) => labelW + GAP_LABEL_GOLD + goldW + GAP_GOLD_GRID;
  let labelW = Math.ceil(Math.min(Math.max(60, ...labels.map((l) => textWidth(l))), LABEL_CAP, Math.max(110, width * 0.42)));
  // Narrow screens: give columns their minimum before labels get their full width.
  const spare = width - 8 - fixed(labelW) - n * COL_MIN;
  if (spare < 0) labelW = Math.max(90, labelW + spare);
  const marginLeft = fixed(labelW);
  const colW = Math.floor(clamp((width - marginLeft - 8) / n, COL_MIN, COL_MAX));

  const names = analysis.pipelines.map((pa) => pa.pipeline.name);
  const widest = Math.max(...names.map((nm) => textWidth(nm, 12, 500)));
  const rotate = widest + 12 > colW;
  const shortMax = rotate ? ROTATED_NAME_MAX : colW - 10;
  const pipes = analysis.pipelines.map((pa, pipe) => ({
    pipe,
    id: pa.pipeline.id,
    name: pa.pipeline.name,
    short: fitText(pa.pipeline.name, shortMax, 12, 500),
  }));
  const shortW = Math.max(...pipes.map((p) => textWidth(p.short, 12, 500)));
  const headH = rotate ? Math.ceil(shortW * SIN45 + 14) : 26;
  const marginRight = rotate ? Math.max(8, Math.ceil(shortW * SIN45 + 6 - colW / 2)) : 8;
  return { width: marginLeft + n * colW + marginRight, labelW, goldW, marginLeft, marginRight, colW, rotate, headH, pipes };
}

// ----------------------------------------------------------------- header

function headerSvg(g: MatrixGeom, mode: Mode, goldTitle: string): Element {
  const c = chrome(mode);
  return Plot.plot({
    width: g.width,
    height: g.headH,
    marginTop: g.headH - 2,
    marginBottom: 0,
    marginLeft: g.marginLeft,
    marginRight: g.marginRight,
    style: plotStyle(mode),
    ariaLabel: 'Pipelines',
    x: { type: 'band', domain: g.pipes.map((p) => p.id), padding: 0, axis: null },
    marks: [
      Plot.text(g.pipes, {
        x: (d: PipeColumn) => d.id,
        text: (d: PipeColumn) => d.short,
        frameAnchor: 'top',
        dy: -6,
        rotate: g.rotate ? -45 : 0,
        textAnchor: g.rotate ? 'start' : 'middle',
        lineAnchor: g.rotate ? 'middle' : 'bottom',
        fill: c.ink,
        fontWeight: 500,
        className: 'fx-colhead',
      }),
      Plot.text([goldTitle], {
        text: (d: string) => d,
        frameAnchor: 'top-left',
        dx: -GAP_GOLD_GRID,
        dy: -6,
        textAnchor: 'end',
        lineAnchor: 'bottom',
        fill: c.ink3,
        fontWeight: 500,
      }),
    ],
  });
}

function pipeTip(analysis: Analysis, col: PipeColumn): Child {
  const pa = analysis.pipelines[col.pipe]!;
  const cost = runCost(pa.pipeline);
  const detail = [cost.strategy, cost.model].filter(Boolean).join(' · ');
  return h('div', null, h('div', { class: 'tt-title' }, pipelineLabel(pa.pipeline)), detail ? h('div', { class: 'tt-muted' }, detail) : null);
}

// ---------------------------------------------------------------- shared

/** Empty state when there is nothing to put in a grid. */
function emptyMatrix(analysis: Analysis, model: FieldsModel): HTMLElement | null {
  if (!analysis.pipelines.length) return emptyState({ icon: 'fields', title: 'No pipelines to compare', body: 'The experiment has no abstraction runs.' });
  if (!model.categories.length) {
    return emptyState({ icon: 'fields', title: 'No categorical variables', body: 'The data dictionary defines no variable with a closed set of values.' });
  }
  return null;
}

interface GridCell {
  key: string;
  pid: string;
  fill: string;
  ink: string;
  text: string;
}

/** Body panel: cells + labels + gold column, tagged for interaction. */
function gridSvg(opts: {
  g: MatrixGeom;
  mode: Mode;
  rows: { key: string; label: string; gold: string; strong: boolean }[];
  cells: GridCell[];
  ariaLabel: string;
  cellGroup: string;
  rowGroup: string;
  offsetCells: number;
  offsetRows: number;
  rowAria: (i: number) => string;
}): Element {
  const { g, mode, rows, cells } = opts;
  const c = chrome(mode);
  const svg = Plot.plot({
    width: g.width,
    height: rows.length * ROW_H,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: g.marginLeft,
    marginRight: g.marginRight,
    style: plotStyle(mode),
    ariaLabel: opts.ariaLabel,
    x: { type: 'band', domain: g.pipes.map((p) => p.id), padding: 0, axis: null },
    y: { type: 'band', domain: rows.map((r) => r.key), padding: 0, axis: null },
    marks: [
      Plot.cell(cells, { x: (d: GridCell) => d.pid, y: (d: GridCell) => d.key, fill: (d: GridCell) => d.fill, inset: 1, r: 3, className: 'fx-cells' }),
      Plot.text(cells, {
        x: (d: GridCell) => d.pid,
        y: (d: GridCell) => d.key,
        text: (d: GridCell) => d.text,
        fill: (d: GridCell) => d.ink,
        fontVariant: 'tabular-nums',
        className: 'fx-celltext',
      }),
      Plot.text(rows, {
        y: (d: (typeof rows)[number]) => d.key,
        text: (d: (typeof rows)[number]) => d.label,
        frameAnchor: 'left',
        dx: -(GAP_GOLD_GRID + g.goldW + GAP_LABEL_GOLD),
        textAnchor: 'end',
        fill: (d: (typeof rows)[number]) => (d.strong ? c.ink : c.ink3),
        className: 'fx-labels',
      }),
      Plot.text(rows, {
        y: (d: (typeof rows)[number]) => d.key,
        text: (d: (typeof rows)[number]) => d.gold,
        frameAnchor: 'left',
        dx: -GAP_GOLD_GRID,
        textAnchor: 'end',
        fill: c.ink3,
        fontVariant: 'tabular-nums',
        className: 'fx-gold',
      }),
    ],
  });
  tagMarks(svg, 'fx-cells', opts.cellGroup, opts.offsetCells);
  addRowHits(svg, {
    group: opts.rowGroup,
    count: rows.length,
    top: 0,
    rowH: ROW_H,
    x: 0,
    width: g.marginLeft - GAP_GOLD_GRID / 2,
    offset: opts.offsetRows,
    focusable: true,
    label: opts.rowAria,
  });
  return svg;
}

const pairText = (gold: string, pred: string) => `${gold === MISSING ? 'missing' : gold} → ${pred === MISSING ? 'missing' : pred}`;

/** Up to `max` confusions as compact lines for a tooltip. */
function confusionLines(confusion: Record<string, number> | undefined, domain: readonly string[], max = 3): HTMLElement | null {
  const entries = Object.entries(confusion ?? {});
  if (!entries.length) return null;
  const known = new Set([...domain, MISSING]);
  return h(
    'div',
    { class: 'fx-tt-confusions' },
    h('div', { class: 'tt-muted' }, 'Top confusions (gold → predicted)'),
    entries.slice(0, max).map(([key, n]) => {
      const [gold, pred] = splitConfusion(key, known);
      return h('div', { class: 'tt-row' }, h('span', { class: 'k' }, pairText(gold, pred)), h('span', { class: 'v' }, `× ${fmtInt(n)}`));
    }),
    entries.length > max ? h('div', { class: 'tt-muted' }, `+ ${entries.length - max} more`) : null,
  );
}

// -------------------------------------------------------- category matrix

const METRIC_VALUE: Record<CategoryMetric, (s: ScoreSummary, errors: number) => string> = {
  f1: (s) => fmtMetric(s.informative_f1),
  macro: (s) => fmtMetric(s.mean_field_macro_f1),
  accuracy: (s) => fmtMetric(s.cell_accuracy),
  errors: (_, errors) => fmtInt(errors),
};

export function renderCategoryMatrix(o: {
  width: number;
  mode: Mode;
  analysis: Analysis;
  model: FieldsModel;
  metric: CategoryMetric;
  onCategory: (key: string) => void;
}): HTMLElement {
  const { width, mode, analysis, model } = o;
  const empty = emptyMatrix(analysis, model);
  if (empty) return empty;
  const g = matrixGeom(width, analysis, model);
  const c = chrome(mode);
  const zero = neutralFill(mode);
  const rows = model.categories;
  const flat: { row: CategoryRow; cell: CategoryCell }[] = [];
  const cells: GridCell[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const fill = errorFill(cell.errors, model.categoryMax, mode) ?? zero;
      flat.push({ row, cell });
      cells.push({
        key: row.category.key,
        pid: g.pipes[cell.pipe]!.id,
        fill,
        ink: cell.errors ? inkOn(fill) : c.ink2,
        text: cell.summary ? METRIC_VALUE[o.metric](cell.summary, cell.errors) : '—',
      });
    }
  }
  const body = gridSvg({
    g,
    mode,
    rows: rows.map((r) => ({ key: r.category.key, label: fitText(r.category.title, g.labelW), gold: goldLabel(r.gold, fmtInt), strong: true })),
    cells,
    ariaLabel: 'Informative errors by category and pipeline',
    cellGroup: 'cat',
    rowGroup: 'catrow',
    offsetCells: 0,
    offsetRows: 0,
    rowAria: (i) => `${rows[i]!.category.title}: show its variables`,
  });
  const head = headerSvg(g, mode, 'Gold');
  tagMarks(head, 'fx-colhead', 'col');

  const el = h(
    'div',
    { class: 'fx-matrix' },
    h('div', { class: 'fx-legend-row' }, rampLegend(model.categoryMax, mode, width)),
    h('div', { class: 'fx-head' }, head),
    h('div', { class: 'fx-body' }, body),
  );
  bindTargets(el, {
    col: { tip: (i) => pipeTip(analysis, g.pipes[i]!) },
    cat: {
      tip: (i) => categoryCellTip(analysis, flat[i]!.row, flat[i]!.cell),
      activate: (i) => o.onCategory(flat[i]!.row.category.key),
    },
    catrow: {
      tip: (i) => categoryRowTip(rows[i]!),
      activate: (i) => o.onCategory(rows[i]!.category.key),
    },
  });
  return el;
}

function categoryCellTip(analysis: Analysis, row: CategoryRow, cell: CategoryCell): Child {
  const p = analysis.pipelines[cell.pipe]!.pipeline;
  const s = cell.summary;
  if (!s) return tooltipBody(row.category.title, [['Pipeline', pipelineLabel(p)]], 'No scores for this population.');
  return tooltipBody(
    row.category.title,
    [
      ['Pipeline', pipelineLabel(p)],
      ['Informative errors', `${fmtInt(cell.errors)} (FP ${fmtInt(s.fp)} · FN ${fmtInt(s.fn)})`],
      ['Informative F1', fmtMetric(s.informative_f1)],
      ['Precision', fmtMetric(s.informative_precision)],
      ['Recall', fmtMetric(s.informative_recall)],
      ['Macro-F1', fmtMetric(s.mean_field_macro_f1)],
      ['Accuracy', fmtMetric(s.cell_accuracy)],
      ['TP · FP · FN', `${fmtInt(s.tp)} · ${fmtInt(s.fp)} · ${fmtInt(s.fn)}`],
      ['Cells', fmtInt(s.cells)],
    ],
    'Click to see its variables.',
  );
}

function categoryRowTip(row: CategoryRow): Child {
  const n = row.category.categorical.length;
  return tooltipBody(
    row.category.title,
    [
      ['Categorical variables', fmtInt(n)],
      ['Informative gold values', goldLabel(row.gold, fmtInt)],
      ['Errors, all pipelines', fmtInt(row.errors)],
    ],
    'Click to see its variables.',
  );
}

export function categoryTable(analysis: Analysis, model: FieldsModel): TableView {
  type R = { row: CategoryRow; cell: CategoryCell; s: ScoreSummary | null };
  const rows: R[] = model.categories.flatMap((row) => row.cells.map((cell) => ({ row, cell, s: cell.summary })));
  const num = (key: string, label: string, get: (s: ScoreSummary, r: R) => number | null, fmt: (v: number | null) => string): Column<R> => ({
    key,
    label,
    numeric: true,
    value: (r) => (r.s ? get(r.s, r) : null),
    cell: (r) => (r.s ? fmt(get(r.s, r)) : '—'),
  });
  const t = dataTable<R>(
    [
      { key: 'category', label: 'Category', value: (r) => r.row.category.title },
      {
        key: 'pipeline',
        label: 'Pipeline',
        value: (r) => analysis.pipelines[r.cell.pipe]!.pipeline.name,
        cell: (r) => pipelineLabel(analysis.pipelines[r.cell.pipe]!.pipeline),
      },
      num('gold', 'Gold', (s) => goldInformative(s), fmtInt),
      num('tp', 'TP', (s) => s.tp, fmtInt),
      num('fp', 'FP', (s) => s.fp, fmtInt),
      num('fn', 'FN', (s) => s.fn, fmtInt),
      num('errors', 'Errors', (_, r) => r.cell.errors, fmtInt),
      num('precision', 'Precision', (s) => s.informative_precision, fmtMetric),
      num('recall', 'Recall', (s) => s.informative_recall, fmtMetric),
      num('f1', 'Informative F1', (s) => s.informative_f1, fmtMetric),
      num('macro', 'Macro-F1', (s) => s.mean_field_macro_f1, fmtMetric),
      num('accuracy', 'Accuracy', (s) => s.cell_accuracy, fmtMetric),
      num('cells', 'Cells', (s) => s.cells, fmtInt),
    ],
    rows,
    { caption: 'Scores by category and pipeline' },
  );
  return { el: t.wrap, csv: t.toCsv };
}

// -------------------------------------------------------- variable matrix

export const panelId = (key: string): string => `fields-cat-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;

export function renderVariableMatrix(o: {
  width: number;
  mode: Mode;
  analysis: Analysis;
  model: FieldsModel;
  onlyErrors: boolean;
  onField: (name: string, pipe?: number) => void;
}): HTMLElement {
  const { width, mode, analysis, model } = o;
  const empty = emptyMatrix(analysis, model);
  if (empty) return empty;
  const g = matrixGeom(width, analysis, model);
  const c = chrome(mode);
  const zero = neutralFill(mode);
  const cellTargets: { row: FieldRow; cell: FieldCell }[] = [];
  const rowTargets: FieldRow[] = [];

  const head = headerSvg(g, mode, 'Gold');
  tagMarks(head, 'fx-colhead', 'col');

  const panels = model.categories.map(({ category }) => {
    const all = model.fieldsByCategory.get(category.key) ?? [];
    const shown = o.onlyErrors ? all.filter((r) => r.errors > 0) : all;
    const withErrors = all.filter((r) => r.errors > 0).length;
    const meta = withErrors
      ? `${fmtInt(withErrors)} of ${fmtInt(all.length)} ${all.length === 1 ? 'variable' : 'variables'} with errors`
      : shown.length
        ? 'No errors'
        : '';
    let content: Child;
    if (!shown.length) {
      content = h(
        'div',
        { class: 'fx-allgood' },
        icon('check', { size: 14 }),
        h('span', { 'data-export-text': '' }, all.length === 1 ? 'The variable is correct' : `All ${fmtInt(all.length)} variables correct`),
      );
    } else {
      const offsetCells = cellTargets.length;
      const offsetRows = rowTargets.length;
      const cells: GridCell[] = [];
      for (const row of shown) {
        rowTargets.push(row);
        for (const cell of row.cells) {
          cellTargets.push({ row, cell });
          const fill = errorFill(cell.errors, model.fieldMax, mode) ?? zero;
          cells.push({
            key: row.field.name,
            pid: g.pipes[cell.pipe]!.id,
            fill,
            ink: cell.errors ? inkOn(fill) : cell.score ? c.axis : c.muted,
            text: cell.errors ? fmtInt(cell.errors) : cell.score ? '·' : '—',
          });
        }
      }
      content = gridSvg({
        g,
        mode,
        rows: shown.map((r) => ({ key: r.field.name, label: fitText(r.field.name, g.labelW), gold: goldLabel(r.gold, fmtInt), strong: r.errors > 0 })),
        cells,
        ariaLabel: `Informative errors by variable and pipeline: ${category.title}`,
        cellGroup: 'var',
        rowGroup: 'varrow',
        offsetCells,
        offsetRows,
        rowAria: (i) => `${shown[i]!.field.name}: open details`,
      });
    }
    return h(
      'section',
      { class: 'fx-panel', id: panelId(category.key) },
      h(
        'div',
        { class: 'fx-panel-head' },
        h('span', { class: 'fx-panel-title', 'data-export-text': '' }, category.title),
        h('span', { class: 'fx-panel-meta' }, meta),
      ),
      content,
    );
  });

  const el = h(
    'div',
    { class: 'fx-matrix fx-matrix-vars', style: { '--fx-head-h': `${g.headH}px` } },
    h('div', { class: 'fx-legend-row' }, rampLegend(model.fieldMax, mode, width)),
    h('div', { class: 'fx-head fx-sticky' }, head),
    panels,
  );
  bindTargets(el, {
    col: { tip: (i) => pipeTip(analysis, g.pipes[i]!) },
    var: {
      tip: (i) => fieldCellTip(analysis, cellTargets[i]!.row, cellTargets[i]!.cell),
      activate: (i) => o.onField(cellTargets[i]!.row.field.name, cellTargets[i]!.cell.pipe),
    },
    varrow: {
      tip: (i) => fieldRowTip(analysis, rowTargets[i]!),
      activate: (i) => o.onField(rowTargets[i]!.field.name),
    },
  });
  return el;
}

function fieldCellTip(analysis: Analysis, row: FieldRow, cell: FieldCell): Child {
  const p = analysis.pipelines[cell.pipe]!.pipeline;
  const fs: FieldScore | null = cell.score;
  const head = [
    ['Variable', h('code', null, row.field.name)],
    ['Pipeline', pipelineLabel(p)],
  ] as [Child, Child][];
  if (!fs) return tooltipBody(row.field.title, head, 'No scores for this population.');
  const body = tooltipBody(row.field.title, [
    ...head,
    ['Informative errors', `${fmtInt(cell.errors)} (FP ${fmtInt(fs.fp)} · FN ${fmtInt(fs.fn)})`],
    ['F1', fmtMetric(fs.f1)],
    ['Macro-F1', fmtMetric(fs.macro_f1)],
    ['Accuracy', fmtMetric(fs.accuracy)],
    ['Informative gold values', `${fmtInt(goldInformative(fs))} of ${fmtInt(fs.n)}`],
  ]);
  const conf = confusionLines(fs.confusion, row.field.domain);
  if (conf) body.append(conf);
  body.append(h('div', { class: 'tt-muted fx-tt-hint' }, 'Click for confusions and records.'));
  return body;
}

function fieldRowTip(analysis: Analysis, row: FieldRow): Child {
  const n = row.cells.find((c) => c.score)?.score?.n ?? null;
  return tooltipBody(
    row.field.title,
    [
      ['Variable', h('code', null, row.field.name)],
      ['Category', row.category.title],
      ['Informative gold values', n === null ? goldLabel(row.gold, fmtInt) : `${goldLabel(row.gold, fmtInt)} of ${fmtInt(n)}`],
      ...row.cells.map((c): [Child, Child] => [pipelineLabel(analysis.pipelines[c.pipe]!.pipeline), c.score ? plural(c.errors, 'error') : '—']),
    ],
    'Click for confusions and records.',
  );
}

export function variableTable(analysis: Analysis, model: FieldsModel, onlyErrors: boolean, onField: (name: string) => void): TableView {
  const rows = [...model.fieldByName.values()].filter((r) => !onlyErrors || r.errors > 0);
  const t = dataTable<FieldRow>(
    [
      { key: 'category', label: 'Category', value: (r) => r.category.title },
      {
        key: 'variable',
        label: 'Variable',
        value: (r) => r.field.name,
        cell: (r) =>
          h('button', { type: 'button', class: 'fx-link', title: `${r.field.title} — open details`, onclick: () => onField(r.field.name) }, r.field.name),
      },
      { key: 'title', label: 'Title', value: (r) => r.field.title, className: () => 'muted' },
      { key: 'gold', label: 'Gold', numeric: true, value: (r) => r.gold[0] ?? null, cell: (r) => goldLabel(r.gold, fmtInt) },
      ...analysis.pipelines.map(
        (pa, pipe): Column<FieldRow> => ({
          key: `errors:${pa.pipeline.id}`,
          label: pa.pipeline.name,
          title: `Informative errors (FP + FN) of ${pa.pipeline.name}`,
          numeric: true,
          value: (r) => (r.cells[pipe]?.score ? r.cells[pipe]!.errors : null),
          cell: (r) => (r.cells[pipe]?.score ? fmtInt(r.cells[pipe]!.errors) : '—'),
          className: (r) => ((r.cells[pipe]?.errors ?? 0) > 0 ? 'fx-num-strong' : 'muted'),
        }),
      ),
    ],
    rows,
    { caption: 'Informative errors by variable and pipeline' },
  );
  return { el: t.wrap, csv: t.toCsv };
}
