/**
 * Chart cards: a titled figure that renders an Observable Plot chart at the
 * container's width, re-renders on resize and theme change, offers a table
 * view (the accessible twin of every chart) and exports a publication copy
 * (always re-rendered in light mode) as SVG or 2× PNG.
 */

import { copyText, downloadBlob, downloadText, openMenu, segmented, slug, type MenuItem } from './components';
import { h, render, type Child } from './dom';
import { icon } from './icons';
import { chrome, currentMode, type Mode } from './palette';

export interface TableView {
  el: HTMLElement;
  csv: () => string;
}

export interface ChartCardOptions {
  title: Child;
  subtitle?: Child;
  /** Extra controls shown in the card header (e.g. a metric switch). */
  controls?: Child;
  /** Build the chart for a width and color mode. */
  render: (width: number, mode: Mode) => Element;
  /** Table view of the same data. */
  table?: () => TableView;
  /** Base file name for exports. */
  exportName: string;
  footnote?: Child;
  /** Reserve this height while the first render is pending. */
  minHeight?: number;
  class?: string;
}

export interface ChartCard {
  el: HTMLElement;
  /** Re-render (call after data or theme changes). */
  redraw(): void;
  destroy(): void;
}

export const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Common Plot `style` for a mode. */
export function plotStyle(mode: Mode): Record<string, string> {
  const c = chrome(mode);
  return {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: c.ink2,
    background: 'transparent',
    overflow: 'visible',
  };
}

