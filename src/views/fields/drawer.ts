/**
 * Variable drawer: the variable's values and rules, then per pipeline its
 * scores, its confusions (gold → predicted) with the records behind each, and
 * a per-label F1 table across pipelines. Free-text variables get their
 * agreement rates and the records whose text differs.
 */

import type { Analysis } from '../../core/analysis';
import { MISSING, outcomeOf } from '../../core/evaluate';
import type { FieldInfo, FieldScore, RecordId } from '../../core/types';
import { badge, dataTable, outcomeBadge, OUTCOME_HELP, pipelineLabel, type Column } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtInt, fmtMetric, plural } from '../../ui/format';
import { icon } from '../../ui/icons';
import { confusionGroups, fieldErrorRecords, goldInformative, textMismatches, type FieldsModel } from './model';

export interface DrawerDeps {
  analysis: Analysis;
  model: FieldsModel;
  /** Open a record (the drawer closes first). */
  onRecord: (rid: RecordId, field: string) => void;
}

const RECORD_CAP = 60;

function valueText(v: string, defaultLabel: string | null): HTMLElement {
  if (v === MISSING) return h('em', { class: 'value-default' }, 'missing');
  return h('span', { class: v === defaultLabel ? 'value-default' : undefined }, v);
}

function recordChips(rids: readonly RecordId[], field: string, deps: DrawerDeps, label: string): HTMLElement {
  const shown = rids.slice(0, RECORD_CAP);
  return h(
    'div',
    { class: 'fx-chips', role: 'group', 'aria-label': label },
    shown.map((rid) =>
      h(
        'button',
        { type: 'button', class: 'chip fx-rec', title: `Open record ${rid}`, onclick: () => deps.onRecord(rid, field) },
        `#${rid}`,
      ),
    ),
    rids.length > shown.length ? h('span', { class: 'fx-more' }, `+ ${fmtInt(rids.length - shown.length)} more`) : null,
  );
}

function stat(label: string, value: string, strong = false): HTMLElement {
  return h('div', { class: 'fx-stat' }, h('span', { class: 'k' }, label), h('span', { class: ['v', strong && 'strong'] }, value));
}

function section(title: Child, ...children: Child[]): HTMLElement {
  return h('section', { class: 'fx-d-section' }, h('h3', { class: 'fx-d-h' }, title), children);
}

function describe(field: FieldInfo): HTMLElement | null {
  if (!field.description.trim()) return null;
  return h(
    'details',
    { class: 'disclosure fx-d-desc' },
    h('summary', null, icon('chevronRight'), 'Definition and assignment rules'),
    h('div', { class: 'fx-d-desc-body' }, field.description),
  );
}

function pipeHead(deps: DrawerDeps, pipe: number, extra: Child): HTMLElement {
  return h('div', { class: 'fx-d-pipe-head' }, pipelineLabel(deps.analysis.pipelines[pipe]!.pipeline), h('span', { class: 'fx-d-badges' }, extra));
}

export function fieldDrawerContent(deps: DrawerDeps, field: FieldInfo): HTMLElement {
  return field.kind === 'categorical' ? categoricalContent(deps, field) : textContent(deps, field);
}

// ------------------------------------------------------------- categorical

function categoricalContent(deps: DrawerDeps, field: FieldInfo): HTMLElement {
  const row = deps.model.fieldByName.get(field.name);
  const first = row?.cells.find((c) => c.score)?.score ?? null;

  const values = section(
    'Values',
    h(
      'div',
      { class: 'fx-chips' },
      field.domain.map((v) =>
        h('span', { class: ['chip', 'fx-value', v === field.defaultLabel && 'is-default'] }, v, v === field.defaultLabel ? h('span', { class: 'fx-default-tag' }, 'default') : null),
      ),
    ),
    h(
      'p',
      { class: 'fx-d-note' },
      first
        ? `${plural(goldInformative(first), 'informative gold value')} among ${plural(first.n, 'record')}. The default label means nothing to report and is not counted as informative.`
        : 'No scores for this population.',
    ),
    describe(field),
  );

  const pipes = (row?.cells ?? []).map((cell) => pipelineSection(deps, field, cell.pipe, cell.score));
  return h('div', { class: 'fx-drawer' }, values, pipes);
}

