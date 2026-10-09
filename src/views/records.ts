/**
 * Records: one record at a time — the pathology report beside every
 * abstracted value (gold standard vs. each pipeline), the free-text values
 * highlighted in the report, an error map to jump between records, and the
 * pipeline traces. The error-analysis workhorse: keyboard navigation (← → / j k,
 * Home/End), filters, and links between highlights and variables.
 */

import { ReportIndex } from '../core/snippets';
import type { AbstractionRecord, RecordId } from '../core/types';
import type { Route } from '../state';
import {
  badge,
  copyText,
  emptyState,
  hideTooltip,
  infoTip,
  openMenu,
  segmented,
  toast,
  withTooltip,
  type SegmentOption,
} from '../ui/components';
import { h, render, type Child } from '../ui/dom';
import { fmtInt, plural } from '../ui/format';
import { icon } from '../ui/icons';
import { chrome, errorRamp } from '../ui/palette';
import { buildErrorMap, type ErrorMap } from './records/errormap';
import {
  FILTERS,
  matchesFilter,
  maxErrors,
  navigableIds,
  nearest,
  neighbor,
  parseRecordId,
  recordFacts,
  recordOptionLabel,
  shortNames,
  type FilterKey,
} from './records/model';
import { highlightReport, markTooltip, type Highlighted } from './records/report';
import { buildVariablesTable, issuesBlock, summaryBlock, type VariablesTable } from './records/table';
import { TraceCache, traceView } from './records/trace';
import { breakable, delegateTooltips, flash, prefs, revealIn, swatch } from './records/ui';
import { POPULATION_HELP } from './shared';
import type { ViewFactory } from './types';

type Tab = 'vars' | 'trace';
/** Highlight source: the gold standard or pipeline `i` (analysis order). */
type Source = 'gold' | `p${number}`;

const SPLIT_DEFAULT = 40;
const SPLIT_MIN = 22;
const SPLIT_MAX = 72;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const routeKeyOf = (rid: RecordId | null, field: string | null, pipe: number | null) => `${rid ?? ''}|${field ?? ''}|${pipe ?? ''}`;

