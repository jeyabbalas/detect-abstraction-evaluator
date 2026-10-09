/** Small DOM helpers shared by the records view modules. */

import type { Pipeline } from '../../core/types';
import { hideTooltip, showTooltip } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { seriesVar } from '../../ui/palette';

/** Pipeline identity swatch (theme-aware CSS color; the text next to it stays in ink). */
export function swatch(p: Pipeline): HTMLSpanElement {
  return h('span', { class: 'swatch', style: { color: seriesVar(p.index) }, dataset: { series: p.index }, 'aria-hidden': 'true' });
}

/** A variable name with line-break opportunities after its underscores. */
export function breakable(name: string): Child[] {
  const parts = name.split('_');
  return parts.flatMap((p, i) => (i < parts.length - 1 ? [`${p}_`, h('wbr')] : [p]));
}

/** Swatch + (short) pipeline name — the markup of `pipelineLabel`, with a chosen label. */
export function pipeTag(p: Pipeline, label: string, title: string = p.name): HTMLSpanElement {
  return h('span', { class: 'pipeline-name', title }, swatch(p), h('span', { class: 'label' }, label));
}

/**
 * Delegated hover/focus tooltips for every element matching `selector` inside
 * `root` — one set of listeners instead of one per element. `content` returns
 * null for elements without a tooltip.
 */
export function delegateTooltips(
  root: HTMLElement,
  selector: string,
  content: (el: HTMLElement) => Child | null,
  opts: { atPointer?: boolean } = {},
): void {
  let current: HTMLElement | null = null;
  const show = (el: HTMLElement, at?: { x: number; y: number }) => {
    const body = content(el);
    if (body === null || body === undefined) hideTooltip();
    else showTooltip(at ?? el, body);
  };
  root.addEventListener('mouseover', (e) => {
    const hit = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
    const el = hit && root.contains(hit) ? hit : null;
    if (el === current) return;
    current = el;
    if (el) show(el, opts.atPointer ? { x: e.clientX, y: e.clientY } : undefined);
    else hideTooltip();
  });
  root.addEventListener('mouseleave', () => {
    if (!current) return;
    current = null;
    hideTooltip();
  });
  root.addEventListener('focusin', (e) => {
    const hit = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
    if (!hit || !root.contains(hit)) return;
    current = hit;
    show(hit);
  });
  root.addEventListener('focusout', () => {
    current = null;
    hideTooltip();
  });
}

export function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Scroll `container` so that `el` is visible (or centered). `topInset` is the
 * height of sticky content at the top of the container (a table header).
 * Falls back to `scrollIntoView` when the container does not scroll itself.
 */
export function revealIn(
  container: HTMLElement,
  el: Element,
  opts: { center?: boolean; smooth?: boolean; topInset?: number } = {},
): void {
  const behavior: ScrollBehavior = opts.smooth && !reducedMotion() ? 'smooth' : 'auto';
  if (container.scrollHeight <= container.clientHeight + 1) {
    const r = el.getBoundingClientRect();
    if (opts.center || r.top < 60 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', behavior });
    return;
  }
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = c.top + (opts.topInset ?? 0);
  const margin = 12;
  const visible = r.top >= top + margin && r.bottom <= c.bottom - margin;
  if (visible && !opts.center) return;
  const room = c.bottom - top;
  const offset = opts.center ? Math.max(margin, (room - r.height) / 2) : Math.min(room / 3, 80);
  container.scrollTo({ top: Math.max(0, container.scrollTop + (r.top - top) - offset), behavior });
}

/** Restart a one-shot highlight animation on an element. */
export function flash(el: HTMLElement, className = 'rec-flash', ms = 1500): void {
  el.classList.remove(className);
  void el.offsetWidth; // restart the CSS animation
  el.classList.add(className);
  window.setTimeout(() => el.classList.remove(className), ms);
}

/** Read and write per-viewer conveniences; storage may be unavailable. */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`abstraction-evaluator:records:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`abstraction-evaluator:records:${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
};
