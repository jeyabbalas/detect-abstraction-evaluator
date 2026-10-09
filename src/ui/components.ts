/** Shared UI components. All text is inserted as text nodes. */

import type { Pipeline } from '../core/types';
import { Outcome } from '../core/evaluate';
import { h, render, type Child } from './dom';
import { icon, type IconName } from './icons';
import { seriesColor } from './palette';

// ---------------------------------------------------------------- segmented

export interface SegmentOption<T extends string> {
  value: T;
  label: Child;
  title?: string;
  disabled?: boolean;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T): void;
}

export function segmented<T extends string>(opts: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}): Segmented<T> {
  let current = opts.value;
  const buttons = opts.options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        title: o.title,
        disabled: o.disabled,
        'aria-pressed': String(o.value === current),
        onclick: () => {
          if (o.value === current) return;
          set(o.value);
          opts.onChange(o.value);
        },
      },
      o.label,
    ),
  );
  const el = h('div', { class: ['segmented', opts.size === 'sm' && 'sm'], role: 'group', 'aria-label': opts.label }, buttons);
  function set(value: T) {
    current = value;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(opts.options[i]!.value === value)));
  }
  return { el, set };
}

// ------------------------------------------------------------------ tooltip

let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

/** Show the shared tooltip near a point (client coordinates) or an element. */
export function showTooltip(at: { x: number; y: number } | Element, content: Child): void {
  const tip = ensureTooltip();
  render(tip, content);
  tip.classList.add('visible');
  const r = at instanceof Element ? at.getBoundingClientRect() : null;
  const x = r ? r.left + r.width / 2 : (at as { x: number }).x;
  const y = r ? r.bottom : (at as { y: number }).y;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r ? x - tw / 2 : x + 14;
  let top = r ? y + 8 : y + 14;
  if (left + tw > window.innerWidth - 8) left = r ? window.innerWidth - tw - 8 : x - tw - 14;
  if (left < 8) left = 8;
  if (top + th > window.innerHeight - 8) top = r ? r.top - th - 8 : y - th - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideTooltip(): void {
  tooltipEl?.classList.remove('visible');
}

/** Attach a hover/focus tooltip to an element. */
export function withTooltip<E extends HTMLElement>(el: E, content: Child | (() => Child)): E {
  const show = () => showTooltip(el, typeof content === 'function' ? content() : content);
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('blur', hideTooltip);
  return el;
}

/** Tooltip body: optional title, then key/value rows. */
export function tooltipBody(title: Child, rows: [Child, Child][] = [], note?: Child): HTMLElement {
  return h(
    'div',
    null,
    title ? h('div', { class: 'tt-title' }, title) : null,
    rows.map(([k, v]) => h('div', { class: 'tt-row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v))),
    note ? h('div', { class: 'tt-muted', style: { marginTop: '4px' } }, note) : null,
  );
}

export function infoTip(content: Child, label = 'More information'): HTMLButtonElement {
  return withTooltip(h('button', { type: 'button', class: 'info-tip', 'aria-label': label }, icon('info')), () =>
    h('div', { style: { maxWidth: '320px' } }, content),
  );
}

// -------------------------------------------------------------------- menu

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
}

export function openMenu(anchor: Element, items: MenuItem[]): void {
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((it) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            close();
            it.onSelect();
          },
        },
        it.icon ? icon(it.icon) : null,
        it.label,
      ),
    ),
  );
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  const onDown = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
}

// ------------------------------------------------------------------- drawer

export interface Drawer {
  close(): void;
  body: HTMLElement;
}

export function openDrawer(opts: { title: Child; subtitle?: Child; body: Child; onClose?: () => void }): Drawer {
  const backdrop = h('div', { class: 'drawer-backdrop' });
  const body = h('div', { class: 'drawer-body' }, opts.body);
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
  const panel = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'drawer-head' },
      h('div', { style: { flex: '1', minWidth: '0' } }, h('h2', null, opts.title), opts.subtitle ? h('p', null, opts.subtitle) : null),
      closeBtn,
    ),
    body,
  );
  document.body.append(backdrop, panel);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    panel.classList.add('open');
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', () => close());
  closeBtn.addEventListener('click', () => close());
  closeBtn.focus();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.remove('open');
    panel.classList.remove('open');
    setTimeout(() => {
      backdrop.remove();
      panel.remove();
    }, 180);
    opts.onClose?.();
  }
  return { close, body };
}

// ----------------------------------------------------------- badges, labels

export type Tone = 'critical' | 'serious' | 'warning' | 'good' | 'neutral' | 'outline';

export function badge(text: Child, tone: Tone = 'neutral', iconName?: IconName): HTMLSpanElement {
  return h('span', { class: ['badge', tone !== 'neutral' && tone] }, iconName ? icon(iconName) : null, text);
}