export function chartCard(opts: ChartCardOptions): ChartCard {
  let mode: 'chart' | 'table' = 'chart';
  let lastWidth = 0;
  const chartHost = h('div', { class: 'chart', style: opts.minHeight ? { minHeight: `${opts.minHeight}px` } : undefined });
  const tableHost = h('div', { class: 'chart-table', hidden: true });

  const toggle = opts.table
    ? segmented<'chart' | 'table'>({
        label: 'View as',
        size: 'sm',
        value: 'chart',
        options: [
          { value: 'chart', label: [icon('chart', { size: 13 }), 'Chart'], title: 'Show chart' },
          { value: 'table', label: [icon('table', { size: 13 }), 'Table'], title: 'Show the data as a table' },
        ],
        onChange: (v) => {
          mode = v;
          chartHost.hidden = v !== 'chart';
          tableHost.hidden = v !== 'table';
          if (v === 'table') drawTable();
          else draw(true);
        },
      })
    : null;

  const exportBtn = h(
    'button',
    { type: 'button', class: 'icon-btn sm', 'aria-label': 'Export', title: 'Export figure' },
    icon('download'),
  );
  exportBtn.addEventListener('click', () => {
    const items: MenuItem[] = [
      { label: 'Download SVG', icon: 'image', onSelect: () => void exportFigure('svg') },
      { label: 'Download PNG (2×)', icon: 'image', onSelect: () => void exportFigure('png') },
    ];
    if (opts.table) {
      items.push(
        { label: 'Download CSV', icon: 'table', onSelect: () => downloadText(opts.table!().csv(), `${slug(opts.exportName)}.csv`, 'text/csv') },
        { label: 'Copy CSV', icon: 'copy', onSelect: () => void copyText(opts.table!().csv()) },
      );
    }
    openMenu(exportBtn, items);
  });

  const el = h(
    'section',
    { class: ['card', opts.class] },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'card-titles' }, h('div', { class: 'card-title' }, opts.title), opts.subtitle ? h('div', { class: 'card-subtitle' }, opts.subtitle) : null),
      h('div', { class: 'card-actions' }, opts.controls ?? null, toggle?.el ?? null, exportBtn),
    ),
    h('div', { class: 'card-body' }, chartHost, tableHost),
    opts.footnote ? h('div', { class: 'card-foot' }, opts.footnote) : null,
  );

  function draw(force = false) {
    if (mode !== 'chart') return;
    const width = Math.floor(chartHost.clientWidth);
    if (!width) return;
    if (!force && Math.abs(width - lastWidth) < 4) return;
    lastWidth = width;
    try {
      render(chartHost, opts.render(width, currentMode()));
      chartHost.style.minHeight = '';
    } catch (err) {
      console.error(err);
      render(chartHost, h('div', { class: 'empty' }, 'This chart could not be drawn.'));
    }
  }

  function drawTable() {
    if (!opts.table) return;
    const t = opts.table();
    render(tableHost, t.el);
  }

  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => draw());
  });
  ro.observe(chartHost);

  async function exportFigure(kind: 'svg' | 'png') {
    const width = Math.max(560, Math.floor(chartHost.clientWidth) || 720);
    const node = opts.render(width, 'light');
    const svg = composeSvg(node, 'light');
    const name = slug(opts.exportName);
    if (kind === 'svg') {
      downloadText(svg.markup, `${name}.svg`, 'image/svg+xml');
      return;
    }
    const png = await svgToPng(svg.markup, svg.width, svg.height, 2);
    if (png) downloadBlob(png, `${name}.png`);
  }

  return {
    el,
    redraw() {
      if (mode === 'chart') draw(true);
      else drawTable();
    },
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

/**
 * Stack every Plot SVG inside `node` (legend + chart, or small multiples laid
 * out by the view) into one standalone SVG with resolved colors and fonts.
 */
export function composeSvg(node: Element, mode: Mode): { markup: string; width: number; height: number } {
  const host = h('div', { style: { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden' } });
  host.appendChild(node);
  document.body.appendChild(host);
  const ink2 = chrome(mode).ink2;
  try {
    // Plot output (class "plot-…") and SVGs a view marks with data-chart; never icons.
    const svgs = [...host.querySelectorAll<SVGSVGElement>('svg[class^="plot-"], svg[class*=" plot-"], svg[data-chart]')].filter(
      (s) => !s.parentElement?.closest('svg'),
    );
    const hostBox = host.getBoundingClientRect();
    let width = 0;
    let height = 0;
    const parts: string[] = [];
    for (const svg of svgs) {
      const box = svg.getBoundingClientRect();
      const w = Number(svg.getAttribute('width')) || box.width;
      const hgt = Number(svg.getAttribute('height')) || box.height;
      if (!w || !hgt) continue;
      const x = box.left - hostBox.left;
      const y = box.top - hostBox.top;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      for (const n of clone.querySelectorAll('[fill="currentColor"]')) n.setAttribute('fill', ink2);
      for (const n of clone.querySelectorAll('[stroke="currentColor"]')) n.setAttribute('stroke', ink2);
      clone.setAttribute('x', String(x));
      clone.setAttribute('y', String(y));
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(hgt));
      // Drop page-specific inline styles, but keep labels that overhang the plot frame:
      // a nested <svg> clips to its own viewport unless overflow is visible.
      clone.removeAttribute('style');
      clone.setAttribute('overflow', 'visible');
      parts.push(new XMLSerializer().serializeToString(clone));
      width = Math.max(width, x + w);
      height = Math.max(height, y + hgt);
    }
    // HTML text the view placed around the SVGs (titles, labels) is carried over as SVG text.
    const texts = [...host.querySelectorAll<HTMLElement>('[data-export-text]')].map((t) => {
      const b = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return `<text x="${b.left - hostBox.left}" y="${b.top - hostBox.top + b.height * 0.75}" font-size="${cs.fontSize}" font-weight="${cs.fontWeight}" fill="${chrome(mode).ink}">${escapeXml(t.textContent ?? '')}</text>`;
    });
    width = Math.ceil(width);
    height = Math.ceil(height);
    const markup =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY.replace(/"/g, "'")}" font-size="12" style="color:${ink2}">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>${parts.join('')}${texts.join('')}</svg>`;
    return { markup, width, height };
  } finally {
    host.remove();
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

async function svgToPng(markup: string, width: number, height: number, scale: number): Promise<Blob | null> {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } catch (err) {
    console.error(err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
