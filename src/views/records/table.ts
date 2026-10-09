/**
 * The variables of one record: gold vs. each shown pipeline, grouped by
 * category in schema order; plus the per-pipeline summary and schema issues.
 */

import type { Analysis } from '../../core/analysis';
import { MISSING, Outcome, cellValue, isError } from '../../core/evaluate';
import { SNIPPET_SEPARATOR, TEXT_SENTINEL } from '../../core/snippets';
import type { FieldInfo, RecordId, SchemaModel } from '../../core/types';
import type { SchemaIssue } from '../../core/validate';
import { OUTCOME_HELP, badge, callout, outcomeBadge } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { plural, truncate } from '../../ui/format';
import { icon } from '../../ui/icons';
import { countOutcomes, describeCounts, textDiffers } from './model';
import { breakable, pipeTag, swatch } from './ui';

export interface TableInput {
  analysis: Analysis;
  rid: RecordId;
  /** Shown pipelines (analysis indices), in column order. */
  shown: readonly number[];
  /** Short display name per pipeline (analysis order). */
  shortName: readonly string[];
  onToggleCategory: (key: string) => void;
}

export interface RowFilter {
  showText: boolean;
  disagreementsOnly: boolean;
  /** A variable shown whatever the filters (deep link, clicked highlight). */
  pinned: string | null;
  collapsed: ReadonlySet<string>;
}

export interface VariablesTable {
  el: HTMLTableElement;
  rows: Map<string, HTMLTableRowElement>;
  /** Show or hide rows and categories; returns the number of variables left after the filters. */
  apply(filter: RowFilter): number;
  /** Flag the free-text rows whose value is highlighted in the report. */
  setMarked(fields: ReadonlySet<string>): void;
  /** Add "more" toggles to clamped values that overflow (once attached and visible). */
  measure(): void;
  /** Tooltip content of an element carrying `data-tt`. */
  tooltip(el: HTMLElement): Child | null;
}

interface RowRef {
  tr: HTMLTableRowElement;
  field: FieldInfo;
  /** Every scored, shown pipeline matches gold (always false without a gold row). */
  agree: boolean;
}

interface GroupRef {
  key: string;
  header: HTMLTableRowElement;
  toggle: HTMLButtonElement;
  count: HTMLElement;
  rows: RowRef[];
}

const OUTCOME_TITLE: Record<number, string> = {
  [Outcome.FN]: 'Missed (FN)',
  [Outcome.FP]: 'Over-call (FP)',
  [Outcome.FPFN]: 'Wrong label (FP+FN)',
};

const domains = new WeakMap<SchemaModel, Map<string, Set<string>>>();
function domainOf(schema: SchemaModel, field: FieldInfo): Set<string> {
  let bySchema = domains.get(schema);
  if (!bySchema) domains.set(schema, (bySchema = new Map()));
  let set = bySchema.get(field.name);
  if (!set) bySchema.set(field.name, (set = new Set(field.domain)));
  return set;
}

const shown = (v: string, missing: string) => (v === MISSING ? missing : v);

function categoricalValue(v: string, field: FieldInfo, missing: string): Child {
  if (v === MISSING) return h('span', { class: 'rec-none' }, missing);
  if (v === field.defaultLabel) return h('span', { class: 'value-default' }, v);
  return h('span', { class: 'rec-val' }, v);
}

function textValue(v: string, field: FieldInfo, missing: string): Child {
  if (v === MISSING) return h('span', { class: 'rec-none' }, missing);
  if (v === field.defaultLabel || v === TEXT_SENTINEL) return h('span', { class: 'value-default' }, v);
  const body: Child[] = [];
  v.split(SNIPPET_SEPARATOR).forEach((part, i) => {
    if (i) body.push(h('span', { class: 'rec-sep' }, ' || '));
    body.push(part);
  });
  return h('div', { class: 'rec-clamp' }, body);
}

function descriptionTip(field: FieldInfo): Child {
  return h(
    'div',
    { class: 'rec-tt' },
    h('div', { class: 'tt-title' }, field.title),
    h('div', { class: 'rec-tt-name' }, field.name),
    h('div', { class: 'rec-tt-desc' }, truncate(field.description, 700)),
  );
}

