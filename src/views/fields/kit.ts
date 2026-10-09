/**
 * Small UI building blocks for the Fields view: text measurement, exportable
 * SVG legends (`data-chart`), hit areas and one delegated hover/click/keyboard
 * binding for chart targets.
 */

import { hideTooltip, showTooltip } from '../../ui/components';
import { FONT_FAMILY } from '../../ui/chart';
import { s, type Child } from '../../ui/dom';
import { chrome, errorRamp, type Mode } from '../../ui/palette';
import { fmtInt } from '../../ui/format';
import { errorBins, truncateToWidth } from './model';

// ------------------------------------------------------------------ text

let ctx2d: CanvasRenderingContext2D | null | undefined;

/** Rendered width of `text` in the chart font (falls back to ≈ 0.6 em per character). */
export function textWidth(text: string, size = 12, weight = 400): number {
  if (ctx2d === undefined) {
    try {
      ctx2d = document.createElement('canvas').getContext('2d');
    } catch {
      ctx2d = null;
    }
  }
  if (!ctx2d) return text.length * size * 0.6;
  ctx2d.font = `${weight} ${size}px ${FONT_FAMILY}`;
  return ctx2d.measureText(text).width;
}

export function fitText(text: string, max: number, size = 12, weight = 400): string {
  return truncateToWidth(text, max, (t) => textWidth(t, size, weight));
}

// ----------------------------------------------------------------- colors

/** Zero-error cells: a surface-2 equivalent (grid blended into the surface) so the grid stays visible. */
export function neutralFill(mode: Mode): string {
  const c = chrome(mode);
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round((channel(c.grid, i) + channel(c.surface, i)) / 2).toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------- legends

/**
 * Threshold legend for the error ramp: a neutral "0" swatch, then one swatch
 * per ramp step labelled with the counts it covers. Null when max is 0.
 */
export function rampLegend(max: number, mode: Mode, maxWidth: number, title = 'Informative errors (FP + FN)'): SVGSVGElement | null {
  if (max <= 0) return null;
  const c = chrome(mode);
  const ramp = errorRamp(mode);
  const bins = errorBins(max, ramp.length);
  const gap = 2;
  const items = [
    { fill: neutralFill(mode), label: '0' },
    ...bins.map((b) => ({ fill: ramp[b.step]!, label: b.lo === b.hi ? fmtInt(b.lo) : `${fmtInt(b.lo)}–${fmtInt(b.hi)}` })),
  ];
  const labelW = Math.max(...items.map((it) => textWidth(it.label, 11)));
  const step = Math.max(30, Math.ceil(labelW) + 8) + gap;
  const titleW = Math.ceil(textWidth(title, 12));
  // Title beside the swatches when it fits, else above them.
  const inline = titleW + 12 + items.length * step <= maxWidth;
  const sx = inline ? titleW + 12 : 0;
  const sy = inline ? 0 : 22;
  const width = Math.ceil(Math.max(sx + items.length * step, titleW)) + 2;
  const height = sy + 34;
  const svg = s(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, 'data-chart': '', role: 'img', 'aria-label': `Legend: ${title}` },
    s('text', { x: 0, y: 11, 'dominant-baseline': 'central', 'font-size': 12, fill: c.ink2 }, title),
  );
  items.forEach((it, i) => {
    const x = sx + i * step;
    svg.append(
      s('rect', { x, y: sy + 4, width: step - gap, height: 14, rx: 3, fill: it.fill }),
      s('text', { x: x + (step - gap) / 2, y: sy + 30, 'text-anchor': 'middle', 'font-size': 11, fill: c.ink3 }, it.label),
    );
  });
  return svg;
}

export interface LegendItem {
  label: string;
  color: string;
}

