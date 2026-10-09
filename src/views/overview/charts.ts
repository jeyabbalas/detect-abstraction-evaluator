/**
 * The overview's chart cards: headline metrics with bootstrap intervals
 * (small multiples), the error profile, cost vs. accuracy and pairwise
 * differences. Each renders from a snapshot read at draw time, so a redraw
 * after a state or bootstrap change picks up the new numbers.
 */

import * as Plot from '@observablehq/plot';
import { nice, ticks } from 'd3';
import type { BootstrapResult, MetricKey } from '../../core/bootstrap';
import { chartCard, plotStyle, type ChartCard, type TableView } from '../../ui/chart';
import { dataTable, emptyState, pipelineLabel, segmented, tooltipBody } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtCI, fmtCompact, fmtDuration, fmtInt, fmtMetric, fmtPct, fmtSigned } from '../../ui/format';
import { STATUS, chrome, seriesColor, type Mode } from '../../ui/palette';
import { METRIC_META } from '../shared';
import { fitText, hoverNearest, hoverRows, textWidth } from './dom';
import {
  COST_META,
  HEADLINE_METRICS,
  axisDomain,
  durationUnit,
  pairRows,
  placeLabels,
  pointEstimate,
  sharedHeight,
  toCsv,
  type CostKey,
  type PairRow,
  type PipelineRow,
  type Snapshot,
} from './model';

export type BootState = 'pending' | 'ready' | 'none';

/** What the bootstrap-dependent charts draw: rows plus the intervals computed for them. */
export interface ChartSnapshot extends Snapshot {
  boot: BootstrapResult | null;
  bootState: BootState;
}

export interface SnapshotSource {
  /** Latest numbers (no bootstrap needed). */
  latest(): Snapshot;
  /** Numbers paired with their intervals (lags `latest` while intervals compute). */
  chart(): ChartSnapshot;
}

const populationPhrase = (snap: Snapshot) => (snap.population === 'unique' ? `${fmtInt(snap.n)} unique reports` : `all ${fmtInt(snap.n)} records`);

const ciText = (lo: number | null | undefined, hi: number | null | undefined) => fmtCI(lo, hi) || '—';

// ------------------------------------------------- headline metrics with CIs

/** A displayed (e.g. scores.json) value that the recomputed interval is not centered on. */
const offCenter = (value: number | null, estimate: number | null) => value !== null && estimate !== null && Math.abs(value - estimate) >= 5e-4;

const PANEL_ROW = 26;
const PANEL_TOP = 2;
const PANEL_BOTTOM = 26;
/** Band outer padding (in rows) so the first and last rows clear the frame and the axis. */
const OUTER = 0.3;
const panelHeight = (rows: number) => Math.round(PANEL_TOP + PANEL_BOTTOM + (rows + 2 * OUTER) * PANEL_ROW);

