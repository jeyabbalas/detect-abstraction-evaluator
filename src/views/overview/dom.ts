/** Small DOM helpers for the overview: text measurement, chart hover layers, card shells. */

import type * as Plot from '@observablehq/plot';
import { FONT_FAMILY } from '../../ui/chart';
import { hideTooltip, showTooltip } from '../../ui/components';
import { h, s, type Child } from '../../ui/dom';

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Rendered width of a label in the chart font (canvas-measured; estimated as a fallback). */
export function textWidth(text: string, size = 12, weight: number | string = 400): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return text.length * size * 0.58;
  measureCtx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  return measureCtx.measureText(text).width;
}

/** Truncate with an ellipsis to fit `max` px. */
export function fitText(text: string, max: number, size = 12, weight: number | string = 400): string {
  if (textWidth(text, size, weight) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(`${text.slice(0, mid)}…`, size, weight) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, Math.max(1, lo))}…`;
}

type PlotSvg = SVGSVGElement & Plot.Plot;

function asPlot(el: Element): PlotSvg | null {
  return el instanceof SVGSVGElement && typeof (el as Partial<PlotSvg>).scale === 'function' ? (el as PlotSvg) : null;
}

/** Pointer position in the SVG's own coordinates. */
function local(svg: SVGSVGElement, e: PointerEvent): [number, number] {
  const r = svg.getBoundingClientRect();
  const w = Number(svg.getAttribute('width')) || r.width;
  const k = r.width ? w / r.width : 1;
  return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
}

/**
 * Row hover for charts with a band y scale: the whole row (≥ the band step)
 * is the hit target, a faint band highlights it and the shared tooltip shows
 * `content`. Values stay reachable without hovering through the table view.
 */
export function hoverRows<R>(el: Element, rows: readonly R[], key: (r: R) => string, content: (r: R) => Child, highlight?: string): void {
  const svg = asPlot(el);
  const y = svg?.scale('y');
  if (!svg || !y || y.bandwidth === undefined) return;
  const band = y.bandwidth;
  const step = y.step ?? band;
  const center = (r: R) => Number(y.apply(key(r))) + band / 2;
  const width = Number(svg.getAttribute('width')) || 0;
  let hl: SVGRectElement | null = null;
  // Created on first hover (so exports stay clean), beneath every mark: Plot puts a <style> first, then one <g> per mark.
  const highlightRect = () => {
    if (!hl && highlight) {
      hl = s('rect', { x: 0, width, height: step, rx: 4, fill: highlight, 'fill-opacity': 0.55, 'pointer-events': 'none', 'aria-hidden': 'true' });
      svg.insertBefore(hl, svg.querySelector(':scope > g') ?? svg.firstChild);
    }
    return hl;
  };
  const hide = () => {
    hl?.setAttribute('visibility', 'hidden');
    hideTooltip();
  };
  svg.addEventListener('pointermove', (e) => {
    const [, py] = local(svg, e);
    const hit = rows.find((r) => Math.abs(py - center(r)) <= step / 2);
    if (!hit) {
      hide();
      return;
    }
    const rect = highlightRect();
    if (rect) {
      rect.setAttribute('y', String(center(hit) - step / 2));
      rect.setAttribute('visibility', 'visible');
    }
    showTooltip({ x: e.clientX, y: e.clientY }, content(hit));
  });
  svg.addEventListener('pointerleave', hide);
}

/** Nearest-point hover (scatter): any pointer within `radius` px of a point shows its tooltip. */
export function hoverNearest<R>(
  el: Element,
  points: readonly R[],
  at: (r: R) => [number, number] | null,
  content: (r: R) => Child,
  radius = 32,
): void {
  const svg = asPlot(el);
  const x = svg?.scale('x');
  const y = svg?.scale('y');
  if (!svg || !x || !y) return;
  const pos = points.map((p) => {
    const v = at(p);
    return v ? ([Number(x.apply(v[0])), Number(y.apply(v[1]))] as const) : null;
  });
  svg.addEventListener('pointermove', (e) => {
    const [px, py] = local(svg, e);
    let best = -1;
    let bestD = radius * radius;
    pos.forEach((q, i) => {
      if (!q) return;
      const d = (q[0] - px) ** 2 + (q[1] - py) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) hideTooltip();
    else showTooltip({ x: e.clientX, y: e.clientY }, content(points[best]!));
  });
  svg.addEventListener('pointerleave', () => hideTooltip());
}

/** A card with the shared head/body structure (for non-chart cards). */
export function cardShell(opts: { title: Child; subtitle?: Child; actions?: Child; body: Child; class?: string; foot?: Child }): HTMLElement {
  return h(
    'section',
    { class: ['card', 'ov-card', opts.class] },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'card-titles' }, h('h2', { class: 'card-title' }, opts.title), opts.subtitle ? h('div', { class: 'card-subtitle' }, opts.subtitle) : null),
      opts.actions ? h('div', { class: 'card-actions' }, opts.actions) : null,
    ),
    h('div', { class: 'card-body' }, opts.body),
    opts.foot ? h('div', { class: 'card-foot' }, opts.foot) : null,
  );
}

/** Resolve after the browser has painted (so a loading state shows before heavy work). */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}