export function buildVariablesTable(input: TableInput): VariablesTable {
  const { analysis, rid, shown: cols, shortName } = input;
  const { experiment } = analysis;
  const { schema } = experiment;
  const gold = experiment.gold.get(rid);
  const pas = cols.map((i) => analysis.pipelines[i]!);
  const preds = pas.map((pa) => pa.pipeline.predictions.get(rid));
  const scored = pas.map((pa) => pa.errorCount.has(rid));
  const codes = pas.map((pa, k) => (gold && scored[k] ? pa.outcomes.get(rid) : undefined));
  const catIndex = new Map(schema.categoricalFields.map((f, i) => [f, i] as const));

  const tips: (() => Child)[] = [];
  const tip = (fn: () => Child) => String(tips.push(fn) - 1);

  const thead = h(
    'thead',
    null,
    h(
      'tr',
      null,
      h('th', { scope: 'col', class: 'rec-th-var' }, 'Variable'),
      h('th', { scope: 'col', class: 'rec-th-gold', title: `Gold standard (${experiment.goldFileName})` }, 'Gold'),
      pas.map((pa, k) =>
        h(
          'th',
          { scope: 'col', class: 'rec-th-pipe', title: pa.pipeline.name },
          h('span', { class: 'pipeline-name' }, swatch(pa.pipeline), h('span', { class: 'label' }, breakable(shortName[cols[k]!]!))),
        ),
      ),
    ),
  );

  const tbody = h('tbody');
  const groups: GroupRef[] = [];
  const rowMap = new Map<string, HTMLTableRowElement>();

  for (const cat of schema.categories) {
    const fields = cat.fields
      .map((n) => schema.byName.get(n))
      .filter((f): f is FieldInfo => !!f && f.category === cat.key);
    if (!fields.length) continue;

    const catCodes = cat.categorical.map((f) => catIndex.get(f)).filter((i): i is number => i !== undefined);
    const count = h('span', { class: 'rec-cat-count' }, String(fields.length));
    const toggle = h(
      'button',
      { type: 'button', class: 'rec-cat-btn', 'aria-expanded': 'true', onclick: () => input.onToggleCategory(cat.key) },
      icon('chevronDown'),
      h('span', { class: 'rec-cat-title' }, cat.title),
      count,
    );
    const header = h(
      'tr',
      { class: 'rec-cat', dataset: { cat: cat.key } },
      h('th', { colspan: 2, scope: 'colgroup' }, toggle),
      pas.map((pa, k) => {
        const c = countOutcomes(codes[k], catCodes);
        if (!c.errors) return h('td', { class: 'rec-cat-err' });
        return h(
          'td',
          { class: 'rec-cat-err' },
          h(
            'span',
            { class: 'badge critical', dataset: { tt: tip(() => `${pa.pipeline.name}: ${describeCounts(c)} in ${cat.title}`) } },
            plural(c.errors, 'error'),
          ),
        );
      }),
    );
    tbody.appendChild(header);

    const rows: RowRef[] = [];
    for (const field of fields) {
      const isText = field.kind === 'text';
      const ci = catIndex.get(field.name);
      const g = cellValue(gold, field.name);
      let agree = !!gold;

      const cells = pas.map((pa, k) => {
        const pred = preds[k];
        if (!scored[k] && !pred) return h('td', { class: 'rec-cell' }, h('span', { class: 'rec-none' }, 'not run'));
        const v = cellValue(pred, field.name);
        if (isText) {
          const differs = !!gold && textDiffers(g, v);
          if (gold && scored[k] && (differs || (v === MISSING) !== (g === MISSING))) agree = false;
          return h(
            'td',
            { class: 'rec-cell', dataset: differs ? { tt: tip(() => differsTip(g)) } : undefined },
            textValue(v, field, 'no prediction'),
            differs ? h('span', { class: 'badge outline rec-differs' }, 'differs') : null,
          );
        }
        const code = ci === undefined ? undefined : codes[k]?.[ci];
        const err = code !== undefined && isError(code);
        if (err) agree = false;
        const invalid = v !== MISSING && field.domain.length > 0 && !domainOf(schema, field).has(v);
        return h(
          'td',
          {
            class: ['rec-cell', err && (code === Outcome.FP ? 'rec-fp' : 'rec-fn')],
            dataset: err || invalid ? { tt: tip(() => cellTip(code, g, v, invalid, pa.pipeline.name)) } : undefined,
          },
          categoricalValue(v, field, 'no prediction'),
          err ? outcomeBadge(code) : null,
          invalid ? h('span', { class: 'badge outline rec-invalid' }, 'not allowed') : null,
        );
      });

      const goldCell = gold
        ? h('td', { class: 'rec-gold' }, isText ? textValue(g, field, 'no value') : categoricalValue(g, field, 'no value'))
        : h('td', { class: 'rec-gold' }, h('span', { class: 'rec-none' }, '—'));

      // The name gets the full width; the description's info button follows the title.
      const info = field.description
        ? h('button', { type: 'button', class: 'info-tip', 'aria-label': `About ${field.title}`, dataset: { tt: tip(() => descriptionTip(field)) } }, icon('info'))
        : null;
      const titled = !!field.title && field.title !== field.name;
      // Keep the info button on the line of the title's last word.
      const cut = field.title.lastIndexOf(' ') + 1;
      const varCell = h(
        'th',
        { scope: 'row', class: 'rec-var' },
        h('div', { class: 'rec-var-name' }, h('span', null, breakable(field.name)), titled ? null : info),
        titled
          ? h(
              'div',
              { class: 'rec-var-title' },
              info ? [field.title.slice(0, cut), h('span', { class: 'rec-nowrap' }, field.title.slice(cut), ' ', info)] : field.title,
            )
          : null,
      );

      const tr = h(
        'tr',
        {
          class: ['rec-row', isText && 'rec-text'],
          dataset: { field: field.name },
          tabIndex: isText ? 0 : undefined,
        },
        varCell,
        goldCell,
        cells,
      );
      tbody.appendChild(tr);
      rows.push({ tr, field, agree });
      rowMap.set(field.name, tr);
    }
    groups.push({ key: cat.key, header, toggle, count, rows });
  }

  const emptyCell = h('td', { colspan: 2 + pas.length });
  const empty = h('tr', { class: 'rec-empty-row', hidden: true }, emptyCell);
  tbody.appendChild(empty);

  const table = h(
    'table',
    { class: 'rec-vars', style: { minWidth: `${200 + (pas.length + 1) * 104}px` } },
    h('caption', { class: 'visually-hidden' }, `Record ${rid}: gold standard and pipeline values`),
    h('colgroup', null, h('col', { class: 'rec-col-var' }), h('col'), pas.map(() => h('col'))),
    thead,
    tbody,
  );

  return {
    el: table,
    rows: rowMap,
    apply(f) {
      let visible = 0;
      for (const g of groups) {
        const collapsed = f.collapsed.has(g.key);
        let left = 0;
        for (const r of g.rows) {
          const pinned = r.field.name === f.pinned;
          const filtered = !pinned && ((!f.showText && r.field.kind === 'text') || (f.disagreementsOnly && r.agree));
          r.tr.hidden = filtered || (collapsed && !pinned);
          r.tr.classList.toggle('rec-pinned', pinned);
          if (!filtered) left += 1;
        }
        g.header.hidden = left === 0;
        g.toggle.setAttribute('aria-expanded', String(!collapsed));
        g.count.textContent = left === g.rows.length ? String(left) : `${left} of ${g.rows.length}`;
        visible += left;
      }
      empty.hidden = visible > 0;
      if (!visible) {
        emptyCell.replaceChildren(
          h(
            'div',
            { class: 'rec-empty-msg' },
            icon('checkCircle'),
            f.disagreementsOnly
              ? 'Every shown pipeline matches the gold standard on this record.'
              : 'No variables to show — turn “Free text” back on.',
          ),
        );
      }
      return visible;
    },
    setMarked(fields) {
      for (const g of groups) for (const r of g.rows) if (r.field.kind === 'text') r.tr.classList.toggle('rec-has-marks', fields.has(r.field.name));
    },
    measure() {
      const todo = [...table.querySelectorAll<HTMLElement>('.rec-clamp:not([data-measured])')].filter((c) => c.offsetParent !== null);
      const overflowing = todo.map((c) => c.scrollHeight > c.clientHeight + 2);
      todo.forEach((c, i) => {
        c.dataset.measured = '1';
        if (!overflowing[i]) return;
        const btn = h('button', { type: 'button', class: 'rec-more', 'aria-expanded': 'false' }, 'more');
        btn.addEventListener('click', () => {
          const open = c.classList.toggle('open');
          btn.textContent = open ? 'less' : 'more';
          btn.setAttribute('aria-expanded', String(open));
        });
        c.after(btn);
      });
    },
    tooltip(el) {
      const k = el.dataset.tt;
      return k === undefined ? null : (tips[Number(k)]?.() ?? null);
    },
  };
}

