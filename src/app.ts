/** App shell: header, navigation, view lifecycle and the upload screen. */

import type { Analysis } from './core/analysis';
import { applyTheme, buildHash, parseHash, type State, type StateKey, type Store, type ThemePref, type ViewName } from './state';
import { h, render } from './ui/dom';
import { icon, type IconName } from './ui/icons';
import { hideTooltip, withTooltip } from './ui/components';
import { fmtInt } from './ui/format';
import { currentMode } from './ui/palette';
import { mountLanding } from './views/landing';
import type { ViewFactory, ViewInstance } from './views/types';

const NAV: { view: ViewName; label: string; icon: IconName; hint: string }[] = [
  { view: 'overview', label: 'Overview', icon: 'overview', hint: 'Compare pipelines on the headline metrics' },
  { view: 'fields', label: 'Fields', icon: 'fields', hint: 'Where the errors are: categories and variables' },
  { view: 'records', label: 'Records', icon: 'records', hint: 'One report at a time, gold vs. pipelines' },
  { view: 'data', label: 'Data', icon: 'data', hint: 'Explore the gold standard and predictions as tables' },
  { view: 'dictionary', label: 'Dictionary', icon: 'dictionary', hint: 'The data dictionary (JSON Schema)' },
];

const LOADERS: Record<ViewName, () => Promise<{ default: ViewFactory }>> = {
  overview: () => import('./views/overview'),
  fields: () => import('./views/fields'),
  records: () => import('./views/records'),
  data: () => import('./views/data'),
  dictionary: () => import('./views/dictionary'),
};