const createRecordsView: ViewFactory = (ctx) => {
  const { analysis, store } = ctx;
  const exp = analysis.experiment;
  const { schema } = exp;
  const pipes = analysis.pipelines;
  const short = shortNames(pipes.map((pa) => pa.pipeline.name));
  const facts = recordFacts(analysis);
  const maxErr = maxErrors(facts);
  const indexes = new Map<RecordId, ReportIndex>();
  const traces = new TraceCache();

  // ------------------------------------------------------------------ state
  const st = {
    mode: store.get().mode,
    population: store.get().population,
    filter: 'all' as FilterKey,
    shown: pipes.map(() => true),
    disagreementsOnly: prefs.get('disagreements') === '1',
    showText: prefs.get('free-text') !== '0',
    current: null as RecordId | null,
    /** `?field=` from the route — kept while moving between records. */
    requested: null as string | null,
    /** `?pipeline=` from the route (analysis index) — kept while moving, until the source changes. */
    requestedPipe: null as number | null,
    /** A variable row shown whatever the filters (requested or clicked). */
    pinned: null as string | null,
    /** A free-text variable whose highlights stay focused. */
    sticky: null as string | null,
    source: 'gold' as Source,
    tab: 'vars' as Tab,
    tracePipe: null as number | null,
    collapsed: new Set<string>(),
  };
  let navigable: RecordId[] = [];
  let filtered: RecordId[] = [];
  let filteredPos = new Map<RecordId, number>();
  let navigableSet = new Set<RecordId>();
  let routeKey: string | null = null;
  let mounted = false;
  let map: ErrorMap | null = null;
  let mapWidth = 0;
  let hl: Highlighted | null = null;
  let table: VariablesTable | null = null;
  let varsView: HTMLElement | null = null;
  let highlightCount: HTMLElement | null = null;
  let focused: HTMLElement[] = [];
  let linked: HTMLElement[] = [];
  let traceToken = 0;
  let lastMark: { el: HTMLElement; k: number } | null = null;

  const shownIdx = () => pipes.map((_, i) => i).filter((i) => st.shown[i]);
  const indexFor = (rid: RecordId): ReportIndex | null => {
    let idx = indexes.get(rid);
    if (!idx) {
      const text = exp.reports.get(rid);
      if (text === undefined) return null;
      idx = new ReportIndex(text);
      indexes.set(rid, idx);
    }
    return idx;
  };
  const recordExists = (rid: RecordId) =>
    exp.gold.has(rid) || exp.reports.has(rid) || pipes.some((pa) => pa.pipeline.predictions.has(rid));
  const traceable = (rid: RecordId) => shownIdx().filter((i) => pipes[i]!.pipeline.traceFiles.has(rid));
  const effectiveTab = (rid: RecordId): Tab => (st.tab === 'trace' && traceable(rid).length ? 'trace' : 'vars');

  function effectiveSource(rid: RecordId): Source {
    if (st.source !== 'gold' && st.shown[Number(st.source.slice(1))]) return st.source;
    if (exp.gold.has(rid)) return 'gold';
    const shown = shownIdx();
    return `p${shown.find((i) => pipes[i]!.pipeline.predictions.has(rid)) ?? shown[0] ?? 0}`;
  }
  const sourceRecord = (rid: RecordId, src: Source): AbstractionRecord | undefined =>
    src === 'gold' ? exp.gold.get(rid) : pipes[Number(src.slice(1))]?.pipeline.predictions.get(rid);
  const sourceLabel = (src: Source): Child => {
    if (src === 'gold') return 'Gold standard';
    const p = pipes[Number(src.slice(1))]!.pipeline;
    return h('span', { class: 'rec-tt-line' }, swatch(p), p.name);
  };

  // ---------------------------------------------------------------- toolbar
  const prevBtn = h(
    'button',
    { type: 'button', class: 'icon-btn', 'aria-label': 'Previous record', title: 'Previous record (← or k)', onclick: () => step(-1) },
    icon('chevronLeft'),
  );
  const nextBtn = h(
    'button',
    { type: 'button', class: 'icon-btn', 'aria-label': 'Next record', title: 'Next record (→ or j)', onclick: () => step(1) },
    icon('chevronRight'),
  );
  const recordSelect = h('select', {
    class: 'select rec-select',
    'aria-label': 'Record',
    onchange: () => {
      const rid = parseRecordId(recordSelect.value);
      if (rid !== null) go(rid);
    },
  });
  const position = h('span', { class: 'rec-position', 'aria-live': 'polite' });
  const filterSelect = h('select', {
    class: 'select rec-filter',
    'aria-label': 'Filter records',
    onchange: () => setFilter(filterSelect.value as FilterKey),
  });
  const chips = h('div', { class: 'rec-tool rec-chips', role: 'group', 'aria-label': 'Pipelines shown' });
  const disagreeBox = h('input', {
    type: 'checkbox',
    checked: st.disagreementsOnly,
    onchange: () => {
      st.disagreementsOnly = disagreeBox.checked;
      prefs.set('disagreements', st.disagreementsOnly ? '1' : '0');
      applyRows();
    },
  });
  const textBox = h('input', {
    type: 'checkbox',
    checked: st.showText,
    onchange: () => {
      st.showText = textBox.checked;
      prefs.set('free-text', st.showText ? '1' : '0');
      applyRows();
    },
  });
  const keyRow = (keys: string[], what: string) =>
    h('div', { class: 'rec-key-row' }, h('span', null, keys.map((k, i) => [i ? ' ' : null, h('kbd', null, k)])), h('span', null, what));
  const keysHelp = withTooltip(
    h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Keyboard shortcuts' }, icon('keyboard')),
    () =>
      h(
        'div',
        { class: 'rec-keys' },
        h('div', { class: 'tt-title' }, 'Keyboard'),
        keyRow(['←', 'k'], 'Previous record'),
        keyRow(['→', 'j'], 'Next record'),
        keyRow(['Home', 'End'], 'First or last record'),
        keyRow(['Esc'], 'Clear the focused variable'),
      ),
  );
  const toolbar = h(
    'div',
    { class: 'rec-toolbar' },
    h('div', { class: 'rec-tool rec-nav' }, prevBtn, nextBtn, recordSelect, position, keysHelp),
    h('label', { class: 'rec-tool' }, h('span', { class: 'rec-label' }, 'Show'), filterSelect),
    pipes.length > 1 ? chips : null,
    h(
      'div',
      { class: 'rec-tool rec-toggles' },
      h('label', { class: 'checkbox', title: 'Hide variables on which every shown pipeline matches the gold standard' }, disagreeBox, 'Disagreements only'),
      schema.textFields.length
        ? h('label', { class: 'checkbox', title: 'Show the free-text (_text) variables' }, textBox, 'Free text')
        : null,
    ),
  );

  // -------------------------------------------------------------- error map
  const mapScroll = h('div', { class: 'rec-map-scroll' });
  const note = h('span', { class: 'rec-note' });
  const mapLegend = h('div', { class: 'rec-map-legend', 'aria-hidden': 'true' });
  const mapBox = h(
    'div',
    { class: 'rec-map' },
    h('div', { class: 'rec-map-head' }, h('span', { class: 'rec-map-caption' }, 'Errors per record'), note, mapLegend),
    mapScroll,
  );

  // ------------------------------------------------------------------ panes
  const docHead = h('div', { class: 'rec-pane-head rec-doc-head' });
  const docBody = h('div', { class: 'rec-pane-body rec-doc-body' });
  const sideHead = h('div', { class: 'rec-pane-head rec-side-head' });
  const sideBody = h('div', { class: 'rec-pane-body rec-side-body' });
  const splitter = h('div', {
    class: 'rec-splitter',
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the report and variables panes',
    'aria-valuemin': SPLIT_MIN,
    'aria-valuemax': SPLIT_MAX,
    title: 'Drag to resize · double-click to reset',
  });
  const panes = h(
    'div',
    { class: 'rec-panes' },
    h('section', { class: 'rec-pane rec-doc', 'aria-label': 'Report' }, docHead, docBody),
    splitter,
    h('section', { class: 'rec-pane rec-side', 'aria-label': 'Abstracted values' }, sideHead, sideBody),
  );
  const el = h('div', { class: 'records-page' }, toolbar, mapBox, panes);

  // ---------------------------------------------------------------- splitter
  let split = clamp(Number(prefs.get('split')) || SPLIT_DEFAULT, SPLIT_MIN, SPLIT_MAX);
  const applySplit = (save = false) => {
    panes.style.setProperty('--rec-split', `${split}%`);
    splitter.setAttribute('aria-valuenow', String(Math.round(split)));
    if (save) prefs.set('split', String(Math.round(split)));
  };
  applySplit();
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    const box = panes.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      split = clamp(((ev.clientX - box.left) / box.width) * 100, SPLIT_MIN, SPLIT_MAX);
      applySplit();
    };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      applySplit(true);
      requestAnimationFrame(() => table?.measure());
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    split = clamp(split + (e.key === 'ArrowLeft' ? -2 : 2), SPLIT_MIN, SPLIT_MAX);
    applySplit(true);
  });
  splitter.addEventListener('dblclick', () => {
    split = SPLIT_DEFAULT;
    applySplit(true);
  });

  // ------------------------------------------------------------------ lists
  function refreshLists() {
    navigable = navigableIds(analysis, st.population);
    navigableSet = new Set(navigable);
    const shown = shownIdx();
    const lists = new Map<FilterKey, RecordId[]>();
    for (const f of FILTERS) lists.set(f.key, navigable.filter((rid) => matchesFilter(analysis, facts.get(rid), f.key, rid, shown)));
    filtered = lists.get(st.filter)!;
    filteredPos = new Map(filtered.map((rid, k) => [rid, k]));
    render(
      filterSelect,
      FILTERS.map((f) => {
        const disabled = f.key === 'disagree' && shown.length < 2;
        const label = disabled ? `${f.label} (show 2+ pipelines)` : `${f.label} (${fmtInt(lists.get(f.key)!.length)})`;
        return h('option', { value: f.key, disabled }, label);
      }),
    );
    filterSelect.value = st.filter;
    render(
      recordSelect,
      filtered.map((rid) => h('option', { value: String(rid) }, recordOptionLabel(rid, facts.get(rid), shown))),
    );
    strayOption = null;
    paintNote();
  }

  let strayOption: HTMLOptionElement | null = null;
  function syncSelect() {
    strayOption?.remove();
    strayOption = null;
    const rid = st.current;
    if (rid === null) return;
    if (!filteredPos.has(rid)) {
      strayOption = h('option', { value: String(rid) }, `#${rid} · not in this list`);
      recordSelect.prepend(strayOption);
    }
    recordSelect.value = String(rid);
  }

  /** Why the current record is not in the list being stepped through. */
  function membership(rid: RecordId): string {
    if (!exp.gold.has(rid)) return 'not in the gold standard';
    if (!navigableSet.has(rid)) {
      const group = exp.groupOf.get(rid);
      if (st.population === 'unique' && group && group[0] !== rid) return `duplicate text, scored as #${group[0]}`;
      return 'not run by every pipeline';
    }
    return 'not in the current filter';
  }

  function syncPosition() {
    const rid = st.current;
    const k = rid === null ? undefined : filteredPos.get(rid);
    if (rid !== null && k === undefined) {
      render(position, withTooltip(badge(membership(rid), 'outline', 'filter'), 'Previous and next step through the records of the current filter.'));
    } else {
      render(position, filtered.length ? `${fmtInt((k ?? 0) + 1)} of ${fmtInt(filtered.length)}` : 'No records');
    }
    prevBtn.disabled = neighbor(filtered, rid, -1) === null;
    nextBtn.disabled = neighbor(filtered, rid, 1) === null;
  }

  /** Which records the map (and prev/next) cover: the filter within the population. */
  function paintNote() {
    const total = exp.goldIds.length;
    const unique = st.population === 'unique';
    const of = st.filter === 'all' ? '' : `${fmtInt(filtered.length)} of `;
    const what = unique
      ? `${of}${plural(navigable.length, 'unique report text')}${of ? '' : ` (of ${fmtInt(total)} records)`}`
      : `${of}${plural(navigable.length, 'record')}`;
    const popBtn = (label: string, population: 'unique' | 'all') =>
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => store.set({ population }) }, label);
    render(
      note,
      h('span', null, what),
      unique ? popBtn('Show all records', 'all') : exp.uniqueIds.length ? popBtn('Unique texts only', 'unique') : null,
      infoTip(POPULATION_HELP, 'About the population'),
    );
  }

  function paintChips() {
    if (pipes.length < 2) return;
    render(
      chips,
      pipes.map((pa, i) => {
        const on = st.shown[i]!;
        const b = h(
          'button',
          {
            type: 'button',
            class: 'chip rec-chip',
            'aria-pressed': String(on),
            title: `${pa.pipeline.name} — click to ${on ? 'hide' : 'show'}; Alt-click to show only this pipeline`,
          },
          swatch(pa.pipeline),
          h('span', { class: 'label' }, short[i]),
        );
        b.addEventListener('click', (e) => togglePipeline(i, e.altKey));
        return b;
      }),
    );
  }

  function togglePipeline(i: number, solo: boolean) {
    if (solo) st.shown = pipes.map((_, j) => j === i);
    else if (st.shown[i] && st.shown.filter(Boolean).length === 1) {
      toast('At least one pipeline stays shown.');
      return;
    } else st.shown[i] = !st.shown[i];
    if (st.requestedPipe !== null && !st.shown[st.requestedPipe]) st.requestedPipe = null;
    paintChips();
    refreshLists();
    renderMap();
    renderRecord(true);
  }

  function setFilter(f: FilterKey) {
    st.filter = f;
    refreshLists();
    renderMap();
    if (st.current === null || !filteredPos.has(st.current)) {
      const target = nearest(filtered, st.current);
      if (target !== null) {
        go(target);
        return;
      }
    }
    syncSelect();
    syncPosition();
    syncMapCurrent();
  }

  // -------------------------------------------------------------- error map
  function renderMap() {
    const width = mapScroll.clientWidth;
    mapWidth = width;
    if (!width) return; // hidden: the resize observer redraws once visible
    hideTooltip();
    const rows = shownIdx();
    if (!filtered.length) {
      map = null;
      render(
        mapScroll,
        h(
          'div',
          { class: 'rec-map-empty' },
          st.filter === 'disagree' && rows.length < 2 ? 'Show at least two pipelines to compare them.' : 'No records match this filter.',
        ),
      );
      paintLegend(false);
      return;
    }
    map = buildErrorMap({ analysis, ids: filtered, rows, max: maxErr, mode: st.mode, width, onPick: (rid) => go(rid) });
    render(mapScroll, map.el);
    paintLegend(map.hasNotRun);
    syncMapCurrent();
  }

  function syncMapCurrent() {
    if (!map) return;
    const x = map.setCurrent(st.current);
    if (x === null || mapScroll.scrollWidth <= mapScroll.clientWidth) return;
    const left = mapScroll.scrollLeft;
    if (x < left + 24 || x > left + mapScroll.clientWidth - 24) mapScroll.scrollLeft = x - mapScroll.clientWidth / 2;
  }

  function paintLegend(notRun: boolean) {
    const c = chrome(st.mode);
    const ramp = errorRamp(st.mode).slice(0, Math.min(errorRamp(st.mode).length, maxErr));
    render(
      mapLegend,
      h('span', { class: 'rec-map-key', style: { background: c.grid } }),
      h('span', null, '0'),
      h('span', { class: 'rec-map-ramp' }, ramp.map((color) => h('span', { class: 'rec-map-key', style: { background: color } }))),
      h('span', null, maxErr > 1 ? `1–${fmtInt(maxErr)} errors` : '1 error'),
      notRun ? [h('span', { class: 'rec-map-key notrun' }), h('span', null, 'not run')] : null,
    );
  }

  const resizeObserver = new ResizeObserver(() => {
    const w = mapScroll.clientWidth;
    if (w && Math.abs(w - mapWidth) > 1) renderMap();
  });
  resizeObserver.observe(mapScroll);

  // ----------------------------------------------------------------- record
  function go(rid: RecordId, opts: { push?: boolean } = {}) {
    if (rid === st.current) {
      syncSelect();
      return;
    }
    st.current = rid;
    resetFocus();
    renderRecord();
    if (opts.push !== false) pushRoute();
  }

  function step(dir: 1 | -1) {
    const next = neighbor(filtered, st.current, dir);
    if (next !== null) go(next);
  }

  function edge(dir: 1 | -1) {
    const rid = dir > 0 ? filtered[filtered.length - 1] : filtered[0];
    if (rid !== undefined) go(rid);
  }

  function pushRoute() {
    if (st.current === null) return;
    routeKey = routeKeyOf(st.current, st.requested, st.requestedPipe);
    ctx.navigate('records', [st.current], {
      field: st.requested ?? undefined,
      pipeline: st.requestedPipe !== null ? pipes[st.requestedPipe]!.pipeline.id : undefined,
    });
  }

  /** Focus follows the requested variable (if any) onto each record. */
  function resetFocus() {
    st.pinned = st.requested;
    st.sticky = st.requested && schema.byName.get(st.requested)?.kind === 'text' ? st.requested : null;
    lastMark = null;
  }

  function renderRecord(keepScroll = false) {
    hideTooltip();
    const docTop = docBody.scrollTop;
    const sideTop = sideBody.scrollTop;
    focused = [];
    linked = [];
    const rid = st.current;
    if (rid === null || !recordExists(rid)) {
      renderMissing(rid);
      return;
    }
    renderDocHead(rid);
    renderDocBody(rid);
    renderSide(rid);
    docBody.scrollTop = keepScroll ? docTop : 0;
    sideBody.scrollTop = keepScroll ? sideTop : 0;
    syncSelect();
    syncPosition();
    syncMapCurrent();
    // A requested (or clicked) variable is revealed on each new record; a
    // re-render of the same record (theme, pipelines) keeps the reader's place.
    if (st.pinned && !keepScroll) revealField(st.pinned, { flash: true });
    else setFocus(st.sticky, false);
  }

  function renderMissing(rid: RecordId | null) {
    hl = null;
    table = null;
    varsView = null;
    traceToken += 1;
    const first = filtered[0] ?? navigable[0] ?? null;
    render(docHead, h('div', { class: 'rec-doc-title' }, h('h2', null, rid === null ? 'Records' : `Record ${rid}`)));
    render(
      docBody,
      emptyState({
        icon: 'records',
        title: rid === null ? 'No records to show' : `Record ${rid} is not in this experiment`,
        body:
          rid === null
            ? 'No gold-standard record is in the current population.'
            : 'It has no gold-standard row, no report text and no prediction.',
        action:
          first !== null && first !== rid
            ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => go(first) }, `Open record ${first}`)
            : null,
      }),
    );
    render(sideHead);
    render(sideBody);
    syncSelect();
    syncPosition();
    syncMapCurrent();
  }

  // ------------------------------------------------------------- report pane
  function renderDocHead(rid: RecordId) {
    const hasGold = exp.gold.has(rid);
    const group = exp.groupOf.get(rid) ?? [rid];
    const siblings = group.filter((x) => x !== rid);
    const copyBtn = h(
      'button',
      { type: 'button', class: 'icon-btn sm', 'aria-label': `Copy record id ${rid}`, title: 'Copy record id', onclick: () => void copyText(String(rid)) },
      icon('copy'),
    );
    const goldBadge = hasGold
      ? withTooltip(badge('Gold standard', 'outline', 'check'), `${exp.goldFileName} has a row for record ${rid}; pipeline values are scored against it.`)
      : withTooltip(badge('No gold-standard row', 'warning', 'alert'), `${exp.goldFileName} has no row for record ${rid}, so nothing on it is scored.`);
    const src = effectiveSource(rid);
    const options: SegmentOption<Source>[] = [
      { value: 'gold', label: 'Gold', disabled: !hasGold, title: hasGold ? 'Highlight the gold-standard free-text values' : 'No gold-standard row' },
      ...shownIdx().map((i) => ({
        value: `p${i}` as Source,
        label: [swatch(pipes[i]!.pipeline), h('span', { class: 'rec-seg-label' }, short[i]!)] as Child,
        title: `Highlight the free-text values of ${pipes[i]!.pipeline.name}`,
      })),
    ];
    const seg = segmented<Source>({
      label: 'Highlight the free-text values of',
      size: 'sm',
      value: src,
      options,
      onChange: (v) => {
        st.source = v;
        // A linked ?pipeline= stops following the reader once they pick another source.
        if (st.requestedPipe !== null && v !== `p${st.requestedPipe}`) st.requestedPipe = null;
        onSourceChange();
      },
    });
    seg.el.classList.add('rec-wrap');
    highlightCount = h('span', { class: 'rec-hl-count' });
    render(
      docHead,
      h(
        'div',
        { class: 'rec-doc-title' },
        h('h2', null, `Record ${rid}`),
        copyBtn,
        goldBadge,
        siblings.length ? dupChips(rid, group, siblings) : null,
      ),
      h('div', { class: 'rec-doc-tools' }, h('span', { class: 'rec-label' }, 'Highlight'), seg.el, highlightCount),
    );
  }

  function dupChips(rid: RecordId, group: RecordId[], siblings: RecordId[]): HTMLElement {
    const MAX = 4;
    const rep = group[0]!;
    const help =
      rep === rid
        ? `Identical report text. The unique-reports population scores this text once, as this record (#${rid}).`
        : `Identical report text. The unique-reports population scores this text once, as #${rep}.`;
    const rest = siblings.slice(MAX);
    return h(
      'span',
      { class: 'rec-dups' },
      withTooltip(h('span', { class: 'rec-dups-label', tabIndex: 0 }, 'Same text as'), help),
      siblings.slice(0, MAX).map((x) =>
        h('button', { type: 'button', class: 'chip rec-dup', title: `Open record ${x}`, onclick: () => go(x) }, `#${x}`),
      ),
      rest.length
        ? h(
            'button',
            {
              type: 'button',
              class: 'chip rec-dup',
              'aria-haspopup': 'menu',
              onclick: (e: MouseEvent) =>
                openMenu(e.currentTarget as Element, rest.map((x) => ({ label: `Record ${x}`, onSelect: () => go(x) }))),
            },
            `+${rest.length} more`,
          )
        : null,
    );
  }

  function renderDocBody(rid: RecordId) {
    hl = null;
    focused = [];
    const text = exp.reports.get(rid);
    if (text === undefined || !text.trim()) {
      render(
        docBody,
        emptyState({
          icon: 'records',
          title: text === undefined ? 'No report text' : 'The report is empty',
          body:
            text === undefined
              ? `pathology_reports/${rid}.txt is not in the experiment folder.`
              : `pathology_reports/${rid}.txt holds no text.`,
        }),
      );
      paintHighlightCount();
      return;
    }
    const src = effectiveSource(rid);
    hl = highlightReport(indexFor(rid)!, sourceRecord(rid, src), schema.textFields);
    const unlocated = hl.unlocated.length
      ? h(
          'section',
          { class: 'rec-unlocated', 'aria-label': 'Snippets not found in the report' },
          h('h3', null, 'Not found verbatim in the report', h('span', { class: 'rec-count' }, fmtInt(hl.unlocated.length))),
          h(
            'ul',
            null,
            hl.unlocated.map((u) =>
              h(
                'li',
                null,
                h('button', { type: 'button', class: 'rec-unl-var', dataset: { field: u.field }, title: 'Show this variable' }, breakable(u.field)),
                h('span', { class: 'rec-unl-snippet' }, u.snippet),
              ),
            ),
          ),
        )
      : null;
    render(docBody, h('article', { class: 'rec-report', 'aria-label': `Pathology report ${rid}` }, hl.el), unlocated);
    paintHighlightCount();
  }

  function paintHighlightCount() {
    if (!highlightCount) return;
    if (!hl) {
      render(highlightCount);
      return;
    }
    const found = hl.marksByField.size;
    const missing = hl.unlocated.length;
    const text = hl.valued
      ? `${fmtInt(found)} of ${plural(hl.valued, 'value')} located${missing ? ` · ${fmtInt(missing)} not found` : ''}`
      : 'No free-text values';
    render(
      highlightCount,
      text,
      hl.approximate ? [' · ', h('span', { class: 'rec-hl-sample' }, 'dotted'), ' = approximate'] : null,
    );
    highlightCount.title = 'Free-text variables of the highlight source whose value (other than “Not identified”) was found in the report';
  }

  function onSourceChange() {
    const rid = st.current;
    if (rid === null) return;
    const top = docBody.scrollTop;
    renderDocBody(rid);
    docBody.scrollTop = top;
    table?.setMarked(markedFields());
    setFocus(st.sticky, false);
  }

  const markedFields = () => new Set<string>(hl ? hl.marksByField.keys() : []);

  // --------------------------------------------------------------- side pane
  function renderSide(rid: RecordId) {
    const shown = shownIdx();
    table = buildVariablesTable({ analysis, rid, shown, shortName: short, onToggleCategory: toggleCategory });
    table.setMarked(markedFields());
    table.apply(rowFilter());
    varsView = h(
      'div',
      { class: 'rec-vars-view' },
      summaryBlock(analysis, rid, shown, short),
      issuesBlock(analysis, rid, shown, short),
      table.el,
    );
    renderSideHead(rid);
    showTab(rid);
  }

  function renderSideHead(rid: RecordId) {
    const avail = traceable(rid);
    const tab = effectiveTab(rid);
    const tabs = avail.length
      ? segmented<Tab>({
          label: 'Panel',
          size: 'sm',
          value: tab,
          options: [
            { value: 'vars', label: 'Variables' },
            { value: 'trace', label: ['Trace', h('span', { class: 'count' }, fmtInt(avail.length))], title: 'Pipeline traces of this record' },
          ],
          onChange: (t) => {
            st.tab = t;
            renderSideHead(rid);
            showTab(rid);
          },
        }).el
      : h('h2', { class: 'rec-side-title' }, 'Variables');
    const focusChip = st.requested
      ? h(
          'span',
          { class: 'chip rec-focus-chip', title: 'This variable is focused on every record (from the link you followed)' },
          h('span', { class: 'rec-label' }, 'Focus'),
          h('code', null, st.requested),
          h('button', { type: 'button', class: 'rec-chip-x', 'aria-label': 'Stop focusing this variable', onclick: clearRequested }, icon('x')),
        )
      : null;
    const allCollapsed = schema.categories.every((c) => st.collapsed.has(c.key));
    const collapseBtn =
      tab === 'vars'
        ? h(
            'button',
            { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => toggleAll(!allCollapsed) },
            icon(allCollapsed ? 'chevronDown' : 'chevronUp'),
            allCollapsed ? 'Expand all' : 'Collapse all',
          )
        : null;
    render(sideHead, tabs, h('div', { class: 'rec-spacer' }), focusChip, collapseBtn);
  }

  function showTab(rid: RecordId) {
    traceToken += 1;
    if (effectiveTab(rid) === 'trace') {
      renderTrace(rid);
      return;
    }
    render(sideBody, varsView);
    requestAnimationFrame(() => table?.measure());
  }

  function renderTrace(rid: RecordId) {
    const avail = traceable(rid);
    const p = st.tracePipe !== null && avail.includes(st.tracePipe) ? st.tracePipe : avail[0]!;
    const picker = segmented<string>({
      label: 'Pipeline',
      size: 'sm',
      value: String(p),
      options: shownIdx().map((i) => ({
        value: String(i),
        label: [swatch(pipes[i]!.pipeline), h('span', { class: 'rec-seg-label' }, short[i]!)] as Child,
        disabled: !avail.includes(i),
        title: avail.includes(i) ? pipes[i]!.pipeline.name : `${pipes[i]!.pipeline.name}: no trace for this record`,
      })),
      onChange: (v) => {
        st.tracePipe = Number(v);
        sideBody.scrollTop = 0;
        renderTrace(rid);
      },
    });
    picker.el.classList.add('rec-wrap');
    const pipeline = pipes[p]!.pipeline;
    const content = h('div', { class: 'rec-trace-content' }, h('div', { class: 'rec-trace-loading' }, h('div', { class: 'spinner' }), 'Loading trace…'));
    render(
      sideBody,
      h(
        'div',
        { class: 'rec-trace' },
        h('div', { class: 'rec-trace-head' }, picker.el, h('code', { class: 'rec-trace-file' }, `${pipeline.name}/traces/${rid}.json`)),
        content,
      ),
    );
    const token = ++traceToken;
    traces.get(pipeline, rid).then(
      (trace) => {
        if (token !== traceToken) return;
        render(
          content,
          trace
            ? traceView(trace)
            : emptyState({ icon: 'alert', title: 'The trace could not be read', body: `abstractions/${pipeline.name}/traces/${rid}.json is not valid JSON.` }),
        );
      },
      (err: unknown) => {
        if (token !== traceToken) return;
        render(content, emptyState({ icon: 'alert', title: 'The trace could not be read', body: String((err as Error)?.message ?? err) }));
      },
    );
  }

  const rowFilter = () => ({
    showText: st.showText,
    disagreementsOnly: st.disagreementsOnly,
    pinned: st.pinned,
    collapsed: st.collapsed,
  });

  function applyRows() {
    if (!table) return;
    table.apply(rowFilter());
    requestAnimationFrame(() => table?.measure());
  }

  function toggleCategory(key: string) {
    if (st.collapsed.has(key)) st.collapsed.delete(key);
    else st.collapsed.add(key);
    applyRows();
    if (st.current !== null) renderSideHead(st.current);
  }

  function toggleAll(collapse: boolean) {
    st.collapsed = new Set(collapse ? schema.categories.map((c) => c.key) : []);
    applyRows();
    if (st.current !== null) renderSideHead(st.current);
  }

  // ---------------------------------------------------------------- linking
  /** Focus a free-text variable's highlights (others dim); null clears. */
  function setFocus(name: string | null, scroll: boolean) {
    for (const m of focused) m.classList.remove('focus');
    focused = (name && hl?.marksByField.get(name)) || [];
    for (const m of focused) m.classList.add('focus');
    hl?.el.classList.toggle('has-focus', focused.length > 0);
    if (scroll && focused[0]) revealIn(docBody, focused[0]);
  }

  /** Outline the variable rows a hovered highlight belongs to. */
  function setLinked(fields: string[]) {
    for (const r of linked) r.classList.remove('rec-linked');
    linked = fields.map((f) => table?.rows.get(f)).filter((r): r is HTMLTableRowElement => !!r);
    for (const r of linked) r.classList.add('rec-linked');
  }

  const fieldsOfMark = (m: HTMLElement): string[] => {
    const seg = hl?.segments[Number(m.dataset.seg)];
    return seg ? [...new Set(seg.items.map((i) => hl!.items[i]!.field))] : [];
  };

  /** Show a variable's row: switch to the table, expand its category, pin it past the filters. */
  function revealField(name: string, opts: { flash?: boolean; smooth?: boolean; center?: boolean; scroll?: boolean } = {}) {
    const info = schema.byName.get(name);
    const rid = st.current;
    if (!info || rid === null) return;
    if (effectiveTab(rid) !== 'vars') {
      st.tab = 'vars';
      renderSideHead(rid);
      showTab(rid);
    }
    const wasCollapsed = st.collapsed.delete(info.category);
    st.pinned = name;
    applyRows();
    if (wasCollapsed) renderSideHead(rid);
    const row = table?.rows.get(name);
    if (row && opts.scroll !== false) {
      revealIn(sideBody, row, { center: opts.center ?? true, smooth: opts.smooth, topInset: table?.el.tHead?.offsetHeight ?? 0 });
    }
    if (row && opts.flash) flash(row);
    if (info.kind === 'text') st.sticky = name;
    setFocus(st.sticky, opts.scroll !== false);
  }

  function activateMark(m: HTMLElement) {
    const fields = fieldsOfMark(m);
    if (!fields.length) return;
    // Repeated clicks on a highlight shared by several variables cycle through them.
    const k = lastMark && lastMark.el === m ? (lastMark.k + 1) % fields.length : 0;
    lastMark = { el: m, k };
    st.sticky = fields[k]!;
    revealField(fields[k]!, { flash: true, smooth: true });
  }

  function clearRequested() {
    st.requested = null;
    st.pinned = null;
    st.sticky = null;
    applyRows();
    setFocus(null, false);
    if (st.current !== null) {
      renderSideHead(st.current);
      pushRoute();
    }
  }

  /** Esc: drop the focused/pinned variable. Returns false when there was nothing to clear. */
  function clearFocus(): boolean {
    if (st.requested) {
      clearRequested();
      return true;
    }
    if (!st.sticky && !st.pinned) return false;
    st.sticky = null;
    st.pinned = null;
    applyRows();
    setFocus(null, false);
    return true;
  }

  // Report pane: highlight tooltips, row links, clicks.
  delegateTooltips(
    docBody,
    'mark.rec-mark',
    (m) => {
      const rid = st.current;
      if (!hl || rid === null) return null;
      const src = effectiveSource(rid);
      return markTooltip(hl, Number(m.dataset.seg), schema, sourceRecord(rid, src), sourceLabel(src));
    },
    { atPointer: true },
  );
  docBody.addEventListener('mouseover', (e) => {
    const m = (e.target as Element | null)?.closest?.('mark.rec-mark') as HTMLElement | null;
    setLinked(m ? fieldsOfMark(m) : []);
  });
  docBody.addEventListener('mouseleave', () => setLinked([]));
  docBody.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const m = target?.closest?.('mark.rec-mark') as HTMLElement | null;
    if (m) {
      activateMark(m);
      return;
    }
    const b = target?.closest?.('button.rec-unl-var') as HTMLElement | null;
    if (b?.dataset.field) revealField(b.dataset.field, { flash: true, smooth: true });
  });
  docBody.addEventListener('keydown', (e) => {
    const m = (e.target as Element | null)?.closest?.('mark.rec-mark') as HTMLElement | null;
    if (m && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      activateMark(m);
    }
  });
  docBody.addEventListener('scroll', hideTooltip, { passive: true });

  // Variables pane: hovering or focusing a free-text row focuses its highlights.
  let hoverRow: HTMLElement | null = null;
  sideBody.addEventListener('mouseover', (e) => {
    const row = (e.target as Element | null)?.closest?.('tr.rec-row') as HTMLElement | null;
    if (row === hoverRow) return;
    hoverRow = row;
    if (row?.classList.contains('rec-text')) setFocus(row.dataset.field ?? null, true);
    else setFocus(st.sticky, false);
  });
  sideBody.addEventListener('mouseleave', () => {
    hoverRow = null;
    setFocus(st.sticky, false);
  });
  sideBody.addEventListener('focusin', (e) => {
    const row = (e.target as Element | null)?.closest?.('tr.rec-text') as HTMLElement | null;
    if (row) setFocus(row.dataset.field ?? null, true);
  });
  sideBody.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget as Element | null)?.closest?.('tr.rec-text')) setFocus(st.sticky, false);
  });
  sideBody.addEventListener('click', (e) => {
    const li = (e.target as Element | null)?.closest?.('li[data-field]') as HTMLElement | null;
    if (li?.dataset.field) revealField(li.dataset.field, { flash: true, smooth: true });
  });
  sideBody.addEventListener('scroll', hideTooltip, { passive: true });
  delegateTooltips(sideBody, '[data-tt]', (target) => table?.tooltip(target) ?? null);

  // --------------------------------------------------------------- keyboard
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!el.isConnected || el.closest('.view')?.hasAttribute('hidden')) return;
    const t = e.target as Element | null;
    if (t?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    if (document.querySelector('.drawer.open, .menu')) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'j':
        step(1);
        break;
      case 'ArrowLeft':
      case 'k':
        step(-1);
        break;
      case 'Home':
        edge(-1);
        break;
      case 'End':
        edge(1);
        break;
      case 'Escape':
        if (!clearFocus()) return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ route
  interface RouteEffect {
    /** 'new': another record; 'same': re-render the current one in place. */
    record: 'new' | 'same' | null;
    /** The shown pipelines changed. */
    lists: boolean;
  }

  /**
   * Apply `#/records/<id>?field=<name>&pipeline=<id>`. `field` focuses a
   * variable and `pipeline` selects that pipeline's highlights (and trace);
   * both are kept while the reader moves between records.
   */
  function handleRoute(route: Route): RouteEffect {
    const none: RouteEffect = { record: null, lists: false };
    if (route.view !== 'records') return none;
    const id = parseRecordId(route.path[0]);
    const rawField = route.query.get('field');
    const field = rawField && schema.byName.has(rawField) ? rawField : null;
    const rawPipe = route.query.get('pipeline');
    const found = rawPipe ? pipes.findIndex((pa) => pa.pipeline.id === rawPipe || pa.pipeline.name === rawPipe) : -1;
    const pipe = found >= 0 ? found : null;
    const key = routeKeyOf(id, field, pipe);
    if (key === routeKey) return none;
    routeKey = key;
    const fieldChanged = field !== st.requested;
    const pipeChanged = pipe !== st.requestedPipe;
    st.requested = field;
    st.requestedPipe = pipe;
    let lists = false;
    if (pipe !== null && pipeChanged) {
      st.source = `p${pipe}`;
      st.tracePipe = pipe;
      if (!st.shown[pipe]) {
        st.shown[pipe] = true;
        lists = true;
      }
    }
    const target = id ?? st.current ?? nearest(filtered, null) ?? navigable[0] ?? exp.goldIds[0] ?? null;
    if (target !== st.current) {
      st.current = target;
      resetFocus();
      return { record: 'new', lists };
    }
    if (!mountedRecord()) return { record: null, lists };
    if (fieldChanged) resetFocus();
    if (lists || (pipe !== null && pipeChanged)) return { record: 'same', lists };
    if (fieldChanged) {
      renderSideHead(st.current!);
      if (field) revealField(field, { flash: true });
      else {
        applyRows();
        setFocus(null, false);
      }
    }
    return none;
  }
  const mountedRecord = () => st.current !== null && table !== null;

  paintChips();

  return {
    el,
    update(state, changed) {
      const first = !mounted;
      mounted = true;
      let lists = first;
      let drawMap = first;
      let record = first;
      let keepScroll = !first;
      // Swatches follow the theme through CSS variables; only the SVG map carries hex colors.
      if (state.mode !== st.mode) {
        st.mode = state.mode;
        drawMap = true;
      }
      if (state.population !== st.population) {
        st.population = state.population;
        lists = true;
        drawMap = true;
      }
      if (lists) refreshLists();
      const effect = first || changed.has('route') ? handleRoute(state.route) : null;
      if (effect?.lists) {
        paintChips();
        refreshLists();
        drawMap = true;
      }
      if (effect?.record) {
        record = true;
        if (effect.record === 'new') keepScroll = false;
      }
      if (st.current === null) {
        st.current = nearest(filtered, null) ?? navigable[0] ?? exp.goldIds[0] ?? null;
        resetFocus();
        record = true;
        keepScroll = false;
      }
      if (drawMap) renderMap();
      if (record) renderRecord(keepScroll);
      else {
        syncSelect();
        syncPosition();
        syncMapCurrent();
      }
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      resizeObserver.disconnect();
      traceToken += 1;
      hideTooltip();
    },
  };
};

export default createRecordsView;