function renderMultiples(width: number, mode: Mode, snap: ChartSnapshot): Element {
  const c = chrome(mode);
  const rows = snap.order;
  if (!rows.length) return emptyState({ icon: 'chart', title: 'No pipelines to compare' });
  const cols = width >= 900 ? 3 : width >= 540 ? 2 : 1;
  const names = rows.map((r) => r.pipeline.name);
  const longest = Math.max(...names.map((n) => textWidth(n, 12)));
  const labelW = Math.ceil(Math.min(longest, cols === 1 ? width * 0.42 : (width / cols) * 0.45)) + 12;
  const gap = 28;
  const lead = 6;
  const trail = 46;
  const plotW = Math.max(60, Math.floor((width - labelW - cols * trail - (cols - 1) * (lead + gap)) / cols));
  const height = panelHeight(rows.length);
  const first = labelW + plotW + trail;
  const rest = lead + plotW + trail;
  const grid = h('div', {
    class: 'ov-multiples',
    style: { gridTemplateColumns: cols === 1 ? `${first}px` : `${first}px repeat(${cols - 1}, ${rest}px)`, columnGap: `${gap}px` },
  });
  const tickCount = Math.max(2, Math.min(6, Math.round(plotW / 70)));

  HEADLINE_METRICS.forEach((metric, k) => {
    const withLabels = k % cols === 0;
    const marginLeft = withLabels ? labelW : lead;
    const data = rows.map((r) => {
      const iv = snap.boot?.intervals[r.pos]?.[metric];
      return {
        r,
        name: r.pipeline.name,
        value: pointEstimate(r, metric, snap.boot),
        lo: iv?.lo ?? null,
        hi: iv?.hi ?? null,
        color: seriesColor(r.pipeline.index, mode),
      };
    });
    const ax = axisDomain(
      data.flatMap((d) => [d.value, d.lo, d.hi]),
      { clamp: [0, 1], count: tickCount },
    );
    const withCI = data.filter((d) => d.lo !== null && d.hi !== null);
    const withValue = data.filter((d) => d.value !== null);
    const svg = Plot.plot({
      width: marginLeft + plotW + trail,
      height,
      marginLeft,
      marginRight: trail,
      marginTop: PANEL_TOP,
      marginBottom: PANEL_BOTTOM,
      style: plotStyle(mode),
      ariaLabel: `${METRIC_META[metric].label} by pipeline, with 95% intervals`,
      x: { domain: ax.domain, label: null },
      y: { domain: names, paddingInner: 0, paddingOuter: OUTER, label: null, axis: withLabels ? undefined : null },
      marks: [
        Plot.gridX({ ticks: ax.ticks, stroke: c.grid, strokeOpacity: 1 }),
        Plot.axisX({ ticks: ax.ticks, tickFormat: (v: number) => v.toFixed(ax.decimals), tickSize: 0, tickPadding: 6, label: null }),
        withLabels
          ? Plot.axisY({ tickSize: 0, tickPadding: 10, label: null, color: c.ink, tickFormat: (n: string) => fitText(n, labelW - 12) })
          : null,
        Plot.ruleY(withCI, { y: 'name', x1: 'lo', x2: 'hi', stroke: (d) => d.color, strokeWidth: 2, strokeLinecap: 'round' }),
        Plot.dot(withValue, { y: 'name', x: 'value', r: 4.5, fill: (d) => d.color, stroke: c.surface, strokeWidth: 2 }),
        Plot.text(withValue, {
          y: 'name',
          x: (d) => Math.max(d.value!, d.hi ?? d.value!),
          text: (d) => fmtMetric(d.value),
          textAnchor: 'start',
          dx: 8,
          fill: c.ink2,
          fontSize: 11,
          fontVariant: 'tabular-nums',
        }),
      ],
    });
    hoverRows(
      svg,
      data,
      (d) => d.name,
      (d) => {
        const est = snap.boot?.intervals[d.r.pos]?.[metric]?.estimate ?? null;
        return tooltipBody(
          pipelineLabel(d.r.pipeline),
          [
            [METRIC_META[metric].label, fmtMetric(d.value)],
            ['95% CI', d.lo !== null && d.hi !== null ? fmtCI(d.lo, d.hi) : snap.bootState === 'pending' ? 'computing…' : '—'],
            ['Records', fmtInt(snap.n)],
          ],
          offCenter(d.value, est) ? `The interval is recomputed in the browser (estimate ${fmtMetric(est)}); this scores.json value differs.` : undefined,
        );
      },
      c.grid,
    );
    grid.append(
      h(
        'div',
        { class: 'ov-panel' },
        h('div', { class: 'ov-panel-title', dataset: { exportText: '' }, style: { marginLeft: `${marginLeft}px` } }, METRIC_META[metric].label),
        svg,
      ),
    );
  });
  return grid;
}

function ciTable(snap: ChartSnapshot): TableView {
  const t = dataTable<PipelineRow>(
    [
      { key: 'pipeline', label: 'Pipeline', value: (r) => r.pipeline.name, cell: (r) => pipelineLabel(r.pipeline) },
      ...HEADLINE_METRICS.map((m) => ({
        key: m,
        label: METRIC_META[m].label,
        numeric: true,
        value: (r: PipelineRow) => pointEstimate(r, m, snap.boot),
        cell: (r: PipelineRow): Child => {
          const iv = snap.boot?.intervals[r.pos]?.[m];
          return [fmtMetric(pointEstimate(r, m, snap.boot)), iv && iv.lo !== null ? h('div', { class: 'muted ov-detail' }, fmtCI(iv.lo, iv.hi)) : null];
        },
      })),
    ],
    snap.order,
    { caption: 'Headline metrics with 95% bootstrap intervals' },
  );
  const csv = () =>
    toCsv([
      ['pipeline', 'population', 'records', ...HEADLINE_METRICS.flatMap((m) => [m, `${m}_ci_low`, `${m}_ci_high`])],
      ...snap.order.map((r) => [
        r.pipeline.name,
        snap.population,
        snap.n,
        ...HEADLINE_METRICS.flatMap((m) => {
          const iv = snap.boot?.intervals[r.pos]?.[m];
          return [pointEstimate(r, m, snap.boot), iv?.lo ?? null, iv?.hi ?? null];
        }),
      ]),
    ]);
  return { el: t.wrap, csv };
}

export interface CiCard {
  card: ChartCard;
  /** Refresh the text around the chart (subtitle, footnote). */
  sync(): void;
  /** Show or hide the "computing intervals" status. */
  setBusy(on: boolean): void;
}