function cellTip(code: number | undefined, gold: string, pred: string, invalid: boolean, pipeline: string): Child {
  const err = code !== undefined && isError(code);
  return h(
    'div',
    { class: 'rec-tt' },
    h('div', { class: 'tt-title' }, err ? OUTCOME_TITLE[code] : 'Not an allowed value'),
    h('div', { class: 'tt-row' }, h('span', { class: 'k' }, 'Gold'), h('span', { class: 'v' }, shown(gold, 'no value'))),
    h('div', { class: 'tt-row' }, h('span', { class: 'k' }, truncate(pipeline, 28)), h('span', { class: 'v' }, shown(pred, 'no prediction'))),
    err ? h('div', { class: 'tt-muted rec-tt-note' }, OUTCOME_HELP[code]) : null,
    invalid ? h('div', { class: 'tt-muted rec-tt-note' }, 'The value is not in this variable’s allowed values.') : null,
  );
}

function differsTip(gold: string): Child {
  return h(
    'div',
    { class: 'rec-tt' },
    h('div', { class: 'tt-title' }, 'Differs from the gold standard'),
    h('div', { class: 'tt-muted' }, 'Gold'),
    h('div', { class: 'rec-tt-snippet' }, truncate(shown(gold, 'no value'), 260)),
    h('div', { class: 'tt-muted rec-tt-note' }, 'Compared ignoring case and whitespace. Free-text variables are diagnostics only and are not scored.'),
  );
}