function pipelineSection(deps: DrawerDeps, field: FieldInfo, pipe: number, fs: FieldScore | null): HTMLElement {
  if (!fs) {
    return h('section', { class: 'fx-d-pipe', dataset: { pipe } }, pipeHead(deps, pipe, badge('No scores', 'outline')), h('p', { class: 'fx-d-note' }, 'No scores for this population.'));
  }
  const errors = fs.fp + fs.fn;
  const badges = errors
    ? [fs.fp ? badge(`FP ${fmtInt(fs.fp)}`, 'serious') : null, fs.fn ? badge(`FN ${fmtInt(fs.fn)}`, 'critical') : null]
    : badge('No errors', 'good', 'check');
  const stats = h(
    'div',
    { class: 'fx-stats' },
    stat('F1', fmtMetric(fs.f1), true),
    stat('Precision', fmtMetric(fs.precision)),
    stat('Recall', fmtMetric(fs.recall)),
    stat('Macro-F1', fmtMetric(fs.macro_f1)),
    stat('Accuracy', fmtMetric(fs.accuracy)),
    stat('TP', fmtInt(fs.tp)),
    stat('FP', fmtInt(fs.fp)),
    stat('FN', fmtInt(fs.fn)),
  );
  const records = fieldErrorRecords(deps.analysis, pipe, field.name, deps.model.ids);
  const groups = confusionGroups(fs.confusion, field.domain, records);
  const confusions = groups.length
    ? h(
        'div',
        { class: 'fx-confusions' },
        h('div', { class: 'fx-d-sub' }, 'Confusions', h('span', { class: 'muted' }, ' — gold → predicted, with the records involved')),
        groups.map((g) => {
          const code = outcomeOf(g.gold, g.pred, field.defaultLabel);
          const tag = outcomeBadge(code);
          if (tag) tag.title = OUTCOME_HELP[code] ?? '';
          return h(
            'div',
            { class: 'fx-conf' },
            h(
              'div',
              { class: 'fx-conf-head' },
              h('span', { class: 'fx-conf-pair' }, valueText(g.gold, field.defaultLabel), h('span', { class: 'fx-arrow', 'aria-label': 'predicted as' }, '→'), valueText(g.pred, field.defaultLabel)),
              h('span', { class: 'fx-conf-n' }, `× ${fmtInt(g.count)}`),
              tag,
            ),
            g.records.length ? recordChips(g.records, field.name, deps, `Records where ${g.gold} was predicted as ${g.pred}`) : null,
          );
        }),
      )
    : h('p', { class: 'fx-d-note' }, icon('checkCircle', { size: 14 }), ' Agrees with the gold standard on every record.');
  return h('section', { class: 'fx-d-pipe', dataset: { pipe } }, pipeHead(deps, pipe, badges), stats, confusions, labelTable(field, fs));
}

interface LabelRow {
  label: string;
  support: number;
  f1: number;
}

/** Per-label support and F1 of one pipeline, labels in schema order. */
function labelTable(field: FieldInfo, fs: FieldScore): HTMLElement | null {
  const order = (l: string) => {
    const i = field.domain.indexOf(l);
    return i < 0 ? field.domain.length : i;
  };
  const rows: LabelRow[] = Object.entries(fs.per_label ?? {})
    .map(([label, s]) => ({ label, support: s.support, f1: s.f1 }))
    .sort((a, b) => order(a.label) - order(b.label) || (a.label < b.label ? -1 : 1));
  if (!rows.length) return null;
  const columns: Column<LabelRow>[] = [
    { key: 'label', label: 'Label', value: (r) => r.label, cell: (r) => valueText(r.label, field.defaultLabel) },
    { key: 'support', label: 'Gold', title: 'Records whose gold value is this label', numeric: true, value: (r) => r.support, cell: (r) => fmtInt(r.support) },
    { key: 'f1', label: 'F1', title: 'F1 of this label (one-vs-rest)', numeric: true, value: (r) => r.f1, cell: (r) => fmtMetric(r.f1) },
  ];
  const t = dataTable(columns, rows, { sortable: false, caption: `Per-label F1 for ${field.name}` });
  t.table.classList.add('fx-label-table');
  return h('div', { class: 'fx-labels-block' }, h('div', { class: 'fx-d-sub' }, 'Per label', h('span', { class: 'muted' }, ' — labels in the gold standard or the predictions')), t.wrap);
}

// --------------------------------------------------------------- free text

function textContent(deps: DrawerDeps, field: FieldInfo): HTMLElement {
  const { analysis, model } = deps;
  const values = section(
    'Values',
    h('p', { class: 'fx-d-note' }, 'Free text, or “Not identified” when the report has nothing to extract. Not part of the headline metrics.'),
    describe(field),
  );
  const pipes = analysis.pipelines.map((_, pipe) => {
    const score = model.scores[pipe]?.text?.[field.name] ?? null;
    if (!score) {
      return h('section', { class: 'fx-d-pipe', dataset: { pipe } }, pipeHead(deps, pipe, badge('No scores', 'outline')));
    }
    const diff = textMismatches(analysis, pipe, field.name, model.ids);
    return h(
      'section',
      { class: 'fx-d-pipe', dataset: { pipe } },
      pipeHead(deps, pipe, diff.text.length ? badge(`${fmtInt(diff.text.length)} differ`, 'outline') : badge('All match', 'good', 'check')),
      h('div', { class: 'fx-stats wide' }, stat('Exact match', fmtMetric(score.exact_match), true), stat('Presence agreement', fmtMetric(score.presence_agreement))),
      diff.presence.length
        ? h('div', { class: 'fx-confusions' }, h('div', { class: 'fx-d-sub' }, 'Presence disagrees', h('span', { class: 'muted' }, ' — one side says “Not identified”')), recordChips(diff.presence, field.name, deps, 'Records where presence disagrees'))
        : null,
      diff.text.length
        ? h('div', { class: 'fx-confusions' }, h('div', { class: 'fx-d-sub' }, 'Text differs', h('span', { class: 'muted' }, ' — after collapsing whitespace and case')), recordChips(diff.text, field.name, deps, 'Records where the text differs'))
        : null,
    );
  });
  return h('div', { class: 'fx-drawer' }, values, pipes);
}
