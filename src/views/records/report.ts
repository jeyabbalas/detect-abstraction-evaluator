/**
 * The report text with the free-text (`*_text`) values of one source — the
 * gold standard or a pipeline — located and highlighted.
 */

import type { ReportIndex, SnippetMatch } from '../../core/snippets';
import type { AbstractionRecord, SchemaModel } from '../../core/types';
import { append, h, type Child } from '../../ui/dom';
import { truncate } from '../../ui/format';
import { buildSegments, type Segment } from './model';

export interface HighlightItem {
  field: string;
  match: SnippetMatch;
}

export interface Highlighted {
  /** The `.rec-report-text` element. */
  el: HTMLElement;
  /** Marks of each text field, in report order. */
  marksByField: Map<string, HTMLElement[]>;
  items: HighlightItem[];
  segments: Segment[];
  /** Snippets (or constructed parts) not found in the report. */
  unlocated: { field: string; snippet: string }[];
  /** Text fields with at least one non-empty snippet. */
  valued: number;
  /** Highlights located only approximately (constructed parts or ignoring case). */
  approximate: number;
}

const isExact = (m: SnippetMatch) => m.exact && !m.caseInsensitive;

export function highlightReport(index: ReportIndex, record: AbstractionRecord | undefined, fields: readonly string[]): Highlighted {
  const text = index.text;
  const items: HighlightItem[] = [];
  const unlocated: { field: string; snippet: string }[] = [];
  let valued = 0;
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value !== 'string') continue;
    const located = index.locate(value);
    if (located.snippets.length) valued += 1;
    for (const match of located.matches) if (match.end > match.start) items.push({ field, match });
    for (const snippet of located.unlocated) unlocated.push({ field, snippet });
  }

  const segments = buildSegments(items.map((it) => it.match));
  const marksByField = new Map<string, HTMLElement[]>();
  const el = h('div', { class: 'rec-report-text' });
  const parts: Child[] = [];
  let pos = 0;
  let approximate = 0;
  segments.forEach((seg, k) => {
    if (seg.start > pos) parts.push(text.slice(pos, seg.start));
    const exact = seg.items.some((i) => isExact(items[i]!.match));
    if (!exact) approximate += 1;
    const fieldsHere = [...new Set(seg.items.map((i) => items[i]!.field))];
    const mark = h(
      'mark',
      {
        class: ['rec-mark', !exact && 'inexact', fieldsHere.length > 1 && 'multi'],
        tabIndex: 0,
        dataset: { seg: k },
      },
      text.slice(seg.start, seg.end),
    );
    for (const f of fieldsHere) {
      let list = marksByField.get(f);
      if (!list) marksByField.set(f, (list = []));
      list.push(mark);
    }
    parts.push(mark);
    pos = seg.end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  append(el, parts);
  return { el, marksByField, items, segments, unlocated, valued, approximate };
}

/** Tooltip for a mark: the variable(s) it belongs to and their snippets. */
export function markTooltip(hl: Highlighted, segIndex: number, schema: SchemaModel, record: AbstractionRecord | undefined, source: Child): HTMLElement | null {
  const seg = hl.segments[segIndex];
  if (!seg) return null;
  const byField = new Map<string, SnippetMatch[]>();
  for (const i of seg.items) {
    const it = hl.items[i]!;
    let list = byField.get(it.field);
    if (!list) byField.set(it.field, (list = []));
    list.push(it.match);
  }
  return h(
    'div',
    { class: 'rec-tt' },
    h('div', { class: 'rec-tt-source' }, source),
    [...byField].map(([field, matches]) => {
      const info = schema.byName.get(field);
      const constructed = matches.every((m) => !m.exact);
      const caseOnly = !constructed && matches.every((m) => !isExact(m));
      const value = record?.[field];
      return h(
        'div',
        { class: 'rec-tt-field' },
        h('div', { class: 'tt-title' }, info?.title ?? field),
        h('div', { class: 'rec-tt-name' }, field),
        h('div', { class: 'rec-tt-snippet' }, `“${truncate(matches[0]!.text, 180)}”`),
        constructed
          ? h(
              'div',
              { class: 'tt-muted' },
              'Not verbatim: part of a constructed value',
              typeof value === 'string' ? ` (“${truncate(value, 120)}”)` : null,
              ', located piece by piece.',
            )
          : caseOnly
            ? h('div', { class: 'tt-muted' }, 'Matched only when ignoring letter case.')
            : null,
      );
    }),
    h('div', { class: 'tt-muted rec-tt-hint' }, 'Click to show the variable'),
  );
}
