/**
 * Error map: every record in the current filter as a column, each shown
 * pipeline as a row, filled by the record's categorical error count. It is a
 * navigation strip (hover for details, click to open), not an exported chart.
 */

import type { Analysis } from '../../core/analysis';
import type { RecordId } from '../../core/types';
import { hideTooltip, showTooltip } from '../../ui/components';
import { h, s } from '../../ui/dom';
import { chrome, errorFill, seriesColor, type Mode } from '../../ui/palette';
import { countOutcomes, describeCounts } from './model';
import { swatch } from './ui';

export interface ErrorMapInput {
  analysis: Analysis;
  /** Columns, in display order. */
  ids: readonly RecordId[];
  /** Rows: pipeline indices (analysis order). */
  rows: readonly number[];
  /** Error count mapped to the darkest ramp step. */
  max: number;
  mode: Mode;
  /** Available width in CSS pixels. */
  width: number;
  onPick: (rid: RecordId) => void;
}

export interface ErrorMap {
  el: SVGSVGElement;
  /** Outline a record's column; returns the column's x center, or null when the record is not on the map. */
  setCurrent(rid: RecordId | null): number | null;
  /** True when some shown pipeline was not run on some record of the map. */
  hasNotRun: boolean;
}

const LABEL_W = 22;
const PAD = 3;

const rectPath = (x: number, y: number, w: number, hgt: number) => `M${x},${y}h${w}v${hgt}h${-w}z`;

export function buildErrorMap(input: ErrorMapInput): ErrorMap {
  const { analysis, ids, rows, max, mode, width, onPick } = input;
  const ink = chrome(mode);
  const n = ids.length;

  // Squares of 10 px with 2 px gaps; shrink (down to 3 px) to fit the width, then scroll.
  const fit = (width - LABEL_W - PAD) / Math.max(1, n);
  let cell = 10;
  let gap = 2;
  if (fit < cell + gap) {
    gap = fit >= 6 ? 2 : 1;
    cell = Math.max(3, Math.floor(fit - gap));
  }
  const pitch = cell + gap;
  const rowH = Math.max(cell, 8);
  const rowGap = 2;
  const rowsH = rows.length * rowH + Math.max(0, rows.length - 1) * rowGap;
  const svgW = LABEL_W + Math.max(0, n * pitch - gap) + PAD;
  const svgH = rowsH + PAD * 2;
  const rowY = (r: number) => PAD + r * (rowH + rowGap);
  const colX = (k: number) => LABEL_W + k * pitch;

  // One path per fill keeps the DOM small for long record lists.
  const paths = new Map<string, string[]>();
  const add = (key: string, d: string) => {
    let list = paths.get(key);
    if (!list) paths.set(key, (list = []));
    list.push(d);
  };
  let hasNotRun = false;
  rows.forEach((pi, r) => {
    const pa = analysis.pipelines[pi]!;
    const y = rowY(r);
    ids.forEach((rid, k) => {
      const x = colX(k);
      const count = pa.errorCount.get(rid);
      if (count === undefined) {
        hasNotRun = true;
        add('notrun', rectPath(x + 0.5, y + 0.5, cell - 1, rowH - 1));
      } else add(count ? errorFill(count, max, mode)! : 'zero', rectPath(x, y, cell, rowH));
    });
  });

  const svg = s('svg', {
    class: 'rec-map-svg',
    width: svgW,
    height: svgH,
    viewBox: `0 0 ${svgW} ${svgH}`,
    role: 'img',
    'aria-label': `Error map: ${n} records by ${rows.length} pipelines, shaded by the number of errors. Click a column to open that record.`,
    'shape-rendering': 'crispEdges',
  });
  rows.forEach((pi, r) => {
    svg.appendChild(
      s('circle', {
        cx: 8,
        cy: rowY(r) + rowH / 2,
        r: 4,
        fill: seriesColor(analysis.pipelines[pi]!.pipeline.index, mode),
        'shape-rendering': 'geometricPrecision',
      }),
    );
  });
  for (const [key, ds] of paths) {
    const d = ds.join('');
    if (key === 'notrun') svg.appendChild(s('path', { d, fill: 'none', stroke: ink.axis, 'stroke-width': 1 }));
    else svg.appendChild(s('path', { d, fill: key === 'zero' ? ink.grid : key }));
  }

  const outline = (stroke: string, strokeWidth: number) =>
    s('rect', {
      y: PAD - 2,
      width: cell + 4,
      height: rowsH + 4,
      rx: 2,
      fill: 'none',
      stroke,
      'stroke-width': strokeWidth,
      visibility: 'hidden',
      'pointer-events': 'none',
      'shape-rendering': 'geometricPrecision',
    });
  const hover = outline(ink.ink3, 1);
  const current = outline(ink.ink, 1.5);
  svg.append(hover, current);

  const colOf = new Map<RecordId, number>();
  ids.forEach((rid, k) => colOf.set(rid, k));
  const colAt = (x: number) => {
    const k = Math.floor((x - LABEL_W + gap / 2) / pitch);
    return k >= 0 && k < n ? k : -1;
  };
  const rowAt = (y: number) => Math.max(0, Math.min(rows.length - 1, Math.floor((y - PAD + rowGap / 2) / (rowH + rowGap))));

  const cellTip = (rid: RecordId, pi: number) => {
    const pa = analysis.pipelines[pi]!;
    const scored = pa.errorCount.has(rid);
    let desc = scored ? describeCounts(countOutcomes(pa.outcomes.get(rid))) : 'not run on this record';
    if (scored && !pa.pipeline.predictions.has(rid)) desc += ' — no prediction';
    return h(
      'div',
      { class: 'rec-tt-line' },
      h('strong', null, `#${rid}`),
      h('span', { class: 'tt-muted' }, '·'),
      swatch(pa.pipeline),
      h('span', null, `${pa.pipeline.name}: ${desc}`),
    );
  };

  const hideHover = () => {
    hover.setAttribute('visibility', 'hidden');
    hideTooltip();
  };
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const r = rowAt(y);
    const at = { x: e.clientX, y: e.clientY };
    if (x < LABEL_W - 6) {
      hover.setAttribute('visibility', 'hidden');
      const p = analysis.pipelines[rows[r]!]!.pipeline;
      showTooltip(at, h('div', { class: 'rec-tt-line' }, swatch(p), h('span', null, p.name)));
      return;
    }
    const k = colAt(x);
    if (k < 0) {
      hideHover();
      return;
    }
    hover.setAttribute('x', String(colX(k) - 2));
    hover.setAttribute('visibility', 'visible');
    showTooltip(at, cellTip(ids[k]!, rows[r]!));
  });
  svg.addEventListener('pointerleave', hideHover);
  svg.addEventListener('click', (e) => {
    const box = svg.getBoundingClientRect();
    const k = colAt(e.clientX - box.left);
    if (k >= 0) onPick(ids[k]!);
  });

  return {
    el: svg,
    hasNotRun,
    setCurrent(rid) {
      const k = rid === null ? undefined : colOf.get(rid);
      if (k === undefined) {
        current.setAttribute('visibility', 'hidden');
        return null;
      }
      current.setAttribute('x', String(colX(k) - 2));
      current.setAttribute('visibility', 'visible');
      return colX(k) + cell / 2;
    },
  };
}