// ------------------------------------------------------------------ summary

/** One line per shown pipeline: errors on this record, or why it is not scored. */
export function summaryBlock(analysis: Analysis, rid: RecordId, cols: readonly number[], shortName: readonly string[]): HTMLElement {
  const { experiment } = analysis;
  const gold = experiment.gold.get(rid);
  return h(
    'div',
    { class: 'rec-summary', 'aria-label': 'Errors on this record' },
    cols.map((i) => {
      const pa = analysis.pipelines[i]!;
      const pred = pa.pipeline.predictions.get(rid);
      const scored = pa.errorCount.has(rid);
      let status: Child;
      if (!scored && !pred) status = h('span', { class: 'rec-none' }, 'Not run on this record');
      else if (!gold) status = h('span', { class: 'muted' }, 'Not scored — no gold-standard row');
      else if (!scored) status = h('span', { class: 'muted' }, 'Not scored — outside this run’s records');
      else if (!pred) status = [badge('No prediction', 'critical'), h('span', { class: 'muted' }, 'every variable is scored as wrong')];
      else {
        const c = countOutcomes(pa.outcomes.get(rid));
        status = c.errors
          ? [
              h('strong', { class: 'rec-sum-count' }, plural(c.errors, 'error')),
              c.fn ? badge(`FN ${c.fn}`, 'critical') : null,
              c.fp ? badge(`FP ${c.fp}`, 'serious') : null,
              c.fpfn ? badge(`FP+FN ${c.fpfn}`, 'critical') : null,
            ]
          : h('span', { class: 'rec-sum-ok' }, icon('check'), 'All correct');
      }
      let differ = 0;
      if (gold && pred) for (const f of experiment.schema.textFields) if (textDiffers(cellValue(gold, f), cellValue(pred, f))) differ += 1;
      return h(
        'div',
        { class: 'rec-sum-line' },
        h('div', { class: 'rec-sum-name' }, pipeTag(pa.pipeline, shortName[i]!)),
        h(
          'div',
          { class: 'rec-sum-status' },
          status,
          differ ? h('span', { class: 'rec-sum-text' }, `· ${plural(differ, 'free-text value')} ${differ === 1 ? 'differs' : 'differ'}`) : null,
        ),
      );
    }),
  );
}

const MAX_ISSUES = 12;

/** JSON Schema problems of this record (gold and shown pipelines), or null. */
export function issuesBlock(analysis: Analysis, rid: RecordId, cols: readonly number[], shortName: readonly string[]): HTMLElement | null {
  const entries: { who: Child; issue: SchemaIssue }[] = [];
  for (const issue of analysis.goldSchemaIssues?.get(rid) ?? []) entries.push({ who: h('span', { class: 'rec-issue-who' }, 'Gold standard'), issue });
  for (const i of cols) {
    const pa = analysis.pipelines[i]!;
    for (const issue of pa.schemaIssues?.get(rid) ?? []) entries.push({ who: pipeTag(pa.pipeline, shortName[i]!), issue });
  }
  if (!entries.length) return null;
  const more = entries.length - MAX_ISSUES;
  return callout('warning', [
    h('strong', null, `${plural(entries.length, 'schema issue')} on this record`),
    h(
      'ul',
      { class: 'rec-issues' },
      entries.slice(0, MAX_ISSUES).map(({ who, issue }) =>
        h(
          'li',
          { dataset: issue.field ? { field: issue.field } : undefined, class: issue.field ? 'rec-issue-link' : undefined },
          who,
          h('span', null, issue.message),
          issue.rule ? h('span', { class: 'rec-issue-rule' }, issue.rule) : null,
        ),
      ),
      more > 0 ? h('li', { class: 'muted' }, `and ${plural(more, 'more issue')}`) : null,
    ),
  ]);
}