/** Wrapping series legend (dot + ink label) as an exportable SVG. */
export function seriesLegend(items: LegendItem[], mode: Mode, maxWidth: number): SVGSVGElement {
  const c = chrome(mode);
  const rowH = 20;
  const placed: { x: number; y: number; item: LegendItem; label: string }[] = [];
  let x = 0;
  let y = 0;
  let width = 0;
  for (const item of items) {
    const label = fitText(item.label, Math.max(80, maxWidth - 24));
    const w = 16 + textWidth(label, 12) + 18;
    if (x > 0 && x + w > maxWidth) {
      x = 0;
      y += rowH;
    }
    placed.push({ x, y, item, label });
    x += w;
    width = Math.max(width, x);
  }
  const height = y + rowH;
  const svg = s('svg', { width: Math.ceil(width), height, viewBox: `0 0 ${Math.ceil(width)} ${height}`, 'data-chart': '', role: 'img', 'aria-label': 'Legend' });
  for (const p of placed) {
    svg.append(
      s('circle', { cx: p.x + 6, cy: p.y + rowH / 2, r: 5, fill: p.item.color, stroke: c.surface, 'stroke-width': 2 }),
      s('text', { x: p.x + 16, y: p.y + rowH / 2, 'dominant-baseline': 'central', 'font-size': 12, fill: c.ink2 }, p.label),
    );
  }
  return svg;
}

// ------------------------------------------------------------ hit areas

/**
 * Transparent full-row hit areas (≥ 24 px tall) inserted beneath a Plot's
 * marks, so a whole label row is one target. `focusable` rows become buttons.
 */
export function addRowHits(
  svg: Element,
  opts: {
    group: string;
    count: number;
    top: number;
    rowH: number;
    x: number;
    width: number;
    offset?: number;
    focusable?: boolean;
    label?: (i: number) => string;
  },
): void {
  const g = s('g', { class: 'fx-rowhits' });
  for (let i = 0; i < opts.count; i += 1) {
    const rect = s('rect', {
      class: 'fx-rowhit',
      x: opts.x,
      y: opts.top + i * opts.rowH + 1,
      width: Math.max(0, opts.width),
      height: opts.rowH - 2,
      rx: 4,
      fill: 'transparent',
      'data-fx': `${opts.group}:${(opts.offset ?? 0) + i}`,
    });
    if (opts.focusable) {
      rect.setAttribute('tabindex', '0');
      rect.setAttribute('role', 'button');
      const label = opts.label?.(i);
      if (label) rect.setAttribute('aria-label', label);
    }
    g.append(rect);
  }
  // Beneath the marks: label text is pointer-transparent, so the row catches the pointer.
  svg.insertBefore(g, svg.firstChild);
}

/** Tag the elements a Plot mark rendered (`g.<cls> > *`) as targets of `group`, by datum index. */
export function tagMarks(svg: Element, cls: string, group: string, offset = 0): void {
  svg.querySelectorAll(`g.${cls} > *`).forEach((el, n) => {
    const datum = (el as unknown as { __data__?: unknown }).__data__;
    const i = typeof datum === 'number' ? datum : n;
    el.setAttribute('data-fx', `${group}:${offset + i}`);
  });
}

export interface TargetHandlers {
  tip?: (index: number) => Child;
  activate?: (index: number, el: Element) => void;
}

/** One delegated binding for every `[data-fx="group:index"]` target inside `root`. */
export function bindTargets(root: HTMLElement, handlers: Record<string, TargetHandlers>): void {
  const find = (e: Event) => {
    const el = (e.target as Element | null)?.closest?.('[data-fx]');
    if (!el || !root.contains(el)) return null;
    const raw = el.getAttribute('data-fx') ?? '';
    const sep = raw.lastIndexOf(':');
    const h = handlers[raw.slice(0, sep)];
    const i = Number(raw.slice(sep + 1));
    return h && Number.isInteger(i) ? { el, h, i } : null;
  };
  const show = (e: Event) => {
    const t = find(e);
    if (t?.h.tip) showTooltip(t.el, t.h.tip(t.i));
    else hideTooltip();
  };
  root.addEventListener('pointerover', show);
  root.addEventListener('pointerleave', hideTooltip);
  root.addEventListener('focusin', show);
  root.addEventListener('focusout', hideTooltip);
  root.addEventListener('click', (e) => {
    const t = find(e);
    if (!t?.h.activate) return;
    hideTooltip();
    t.h.activate(t.i, t.el);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = find(e);
    if (!t?.h.activate) return;
    e.preventDefault();
    hideTooltip();
    t.h.activate(t.i, t.el);
  });
}

/** Scroll an element into view with a short highlight (motion respects the user's setting). */
export function revealAndFlash(el: HTMLElement): void {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.classList.remove('fx-flash');
  void el.offsetWidth;
  el.classList.add('fx-flash');
  setTimeout(() => el.classList.remove('fx-flash'), 1600);
}