export function ciCard(src: SnapshotSource): CiCard {
  const subtitle = h('span');
  const foot = h('span');
  const status = h('span', { class: 'ov-status', role: 'status', hidden: true }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Computing intervals…');
  const n = src.latest().rows.length;
  const card = chartCard({
    title: 'Headline metrics with 95% confidence intervals',
    subtitle,
    controls: status,
    footnote: foot,
    exportName: 'headline-metrics-95ci',
    class: 'ov-card',
    minHeight: 2 * (22 + panelHeight(n)) + 18,
    render: (width, mode) => renderMultiples(width, mode, src.chart()),
    table: () => ciTable(src.chart()),
  });
  return {
    card,
    sync() {
      const snap = src.chart();
      subtitle.textContent = `${populationPhrase(snap)[0]!.toUpperCase()}${populationPhrase(snap).slice(1)}. Each panel’s axis is zoomed to its own data.`;
      const B = fmtInt(snap.boot?.B ?? 2000);
      const mixed = snap.order.some((r) =>
        HEADLINE_METRICS.some((m) => offCenter(pointEstimate(r, m, snap.boot), snap.boot?.intervals[r.pos]?.[m]?.estimate ?? null)),
      );
      foot.textContent = [
        `Dots: point estimates. Bars: 95% percentile bootstrap intervals over records (B = ${B}; fixed seed); records — not cells — are resampled because cells within a report are correlated.`,
        mixed
          ? 'Intervals are always recomputed in the browser; where a scores.json differs from that recomputation its dot can sit off-center — switch Metrics to Recomputed to match.'
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    },
    setBusy(on) {
      status.hidden = !on;
    },
  };
}

// ----------------------------------------------------------- error profile

function renderErrors(width: number, mode: Mode, snap: Snapshot): Element {
  const c = chrome(mode);
  const rows = snap.order.filter((r) => r.summary);
  if (!rows.length) return emptyState({ icon: 'chart', title: 'No scores for this population' });
  const data = rows.map((r) => {
    const s = r.summary!;
    return { r, name: r.pipeline.name, fn: s.fn, fp: s.fp, both: s.fp + s.fn - s.errors, errors: s.errors, cells: s.cells, color: seriesColor(r.pipeline.index, mode) };
  });
  const names = data.map((d) => d.name);
  const labelW = Math.ceil(Math.min(Math.max(...names.map((n) => textWidth(n, 12))), width * 0.36));
  const marginLeft = labelW + 26;
  const marginRight = 12;
  const marginTop = 4;
  const marginBottom = 46;
  const plotW = Math.max(80, width - marginLeft - marginRight);

  // One linear scale for both sides; each side keeps room for its count label.
  const L = Math.max(0, ...data.map((d) => d.fn));
  const R = Math.max(0, ...data.map((d) => d.fp));
  const M = Math.max(L, R, 1);
  const left = Math.max(L, 0.2 * M);
  const right = Math.max(R, 0.2 * M);
  const room = 34;
  const pad = (room * (left + right)) / Math.max(1, plotW - 2 * room);
  const domain: [number, number] = [-(left + pad), right + pad];
  const tv = ticks(domain[0], domain[1], Math.max(3, Math.min(10, Math.round(plotW / 80)))).filter((t) => Number.isInteger(t));

  const step = Math.max(30, Math.min(60, (sharedHeight(snap.order.length) - marginTop - marginBottom) / data.length));
  const height = Math.round(marginTop + marginBottom + data.length * step);
  const thickness = Math.min(18, Math.round(step * 0.55));
  const inset = (step - thickness) / 2;

  const svg = Plot.plot({
    width,
    height,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    style: plotStyle(mode),
    ariaLabel: 'Informative errors per pipeline: false negatives to the left, false positives to the right',
    x: { domain, label: null },
    y: { domain: names, padding: 0, label: null },
    marks: [
      Plot.gridX({ ticks: tv, stroke: c.grid, strokeOpacity: 1 }),
      Plot.barX(data, { y: 'name', x1: () => 0, x2: (d) => -d.fn, fill: STATUS.critical, insetTop: inset, insetBottom: inset, rx1: 4 }),
      Plot.barX(data, { y: 'name', x1: () => 0, x2: (d) => d.fp, fill: STATUS.serious, insetTop: inset, insetBottom: inset, rx2: 4 }),
      Plot.ruleX([0], { stroke: c.ink3, strokeWidth: 1 }),
      Plot.text(data, { y: 'name', x: (d) => -d.fn, text: (d) => fmtInt(d.fn), textAnchor: 'end', dx: -6, fill: c.ink2, fontSize: 11, fontVariant: 'tabular-nums' }),
      Plot.text(data, { y: 'name', x: (d) => d.fp, text: (d) => fmtInt(d.fp), textAnchor: 'start', dx: 6, fill: c.ink2, fontSize: 11, fontVariant: 'tabular-nums' }),
      Plot.axisX({ ticks: tv, tickFormat: (v: number) => fmtInt(Math.abs(v)), tickSize: 0, tickPadding: 6, label: null }),
      Plot.axisY({ tickSize: 0, tickPadding: 22, label: null, color: c.ink, tickFormat: (n: string) => fitText(n, labelW) }),
      // Pipeline identity next to each name (bars are colored by error type).
      Plot.dot(data, { y: 'name', frameAnchor: 'left', dx: -12, r: 4, fill: (d) => d.color }),
      Plot.text([{ x: 0, t: '← Missed (FN)' }], { x: 'x', text: 't', frameAnchor: 'bottom', lineAnchor: 'top', textAnchor: 'end', dx: -8, dy: 26, fill: c.ink2, fontSize: 11, fontWeight: 600 }),
      Plot.text([{ x: 0, t: 'Over-called (FP) →' }], { x: 'x', text: 't', frameAnchor: 'bottom', lineAnchor: 'top', textAnchor: 'start', dx: 8, dy: 26, fill: c.ink2, fontSize: 11, fontWeight: 600 }),
    ],
  });
  hoverRows(
    svg,
    data,
    (d) => d.name,
    (d) =>
      tooltipBody(pipelineLabel(d.r.pipeline), [
        [[h('span', { class: 'ov-key fn' }), 'Missed (FN)'], fmtInt(d.fn)],
        [[h('span', { class: 'ov-key fp' }), 'Over-called (FP)'], fmtInt(d.fp)],
        ['Wrong informative label (both)', fmtInt(d.both)],
        ['Cells with an error', `${fmtInt(d.errors)} of ${fmtInt(d.cells)}`],
      ]),
    c.grid,
  );
  return svg;
}

function errorTable(snap: Snapshot): TableView {
  const rows = snap.order;
  const num = (f: (r: PipelineRow) => number | undefined, key: string, label: string) => ({
    key,
    label,
    numeric: true,
    value: (r: PipelineRow) => f(r) ?? null,
    cell: (r: PipelineRow) => fmtInt(f(r)),
  });
  const t = dataTable<PipelineRow>(
    [
      { key: 'pipeline', label: 'Pipeline', value: (r) => r.pipeline.name, cell: (r) => pipelineLabel(r.pipeline) },
      num((r) => r.summary?.tp, 'tp', 'TP'),
      num((r) => r.summary?.fp, 'fp', 'FP'),
      num((r) => r.summary?.fn, 'fn', 'FN'),
      num((r) => r.summary?.errors, 'errors', 'Cells with an error'),
      num((r) => r.summary?.cells, 'cells', 'Cells'),
    ],
    rows,
    { caption: 'Informative errors per pipeline' },
  );
  return { el: t.wrap, csv: t.toCsv };
}

export interface SimpleCard {
  card: ChartCard;
  sync(): void;
}

export function errorCard(src: SnapshotSource): SimpleCard {
  const subtitle = h('span');
  const foot = h('span');
  const card = chartCard({
    title: 'Error profile',
    subtitle,
    footnote: foot,
    exportName: 'error-profile',
    class: 'ov-card',
    minHeight: sharedHeight(src.latest().rows.length),
    render: (width, mode) => renderErrors(width, mode, src.latest()),
    table: () => errorTable(src.latest()),
  });
  return {
    card,
    sync() {
      const snap = src.latest();
      subtitle.textContent = `Informative errors on ${populationPhrase(snap)}: misses (FN) to the left, over-calls (FP) to the right. A wrong informative label counts on both sides.`;
      const cells = snap.rows.find((r) => r.summary)?.summary?.cells;
      foot.textContent = `Counts are cells: records × categorical variables${cells ? ` (${fmtInt(cells)} per pipeline)` : ''}. Hover a row for the cells with an error.`;
    },
  };
}

// --------------------------------------------------------- cost vs. accuracy

function formatCost(key: CostKey, v: number | null): string {
  if (v === null) return '—';
  return key === 'wall' ? fmtDuration(v) : fmtInt(v);
}

function axisNumber(v: number): string {
  return Number.isInteger(v) ? fmtInt(v) : String(Number(v.toPrecision(4)));
}

function renderCost(width: number, mode: Mode, snap: ChartSnapshot, key: CostKey): Element {
  const c = chrome(mode);
  const meta = COST_META[key];
  const points = snap.order
    .map((r) => {
      const iv = snap.boot?.intervals[r.pos]?.informative_f1;
      return {
        r,
        name: r.pipeline.name,
        raw: meta.value(r.cost),
        y: pointEstimate(r, 'informative_f1', snap.boot),
        lo: iv?.lo ?? null,
        hi: iv?.hi ?? null,
        color: seriesColor(r.pipeline.index, mode),
      };
    })
    .filter((p) => p.raw !== null && p.y !== null);
  if (!points.length) {
    return emptyState({ icon: 'chart', title: `No ${meta.label.toLowerCase()} to plot`, body: 'No pipeline reports this measure with an informative F1.' });
  }
  const unit = key === 'wall' ? durationUnit(Math.max(...points.map((p) => p.raw!))) : null;
  const data = points.map((p) => ({ ...p, x: p.raw! / (unit?.div ?? 1) }));

  const H = sharedHeight(snap.order.length);
  const marginLeft = 46;
  const marginRight = 18;
  const marginTop = 24;
  const marginBottom = 42;
  const plotW = Math.max(120, width - marginLeft - marginRight);
  const plotH = H - marginTop - marginBottom;

  // x: an honest zero baseline up to a nice maximum.
  const xCount = Math.max(3, Math.min(8, Math.round(plotW / 90)));
  const xmax = Math.max(...data.map((d) => d.x));
  const [, x1] = nice(0, xmax > 0 ? xmax * 1.06 : 1, xCount);
  const xt = ticks(0, x1, xCount).filter((t) => unit !== null || Number.isInteger(t)); // counts: whole ticks only
  const xFormat = (v: number) => (v === 0 ? '0' : unit ? axisNumber(v) : fmtCompact(v));
  // y: informative F1, zoomed to the points and their intervals.
  const ay = axisDomain(
    data.flatMap((d) => [d.y, d.lo, d.hi]),
    { clamp: [0, 1], count: Math.max(3, Math.round(plotH / 55)) },
  );

  // Direct labels: place in pixel space, avoiding dots, whiskers and each other.
  const sx = (v: number) => marginLeft + (v / x1) * plotW;
  const sy = (v: number) => marginTop + (1 - (v - ay.domain[0]) / (ay.domain[1] - ay.domain[0])) * plotH;
  const whiskers = data
    .filter((d) => d.lo !== null && d.hi !== null)
    .map((d) => ({ x0: sx(d.x) - 2, x1: sx(d.x) + 2, y0: sy(d.hi!), y1: sy(d.lo!) }));
  const placed = placeLabels(
    data.map((d) => ({ x: sx(d.x), y: sy(d.y!), w: textWidth(d.name, 12, 500) })),
    { x0: marginLeft + 2, y0: marginTop - 8, x1: width - 2, y1: H - marginBottom - 2 },
    { r: 5, h: 15, gap: 7, obstacles: whiskers },
  );

  const svg = Plot.plot({
    width,
    height: H,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    style: plotStyle(mode),
    ariaLabel: `Informative F1 against ${meta.label.toLowerCase()}, one dot per pipeline`,
    x: { domain: [0, x1], label: null },
    y: { domain: ay.domain, label: null },
    marks: [
      Plot.gridX({ ticks: xt, stroke: c.grid, strokeOpacity: 1 }),
      Plot.gridY({ ticks: ay.ticks, stroke: c.grid, strokeOpacity: 1 }),
      Plot.axisX({ ticks: xt, tickFormat: xFormat, tickSize: 0, tickPadding: 6, label: `${meta.label}${unit ? ` (${unit.label})` : ''}` }),
      Plot.axisY({ ticks: ay.ticks, tickFormat: (v: number) => v.toFixed(ay.decimals), tickSize: 0, tickPadding: 6, label: 'Informative F1' }),
      Plot.ruleX(
        data.filter((d) => d.lo !== null && d.hi !== null),
        { x: 'x', y1: 'lo', y2: 'hi', stroke: (d) => d.color, strokeWidth: 2, strokeLinecap: 'round' },
      ),
      Plot.dot(data, { x: 'x', y: 'y', r: 5, fill: (d) => d.color, stroke: c.surface, strokeWidth: 2 }),
      ...data.map((d, i) =>
        Plot.text([d], {
          x: 'x',
          y: 'y',
          text: 'name',
          textAnchor: placed[i]!.textAnchor,
          dx: placed[i]!.dx,
          dy: placed[i]!.dy,
          fill: c.ink,
          fontSize: 12,
          fontWeight: 500,
          stroke: c.surface,
          strokeWidth: 3,
          paintOrder: 'stroke',
        }),
      ),
    ],
  });
  hoverNearest(
    svg,
    data,
    (d) => [d.x, d.y!],
    (d) =>
      tooltipBody(pipelineLabel(d.r.pipeline), [
        ['Informative F1', fmtMetric(d.y)],
        ['95% CI', d.lo !== null && d.hi !== null ? fmtCI(d.lo, d.hi) : snap.bootState === 'pending' ? 'computing…' : '—'],
        [meta.label, formatCost(key, d.raw)],
        ...(key === 'calls' ? [] : ([['LLM calls', fmtInt(d.r.cost.calls)]] as [Child, Child][])),
        ...(key === 'tokens' ? [] : ([['Total tokens', fmtInt(d.r.cost.totalTokens)]] as [Child, Child][])),
        ...(key === 'wall' ? [] : ([['Wall-clock time', fmtDuration(d.r.cost.wallSeconds)]] as [Child, Child][])),
      ]),
  );
  return svg;
}

function costTable(snap: ChartSnapshot): TableView {
  const f1 = (r: PipelineRow) => pointEstimate(r, 'informative_f1', snap.boot);
  const iv = (r: PipelineRow) => snap.boot?.intervals[r.pos]?.informative_f1;
  const int = (key: string, label: string, f: (r: PipelineRow) => number | null) => ({
    key,
    label,
    numeric: true,
    value: f,
    cell: (r: PipelineRow) => fmtInt(f(r)),
  });
  const t = dataTable<PipelineRow>(
    [
      { key: 'pipeline', label: 'Pipeline', value: (r) => r.pipeline.name, cell: (r) => pipelineLabel(r.pipeline) },
      { key: 'f1', label: 'Informative F1', numeric: true, value: f1, cell: (r) => fmtMetric(f1(r)) },
      { key: 'f1_lo', label: 'F1 CI low', numeric: true, value: (r) => iv(r)?.lo ?? null, cell: (r) => fmtMetric(iv(r)?.lo) },
      { key: 'f1_hi', label: 'F1 CI high', numeric: true, value: (r) => iv(r)?.hi ?? null, cell: (r) => fmtMetric(iv(r)?.hi) },
      int('calls', 'LLM calls', (r) => r.cost.calls),
      int('prompt', 'Prompt tokens', (r) => r.cost.promptTokens),
      int('output', 'Output tokens', (r) => r.cost.outputTokens),
      int('thinking', 'Thinking tokens', (r) => r.cost.thoughtTokens),
      int('total', 'Total tokens', (r) => r.cost.totalTokens),
      { key: 'wall', label: 'Wall-clock seconds', numeric: true, value: (r) => r.cost.wallSeconds, cell: (r) => fmtDuration(r.cost.wallSeconds) },
    ],
    snap.order,
    { caption: 'Informative F1 and run cost per pipeline' },
  );
  return { el: t.wrap, csv: t.toCsv };
}

export function costCard(src: SnapshotSource, costs: readonly CostKey[]): SimpleCard {
  let key: CostKey = costs[0] ?? 'tokens';
  const foot = h('span');
  let card: ChartCard;
  const control =
    costs.length > 1
      ? segmented<CostKey>({
          label: 'Cost measure on the x-axis',
          size: 'sm',
          value: key,
          options: costs.map((k) => ({ value: k, label: COST_META[k].short, title: COST_META[k].title })),
          onChange: (k) => {
            key = k;
            sync();
            card.redraw();
          },
        })
      : null;
  card = chartCard({
    title: 'Cost vs. accuracy',
    subtitle: costs.length ? `Informative F1 against ${costs.length > 1 ? 'a cost measure' : COST_META[key].label.toLowerCase()} from each run.json.` : 'Informative F1 against run cost from run.json.',
    controls: control?.el,
    footnote: costs.length ? foot : undefined,
    exportName: 'cost-vs-accuracy',
    class: 'ov-card',
    minHeight: sharedHeight(src.latest().rows.length),
    render: (width, mode) =>
      costs.length
        ? renderCost(width, mode, src.chart(), key)
        : emptyState({ icon: 'chart', title: 'No run cost recorded', body: 'None of the pipelines has usage (calls, tokens or time) in its run.json.' }),
    table: costs.length ? () => costTable(src.chart()) : undefined,
  });
  function sync() {
    const snap = src.chart();
    const absent = snap.order.filter((r) => COST_META[key].value(r.cost) === null).map((r) => r.pipeline.name);
    foot.textContent = [
      'The x-axis starts at zero. Whiskers: 95% bootstrap intervals of informative F1.',
      absent.length ? `Not shown (no ${COST_META[key].label.toLowerCase()} in run.json): ${absent.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return { card, sync };
}

// ------------------------------------------------------ pairwise differences

const PAIR_METRICS: { value: MetricKey; label: string }[] = [
  { value: 'informative_f1', label: 'Informative F1' },
  { value: 'mean_field_macro_f1', label: 'Macro-F1' },
  { value: 'cell_accuracy', label: 'Accuracy' },
  { value: 'error_free_rate', label: 'Error-free' },
];

const PAIR_ROW = 30;
const PAIR_ROW_STACKED = 58;
const PAIR_TOP = 4;
const PAIR_BOTTOM = 42;
const EXCLUDES = '· CI excludes 0';

const forestHeight = (pairs: number, stacked: boolean) =>
  Math.round(PAIR_TOP + PAIR_BOTTOM + (pairs + 2 * OUTER) * (stacked ? PAIR_ROW_STACKED : PAIR_ROW));

function renderPairs(width: number, mode: Mode, snap: ChartSnapshot, metric: MetricKey): Element {
  const c = chrome(mode);
  const P = snap.rows.length;
  const nPairs = (P * (P - 1)) / 2;
  if (!snap.boot) {
    if (snap.bootState === 'pending') {
      return h(
        'div',
        { class: 'ov-pending', style: { height: `${forestHeight(nPairs, false)}px` } },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        'Computing paired intervals…',
      );
    }
    return emptyState({ icon: 'chart', title: 'Intervals unavailable', body: 'Paired bootstrap intervals need at least two records in the population.' });
  }
  const pairs = pairRows(snap.boot, metric);
  if (!pairs.length) return emptyState({ icon: 'chart', title: 'No pairs to compare' });
  const name = (pos: number) => snap.rows[pos]?.pipeline.name ?? `#${pos + 1}`;
  const label = (p: PairRow) => `${name(p.a)} − ${name(p.b)}`;
  const value = (p: PairRow) => (p.estimate === null ? '—' : `${fmtSigned(p.estimate)} ${fmtCI(p.lo, p.hi)}`.trim());
  const valueW = Math.ceil(Math.max(...pairs.map((p) => textWidth(value(p), 11))));
  const suffixW = pairs.some((p) => p.excludesZero) ? Math.ceil(textWidth(EXCLUDES, 11)) + 8 : 0;
  const labelW = Math.ceil(Math.max(...pairs.map((p) => textWidth(label(p), 12))));
  const wideLeft = labelW + 14;
  const wideRight = valueW + suffixW + 24;
  const stacked = width - wideLeft - wideRight < 220;
  const marginLeft = stacked ? 8 : wideLeft;
  const marginRight = stacked ? 12 : wideRight;
  const height = forestHeight(pairs.length, stacked);
  const plotW = Math.max(80, width - marginLeft - marginRight);
  const ax = axisDomain(
    pairs.flatMap((p) => [p.estimate, p.lo, p.hi]),
    { include: [0], minSpan: 0.01, pad: 0.08, count: Math.max(3, Math.min(8, Math.round(plotW / 80))) },
  );
  const data = pairs.map((p) => ({ ...p, label: label(p), value: value(p) }));
  const ci = data.filter((d) => d.lo !== null && d.hi !== null);
  const filled = data.filter((d) => d.estimate !== null && d.excludesZero);
  const hollow = data.filter((d) => d.estimate !== null && !d.excludesZero);
  const textOpts = { fontSize: 11, fontVariant: 'tabular-nums', fill: c.ink2 } as const;
  const metricLabel = METRIC_META[metric].label;

  const svg = Plot.plot({
    width,
    height,
    marginLeft,
    marginRight,
    marginTop: PAIR_TOP,
    marginBottom: PAIR_BOTTOM,
    style: plotStyle(mode),
    ariaLabel: `Pairwise differences in ${metricLabel} with paired 95% bootstrap intervals`,
    x: { domain: ax.domain, label: null },
    y: { domain: data.map((d) => d.label), paddingInner: 0, paddingOuter: OUTER, label: null, axis: stacked ? null : undefined },
    marks: [
      Plot.gridX({ ticks: ax.ticks, stroke: c.grid, strokeOpacity: 1 }),
      Plot.ruleX([0], { stroke: c.ink3, strokeWidth: 1 }),
      Plot.axisX({
        ticks: ax.ticks,
        tickFormat: (v: number) => fmtSigned(v, ax.decimals),
        tickSize: 0,
        tickPadding: 6,
        label: `${metricLabel} difference`,
      }),
      stacked ? null : Plot.axisY({ tickSize: 0, tickPadding: 12, label: null, color: c.ink, tickFormat: (l: string) => fitText(l, labelW + 2) }),
      Plot.ruleY(ci, { y: 'label', x1: 'lo', x2: 'hi', stroke: c.ink2, strokeWidth: 2, strokeLinecap: 'round' }),
      Plot.dot(filled, { y: 'label', x: 'estimate', r: 4.5, fill: c.ink2, stroke: c.surface, strokeWidth: 2 }),
      Plot.dot(hollow, { y: 'label', x: 'estimate', r: 4, fill: c.surface, stroke: c.ink2, strokeWidth: 1.75 }),
      stacked
        ? [
            Plot.text(data, { y: 'label', text: (d) => fitText(d.label, width - 20), frameAnchor: 'left', textAnchor: 'start', dy: -17, fill: c.ink, fontSize: 12 }),
            Plot.text(data, { y: 'label', text: (d) => (d.excludesZero ? `${d.value} ${EXCLUDES}` : d.value), frameAnchor: 'left', textAnchor: 'start', dy: 17, ...textOpts }),
          ]
        : [
            Plot.text(data, { y: 'label', text: 'value', frameAnchor: 'right', textAnchor: 'start', dx: 14, ...textOpts }),
            Plot.text(
              data.filter((d) => d.excludesZero),
              { y: 'label', text: () => EXCLUDES, frameAnchor: 'right', textAnchor: 'start', dx: 14 + valueW + 8, ...textOpts, fill: c.ink3 },
            ),
          ],
    ],
  });
  hoverRows(
    svg,
    data,
    (d) => d.label,
    (d) => {
      const a = snap.rows[d.a]!.pipeline;
      const b = snap.rows[d.b]!.pipeline;
      return tooltipBody(h('span', { class: 'ov-pair-title' }, pipelineLabel(a), h('span', { class: 'muted' }, '−'), pipelineLabel(b)), [
        [`${metricLabel} difference`, fmtSigned(d.estimate)],
        ['95% CI', ciText(d.lo, d.hi)],
        [`${a.name} ahead in`, d.pBetter === null ? '—' : `${fmtPct(d.pBetter)} of replicates`],
        ['Records', fmtInt(snap.boot?.n ?? snap.n)],
      ]);
    },
    c.grid,
  );
  return svg;
}

function pairTable(snap: ChartSnapshot, metric: MetricKey): TableView {
  const pairs = snap.boot ? pairRows(snap.boot, metric) : [];
  const pipe = (pos: number) => snap.rows[pos]!.pipeline;
  const t = dataTable<PairRow>(
    [
      { key: 'a', label: 'Ahead', value: (p) => pipe(p.a).name, cell: (p) => pipelineLabel(pipe(p.a)) },
      { key: 'b', label: 'Behind', value: (p) => pipe(p.b).name, cell: (p) => pipelineLabel(pipe(p.b)) },
      { key: 'difference', label: 'Difference', numeric: true, value: (p) => p.estimate, cell: (p) => fmtSigned(p.estimate) },
      { key: 'ci_low', label: 'CI low', numeric: true, value: (p) => p.lo, cell: (p) => fmtSigned(p.lo, 3, false) },
      { key: 'ci_high', label: 'CI high', numeric: true, value: (p) => p.hi, cell: (p) => fmtSigned(p.hi, 3, false) },
      { key: 'p_ahead', label: 'Share of replicates ahead', numeric: true, value: (p) => p.pBetter, cell: (p) => fmtPct(p.pBetter) },
      { key: 'excludes_zero', label: 'CI excludes 0', value: (p) => (p.excludesZero ? 'yes' : 'no') },
    ],
    pairs,
    { caption: `Pairwise differences in ${METRIC_META[metric].label}` },
  );
  return { el: t.wrap, csv: t.toCsv };
}

export function pairCard(src: SnapshotSource): SimpleCard {
  let metric: MetricKey = 'informative_f1';
  let card: ChartCard;
  const control = segmented<MetricKey>({
    label: 'Metric',
    size: 'sm',
    value: metric,
    options: PAIR_METRICS.map((m) => ({ value: m.value, label: m.label, title: METRIC_META[m.value].label })),
    onChange: (m) => {
      metric = m;
      card.redraw();
    },
  });
  const P = src.latest().rows.length;
  card = chartCard({
    title: 'Pairwise differences',
    subtitle: 'Each row is one pair: the pipeline ahead minus the one behind, with a paired 95% bootstrap interval.',
    controls: control.el,
    footnote:
      'Paired bootstrap (B = 2,000; fixed seed): every replicate resamples the records once and scores both pipelines on the same resampled records, so differences in report difficulty cancel out. Filled dot: the interval excludes 0; hollow dot: it includes 0.',
    exportName: 'pairwise-differences',
    class: 'ov-card',
    minHeight: forestHeight((P * (P - 1)) / 2, false),
    render: (width, mode) => renderPairs(width, mode, src.chart(), metric),
    table: () => pairTable(src.chart(), metric),
  });
  return { card, sync() {} };
}