const THEME_NEXT: Record<ThemePref, ThemePref> = { auto: 'light', light: 'dark', dark: 'auto' };
const THEME_ICON: Record<ThemePref, IconName> = { auto: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL: Record<ThemePref, string> = { auto: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

export function mountApp(root: HTMLElement, store: Store): void {
  const header = h('header', { class: 'app-header' });
  const main = h('main', { class: 'app-main', id: 'main' });
  render(root, header, main);

  const instances = new Map<ViewName, { view: ViewInstance; wrap: HTMLElement; pending: Set<StateKey> }>();
  const loading = new Map<ViewName, Promise<void>>();
  let landing: { destroy(): void } | null = null;
  let currentAnalysis: Analysis | null = null;

  const navigate = (view: ViewName, path: (string | number)[] = [], query: Record<string, string | undefined> = {}) => {
    const hash = buildHash(view, path, query);
    if (location.hash !== hash) location.hash = hash;
  };

  // ------------------------------------------------------------- header
  const themeBtn = h('button', { type: 'button', class: 'icon-btn' });
  const paintTheme = (pref: ThemePref) => {
    render(themeBtn, icon(THEME_ICON[pref]));
    themeBtn.setAttribute('aria-label', `${THEME_LABEL[pref]} (click to change)`);
    themeBtn.title = `${THEME_LABEL[pref]} — click to change`;
  };
  themeBtn.addEventListener('click', () => {
    const next = THEME_NEXT[store.get().theme];
    store.set({ theme: next, mode: applyTheme(next) });
  });
  paintTheme(store.get().theme);

  const openBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Open another experiment folder' },
    icon('folderOpen'),
    'Open…',
  );
  openBtn.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname + location.search);
    store.set({ analysis: null, route: parseHash('') });
  });

  function paintHeader(state: State) {
    const a = state.analysis;
    const brand = h(
      'div',
      { class: 'brand' },
      icon('logo', { class: 'brand-mark' }),
      h('span', { class: 'brand-name' }, 'Abstraction Evaluator'),
    );
    if (!a) {
      render(header, brand, h('div', { class: 'header-actions' }, themeBtn));
      return;
    }
    const exp = a.experiment;
    brand.append(
      h('span', { class: 'brand-sep' }),
      h(
        'div',
        { class: 'brand-experiment', title: exp.schema.title },
        h('strong', null, exp.name),
        h('span', null, `${fmtInt(exp.goldIds.length)} records · ${exp.pipelines.length} pipeline${exp.pipelines.length === 1 ? '' : 's'}`),
      ),
    );
    const nav = h(
      'nav',
      { class: 'app-nav', 'aria-label': 'Views' },
      NAV.map((n) =>
        withTooltip(
          h(
            'a',
            { href: buildHash(n.view), 'aria-current': state.route.view === n.view ? 'page' : undefined, dataset: { view: n.view } },
            icon(n.icon),
            h('span', null, n.label),
          ),
          n.hint,
        ),
      ),
    );
    render(header, brand, nav, h('div', { class: 'header-actions' }, openBtn, themeBtn));
  }

  function paintNav(view: ViewName) {
    for (const a of header.querySelectorAll<HTMLAnchorElement>('.app-nav a')) {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // -------------------------------------------------------------- views
  function destroyViews() {
    for (const { view } of instances.values()) view.destroy?.();
    instances.clear();
    loading.clear();
    render(main);
  }

  async function ensureView(name: ViewName, analysis: Analysis): Promise<void> {
    if (instances.has(name)) return;
    if (!loading.has(name)) {
      loading.set(
        name,
        (async () => {
          const wrap = h('div', { class: 'view', dataset: { view: name } }, h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
          main.appendChild(wrap);
          try {
            const mod = await LOADERS[name]();
            if (currentAnalysis !== analysis) return;
            const view = mod.default({ store, analysis, navigate });
            render(wrap, view.el);
            instances.set(name, { view, wrap, pending: new Set() });
          } catch (err) {
            console.error(err);
            render(wrap, h('div', { class: 'empty' }, h('strong', null, 'This view failed to load.'), String((err as Error).message ?? err)));
          }
        })(),
      );
    }
    await loading.get(name);
  }

  async function showView(state: State) {
    const analysis = state.analysis!;
    const name = state.route.view;
    paintNav(name);
    hideTooltip();
    for (const [n, inst] of instances) inst.wrap.hidden = n !== name;
    for (const wrap of main.querySelectorAll<HTMLElement>('.view')) wrap.hidden = wrap.dataset.view !== name;
    const fresh = !instances.has(name);
    await ensureView(name, analysis);
    const inst = instances.get(name);
    if (!inst || store.get().route.view !== name) return;
    inst.wrap.hidden = false;
    const all = new Set<StateKey>(['analysis', 'population', 'source', 'theme', 'mode', 'route']);
    const changed = fresh ? all : new Set([...inst.pending, 'route' as StateKey]);
    inst.pending.clear();
    inst.view.update(store.get(), changed);
    document.title = `${NAV.find((n) => n.view === name)!.label} · ${analysis.experiment.name} · Abstraction Evaluator`;
  }

  // ------------------------------------------------------------ lifecycle
  function onAnalysis(state: State) {
    destroyViews();
    landing?.destroy();
    landing = null;
    currentAnalysis = state.analysis;
    paintHeader(state);
    if (!state.analysis) {
      document.title = 'Abstraction Evaluator';
      landing = mountLanding(main, (analysis) => {
        const population = analysis.experiment.uniqueIds.length ? 'unique' : 'all';
        store.set({ analysis, population, source: analysis.defaultSource });
      });
      return;
    }
    void showView(state);
  }

  store.subscribe((state, changed) => {
    if (changed.has('theme')) paintTheme(state.theme);
    if (changed.has('analysis')) {
      onAnalysis(state);
      return;
    }
    if (!state.analysis) return;
    if (changed.has('route')) {
      void showView(state);
      changed.delete('route');
      if (!changed.size) return;
    }
    for (const [name, inst] of instances) {
      if (name === state.route.view && !inst.wrap.hidden) inst.view.update(state, changed);
      else for (const k of changed) inst.pending.add(k);
    }
  });

  window.addEventListener('hashchange', () => store.set({ route: parseHash(location.hash) }));
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => store.set({ mode: currentMode() }));

  onAnalysis(store.get());
}
