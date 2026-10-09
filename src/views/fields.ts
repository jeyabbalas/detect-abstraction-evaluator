/**
 * Fields view — where the errors are: informative errors per category and per
 * variable for every pipeline, a drawer with each variable's confusions and
 * the records behind them, free-text diagnostics, run-to-run consistency and
 * validity.
 */

import type { RecordId } from '../core/types';
import type { State } from '../state';
import { chartCard } from '../ui/chart';
import { infoTip, openDrawer, segmented, type Drawer } from '../ui/components';
import { h, render } from '../ui/dom';
import { plural } from '../ui/format';
import { fieldDrawerContent, type DrawerDeps } from './fields/drawer';
import { revealAndFlash } from './fields/kit';
import { categoryTable, panelId, renderCategoryMatrix, renderVariableMatrix, variableTable, type CategoryMetric } from './fields/matrix';
import { buildModel, type FieldsModel } from './fields/model';
import { consistencyCard, validityCard } from './fields/quality';
import { renderTextDiagnostics, textTable } from './fields/text';
import { METRIC_META, scopeBar } from './shared';
import type { ViewFactory } from './types';

const METRIC_OPTIONS: { value: CategoryMetric; label: string; title: string }[] = [
  { value: 'f1', label: 'Informative F1', title: METRIC_META.informative_f1.help },
  { value: 'macro', label: 'Macro-F1', title: METRIC_META.mean_field_macro_f1.help },
  { value: 'accuracy', label: 'Accuracy', title: METRIC_META.cell_accuracy.help },
  { value: 'errors', label: 'Errors', title: 'Informative errors: false positives plus false negatives.' },
];

const ERRORS_HELP =
  'Informative errors are false positives plus false negatives: an FP is an informative label where the gold standard has the default label, an FN is the default label where the gold standard is informative, and a wrong informative label counts as both. Agreement on default labels is not rewarded.';