export const OUTCOME_LABEL: Record<number, string> = {
  [Outcome.TN]: 'Correct',
  [Outcome.TP]: 'Correct',
  [Outcome.FP]: 'FP',
  [Outcome.FN]: 'FN',
  [Outcome.FPFN]: 'FP+FN',
};

export const OUTCOME_HELP: Record<number, string> = {
  [Outcome.TN]: 'Correct — both are the default (uninformative) label.',
  [Outcome.TP]: 'Correct and informative (true positive).',
  [Outcome.FP]: 'False positive — an informative label where the gold standard has the default label (over-call).',
  [Outcome.FN]: 'False negative — the default label where the gold standard is informative (miss).',
  [Outcome.FPFN]: 'Wrong informative label — counts as one false positive and one false negative.',
};

/** Error badge for a cell outcome; null for correct cells. */
export function outcomeBadge(code: number): HTMLSpanElement | null {
  if (code === Outcome.FN) return badge('FN', 'critical');
  if (code === Outcome.FP) return badge('FP', 'serious');
  if (code === Outcome.FPFN) return badge('FP+FN', 'critical');
  return null;
}

/** Colored identity mark + pipeline name (text stays in ink). */
export function pipelineLabel(p: Pipeline, opts: { short?: boolean; title?: string } = {}): HTMLSpanElement {
  return h(
    'span',
    { class: 'pipeline-name', title: opts.title ?? p.name },
    h('span', { class: 'swatch', style: { color: seriesColor(p.index) }, dataset: { series: p.index } }),
    h('span', { class: 'label' }, p.name),
  );
}

export function emptyState(opts: { icon?: IconName; title: Child; body?: Child; action?: Child }): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    opts.icon ? icon(opts.icon) : null,
    h('strong', null, opts.title),
    opts.body ? h('div', null, opts.body) : null,
    opts.action ?? null,
  );
}

export function callout(tone: 'warning' | 'critical' | 'good' | 'info', content: Child): HTMLElement {
  const iconName: IconName = tone === 'good' ? 'checkCircle' : tone === 'info' ? 'info' : 'alert';
  return h('div', { class: ['callout', tone !== 'info' && tone], role: tone === 'critical' ? 'alert' : undefined }, icon(iconName), h('div', null, content));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2400);
}

// ------------------------------------------------------------------- tables

export interface Column<R> {
  key: string;
  label: Child;
  /** Plain value for sorting and CSV export. */
  value: (row: R) => string | number | null | undefined;
  /** Cell content (defaults to the formatted value). */
  cell?: (row: R) => Child;
  numeric?: boolean;
  title?: string;
  className?: (row: R) => string | undefined;
}

/** A sortable table. Returns the table and a CSV serializer of its rows. */
export function dataTable<R>(columns: Column<R>[], rows: R[], opts: { sortable?: boolean; caption?: string } = {}) {
  let sortKey: string | null = null;
  let dir: 1 | -1 = 1;
  const tbody = h('tbody');
  const heads = columns.map((c) =>
    h(
      'th',
      {
        class: c.numeric ? 'num' : undefined,
        title: c.title,
        scope: 'col',
        dataset: opts.sortable !== false ? { sort: c.key } : undefined,
        onclick:
          opts.sortable !== false
            ? () => {
                if (sortKey === c.key) dir = dir === 1 ? -1 : 1;
                else {
                  sortKey = c.key;
                  dir = c.numeric ? -1 : 1;
                }
                draw();
              }
            : undefined,
      },
      c.label,
    ),
  );
  const table = h(
    'table',
    { class: 'tbl' },
    opts.caption ? h('caption', { class: 'visually-hidden' }, opts.caption) : null,
    h('thead', null, h('tr', null, heads)),
    tbody,
  );
  function sorted(): R[] {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey)!;
    return [...rows].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (va < vb ? -1 : 1) * dir;
    });
  }
  function draw() {
    heads.forEach((th, i) => {
      const key = columns[i]!.key;
      if (key === sortKey) th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
    render(
      tbody,
      sorted().map((r) =>
        h(
          'tr',
          null,
          columns.map((c) =>
            h('td', { class: [c.numeric && 'num', c.className?.(r)] }, c.cell ? c.cell(r) : String(c.value(r) ?? '—')),
          ),
        ),
      ),
    );
  }
  draw();
  const toCsv = () => {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.map((c) => esc(typeof c.label === 'string' ? c.label : c.key)).join(',');
    return [header, ...sorted().map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\n');
  };
  return { table, toCsv, wrap: h('div', { class: 'table-wrap' }, table) };
}

// ---------------------------------------------------------------- downloads

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, type = 'text/plain'): void {
  downloadBlob(new Blob([text], { type }), filename);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — your browser blocked clipboard access');
  }
}

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'figure';