const createFieldsView: ViewFactory = (ctx) => {
  const { analysis, store } = ctx;
  const { schema } = analysis.experiment;
  const initial = store.get();
  let model: FieldsModel = buildModel(analysis, initial.population, initial.source);
  let metric: CategoryMetric = 'f1';
  let onlyErrors = model.fieldMax > 0;

  // ------------------------------------------------------------ drawer
  let drawer: { name: string; d: Drawer } | null = null;
  let silent = false;

  const deps = (): DrawerDeps => ({
    analysis,
    model,
    onRecord: (rid: RecordId, field: string) => {
      closeDrawer();
      ctx.navigate('records', [rid], { field });
    },
  });

  function closeDrawer() {
    if (!drawer) return;
    silent = true;
    try {
      drawer.d.close();
    } finally {
      silent = false;
      drawer = null;
    }
  }

  function scrollToPipeline(pipe: number) {
    requestAnimationFrame(() => {
      const body = drawer?.d.body;
      const target = body?.querySelector<HTMLElement>(`[data-pipe="${pipe}"]`);
      if (!body || !target) return;
      body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
      target.classList.add('fx-flash');
      setTimeout(() => target.classList.remove('fx-flash'), 1600);
    });
  }

  function showDrawer(name: string, pipe?: number) {
    const field = schema.byName.get(name);
    if (!field || field.kind === 'id') return;
    if (drawer?.name === name) {
      if (pipe !== undefined) scrollToPipeline(pipe);
      return;
    }
    closeDrawer();
    const opener = document.activeElement;
    const category = schema.categoryByKey.get(field.category)?.title;
    const d = openDrawer({
      title: field.title,
      subtitle: [h('code', null, field.name), category ? ` · ${category}` : null],
      body: fieldDrawerContent(deps(), field),
      onClose: () => {
        if (drawer?.d !== d) return;
        drawer = null;
        if (silent) return;
        if (opener instanceof HTMLElement || opener instanceof SVGElement) {
          if (opener.isConnected) opener.focus({ preventScroll: true });
        }
        const route = store.get().route;
        if (route.view === 'fields' && route.query.get('field') === name) ctx.navigate('fields', [], {});
      },
    });
    drawer = { name, d };
    if (pipe !== undefined) scrollToPipeline(pipe);
  }

  /** Open a variable and record it in the URL (#/fields?field=…). */
  function openField(name: string, pipe?: number) {
    showDrawer(name, pipe);
    const route = store.get().route;
    if (route.view !== 'fields' || route.query.get('field') !== name) ctx.navigate('fields', [], { field: name });
  }

  function refreshDrawer() {
    if (!drawer) return;
    const field = schema.byName.get(drawer.name);
    if (field) render(drawer.d.body, fieldDrawerContent(deps(), field));
  }

  function syncRoute(state: State) {
    const name = state.route.view === 'fields' ? state.route.query.get('field') : null;
    if (name && schema.byName.has(name)) showDrawer(name);
    else closeDrawer();
  }

  // The view stays mounted while hidden; close the drawer when the user leaves it.
  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('route') && state.route.view !== 'fields') closeDrawer();
  });

  // ------------------------------------------------------------- layout
  const head = h('div', { class: 'page-head' });
  const scope = scopeBar(ctx);

  function revealCategory(key: string) {
    const panel = varCard.el.querySelector<HTMLElement>(`#${panelId(key)}`);
    revealAndFlash(panel && panel.offsetParent !== null ? panel : varCard.el);
  }

  const metricSwitch = segmented<CategoryMetric>({
    label: 'Cell label',
    size: 'sm',
    value: metric,
    options: METRIC_OPTIONS,
    onChange: (value) => {
      metric = value;
      catCard.redraw();
    },
  });

  const catCard = chartCard({
    title: ['Errors by category', infoTip(ERRORS_HELP)],
    subtitle: 'Shade = informative errors (FP + FN); label = the selected metric. Gold = informative values in the gold standard. Click a row to see its variables.',
    controls: h('div', { class: 'fx-controls' }, h('span', { class: 'fx-control-label' }, 'Label'), metricSwitch.el),
    render: (width, mode) => renderCategoryMatrix({ width, mode, analysis, model, metric, onCategory: revealCategory }),
    table: () => categoryTable(analysis, model),
    exportName: 'errors-by-category',
    minHeight: 280,
    class: 'fx-card',
  });

  const onlyBox = h('input', {
    type: 'checkbox',
    checked: onlyErrors,
    onchange: () => {
      onlyErrors = onlyBox.checked;
      varCard.redraw();
    },
  });
  const varCard = chartCard({
    title: ['Errors by variable', infoTip(ERRORS_HELP)],
    subtitle:
      'Each cell counts a pipeline’s informative errors (FP + FN) on a variable; Gold is the number of informative gold values, for scale. Click a variable or a cell for its confusions and records.',
    controls: h('label', { class: 'checkbox fx-controls' }, onlyBox, 'Only variables with errors'),
    render: (width, mode) => renderVariableMatrix({ width, mode, analysis, model, onlyErrors, onField: openField }),
    table: () => variableTable(analysis, model, onlyErrors, (name) => openField(name)),
    exportName: 'errors-by-variable',
    minHeight: 480,
    class: 'fx-card',
  });

  const textCard = schema.textFields.length
    ? chartCard({
        title: 'Free-text variables',
        subtitle:
          'Not part of the headline metrics. Exact match compares whitespace-collapsed, case-insensitive text; presence agreement checks whether both say “Not identified”.',
        render: (width, mode) => renderTextDiagnostics({ width, mode, analysis, model, onField: (name) => openField(name) }),
        table: () => textTable(analysis, model, (name) => openField(name)),
        exportName: 'free-text-diagnostics',
        minHeight: 320,
        class: 'fx-card',
      })
    : null;

  const quality = h('div', { class: 'grid-2 fx-quality' });

  const el = h('div', { class: 'page fields-page' }, head, scope.el, catCard.el, varCard.el, textCard?.el ?? null, quality);

  function paintHead() {
    const n = model.ids.length;
    const scopeText = model.population === 'unique' ? `the ${plural(n, 'unique report')}` : `all ${plural(n, 'record')}`;
    render(
      head,
      h(
        'div',
        null,
        h('h1', null, 'Categories and variables'),
        h('p', null, `Informative errors by category and variable, on ${scopeText}. Click a variable for its confusions and the records involved.`),
      ),
    );
  }

  function paintQuality(state: State) {
    render(quality, consistencyCard(analysis, state.source, (name) => openField(name)), validityCard(analysis, (rid, field) => ctx.navigate('records', [rid], field ? { field } : {})));
  }

  return {
    el,
    update(state, changed) {
      scope.update(state, changed);
      const data = changed.has('population') || changed.has('source');
      if (data) {
        if (state.population !== model.population || state.source !== model.source) {
          model = buildModel(analysis, state.population, state.source);
        }
        paintHead();
        paintQuality(state);
        refreshDrawer();
      }
      // Charts carry hex colors for the mode; HTML swatches follow the theme through CSS variables.
      if (data || changed.has('mode')) {
        catCard.redraw();
        varCard.redraw();
        textCard?.redraw();
      }
      if (changed.has('route')) syncRoute(state);
    },
    destroy() {
      unsubscribe();
      closeDrawer();
      catCard.destroy();
      varCard.destroy();
      textCard?.destroy();
    },
  };
};

export default createFieldsView;
