/**
 * Data: the gold standard, each pipeline's predictions and a long
 * cell-by-cell comparison as interactive tables (@jeyabbalas/data-table:
 * DuckDB-WASM in the browser, column charts that cross-filter, filters,
 * sorting, annotations, export). One table instance is created on first show
 * and reused for every dataset.
 */

import { createDataTable, type DataTable } from '@jeyabbalas/data-table';
import { callout, emptyState, infoTip, segmented, toast } from '../ui/components';
import { h, render, type Child } from '../ui/dom';
import { fmtInt, plural } from '../ui/format';
import { icon } from '../ui/icons';
import { seriesVar, type Mode } from '../ui/palette';
import {
  ERRORS_COLUMN,
  ERRORS_TOOLTIP,
  ROWID,
  buildDataset,
  datasetOptions,
  errorVector,
  placeAfter,
  resolveDatasetKey,
  rowIdMap,
  tableNames,
  type Dataset,
  type DatasetOption,
} from './data/datasets';
import type { ViewFactory } from './types';

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 110;
/** Frames to wait for a visible, non-zero-height container before giving up until the next update. */
const MOUNT_FRAMES = 30;

type OverlayKind = 'init' | 'init-error' | 'load-error' | 'crash' | 'empty';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || 'Unknown error';
const errorCode = (err: unknown): string =>
  err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : '';

const createDataView: ViewFactory = (ctx) => {
  const { analysis } = ctx;
  const { experiment } = analysis;
  const { schema } = experiment;
  const options = datasetOptions(analysis);
  const names = tableNames(options);
  const optionOf = (key: string): DatasetOption => options.find((o) => o.key === key) ?? options[0]!;
  const cache = new Map<string, Dataset>();
  const datasetOf = (key: string): Dataset => {
    let ds = cache.get(key);
    if (!ds) {
      const option = optionOf(key);
      ds = buildDataset(analysis, option, names.get(option.key)!);
      cache.set(key, ds);
    }
    return ds;
  };
  const pipelineIndex = (o: DatasetOption): number => analysis.pipelines[o.pipeline ?? 0]?.pipeline.index ?? 0;

  let current = options[0]!.key;
  let mode: Mode = ctx.store.get().mode;
  let table: DataTable | null = null;
  let creating = false;
  let initFailed = false;
  let destroyed = false;
  let loadSeq = 0;
  let mountTries = 0;
  let raf = 0;
  let overlayKind: OverlayKind | null = null;

  // ------------------------------------------------------------- toolbar

  const optionTitle = (o: DatasetOption): string =>
    o.kind === 'gold'
      ? `The gold standard (${experiment.goldFileName})`
      : o.kind === 'cells'
        ? 'Every pipeline × record × categorical variable in one long table'
        : `Predictions of ${o.label}`;

  const optionLabel = (o: DatasetOption): Child =>
    o.kind === 'pipeline'
      ? [h('span', { class: 'swatch', style: { color: seriesVar(pipelineIndex(o)) } }), h('span', { class: 'data-option-label' }, o.label)]
      : o.label;

  function buildPicker(): { el: HTMLElement; set(key: string): void } {
    if (options.length <= 5) {
      return segmented<string>({
        label: 'Dataset',
        value: current,
        options: options.map((o) => ({ value: o.key, label: optionLabel(o), title: optionTitle(o) })),
        onChange: choose,
      });
    }
    const swatch = h('span', { class: 'swatch', 'aria-hidden': 'true' });
    const select = h(
      'select',
      { class: 'select', 'aria-label': 'Dataset' },
      options.map((o) => h('option', { value: o.key, title: optionTitle(o) }, o.kind === 'pipeline' ? `Predictions: ${o.label}` : o.label)),
    );
    const set = (key: string) => {
      const o = optionOf(key);
      select.value = o.key;
      swatch.hidden = o.kind !== 'pipeline';
      if (o.kind === 'pipeline') swatch.style.color = seriesVar(pipelineIndex(o));
    };
    select.addEventListener('change', () => choose(select.value));
    set(current);
    return { el: h('div', { class: 'data-select' }, swatch, select), set };
  }

  const picker = buildPicker();
  const busy = h('div', { class: 'spinner data-busy', role: 'status', 'aria-label': 'Loading the dataset', hidden: true });
  const help = infoTip(
    h(
      'div',
      null,
      h('div', { class: 'tt-title' }, 'Working with the table'),
      h(
        'ul',
        { class: 'data-help' },
        h('li', null, 'Click a bar in a column chart, or drag across a histogram, to filter. The other charts redraw for the filtered rows.'),
        h('li', null, 'Click a row to select it (Shift-click for a range, Ctrl/⌘-click to add rows), then Open record to see it next to its report.'),
        h('li', null, 'Hover a flagged cell for the gold value, and a column name for its definition.'),
        h('li', null, 'Export saves all, filtered or selected rows as CSV, JSON or Parquet.'),
      ),
    ),
    'How to use the table',
  );
  const desc = h('p', { class: 'data-desc', 'aria-live': 'polite' });
  const openBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm', disabled: true, title: 'Select one row, then open its record' },
    icon('records'),
    'Open record',
  );
  const exportBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm', disabled: true, title: 'Export all, filtered or selected rows as CSV, JSON or Parquet' },
    icon('download'),
    'Export',
  );

  const host = h('div', { class: 'data-table-host' });
  const overlay = h('div', { class: 'data-overlay', 'aria-live': 'polite', hidden: true });

  const el = h(
    'div',
    { class: 'data-view' },
    h(
      'div',
      { class: 'data-toolbar' },
      h('div', { class: 'data-picker' }, picker.el, help, busy),
      desc,
      h('div', { class: 'data-actions' }, openBtn, exportBtn),
    ),
    h('div', { class: 'data-body' }, host, overlay),
  );

  openBtn.addEventListener('click', () => void openSelected());
  exportBtn.addEventListener('click', () => {
    if (table && !table.isDestroyed()) table.openExportDialog();
  });

  // --------------------------------------------------------- description

  const flag = (tone: 'error' | 'warning') => h('span', { class: ['data-flag', tone], 'aria-hidden': 'true' });
  const SEP = ' · ';

  function describe(): void {
    const o = optionOf(current);
    const ds = datasetOf(o.key);
    const shape = `${plural(ds.rowCount, 'record')} × ${plural(Math.max(0, ds.columns.length - 1), 'variable')}`;
    const parts: Child[] = [];
    if (ds.kind === 'gold') {
      parts.push(h('strong', null, 'Gold standard'), ` (${experiment.goldFileName})`, SEP, shape);
    } else if (ds.kind === 'pipeline') {
      parts.push(
        'Predictions of ',
        h('span', { class: 'data-desc-name' }, h('span', { class: 'swatch', style: { color: seriesVar(pipelineIndex(o)) } }), h('strong', null, o.label)),
        SEP,
        shape,
        SEP,
      );
      const n = ds.stats.mismatches;
      if (n) parts.push(flag('error'), `${plural(n, 'cell')} ${n === 1 ? 'disagrees' : 'disagree'} with the gold standard — hover one for the gold value`);
      else parts.push('every scored cell agrees with the gold standard');
      if (ds.stats.missing) parts.push(SEP, `${plural(ds.stats.missing, 'record')} without a prediction`);
    } else {
      parts.push(
        h('strong', null, 'Cell comparison'),
        SEP,
        `one row per pipeline × record × categorical variable (${fmtInt(ds.rowCount)} rows) — use the column charts to cross-filter by pipeline, category, variable and outcome`,
      );
    }
    if (ds.stats.schemaIssues) parts.push(SEP, flag('warning'), `${plural(ds.stats.schemaIssues, 'JSON Schema issue')}`);
    render(desc, parts);
  }

  // ------------------------------------------------------------- overlay

  function setOverlay(content: Child | null, kind: OverlayKind | null = null): void {
    overlayKind = content === null ? null : kind;
    overlay.hidden = content === null;
    render(overlay, content);
  }

  const detail = (err: unknown) => h('p', { class: 'data-error-detail' }, h('code', null, errorText(err)));

  function initError(err: unknown): HTMLElement {
    return callout('critical', [
      h('strong', null, 'The table engine could not start.'),
      h(
        'p',
        null,
        'The Data view runs DuckDB-WASM in your browser. It downloads DuckDB-WASM from cdn.jsdelivr.net and its extensions from extensions.duckdb.org, so it needs to reach both: check whether you are offline, or whether a firewall, content blocker or browser policy blocks those sites.',
      ),
      detail(err),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => retryInit() }, 'Try again'),
    ]);
  }

  function loadError(ds: Dataset, err: unknown): HTMLElement {
    const network = errorCode(err) === 'LOAD_PARSE_FAILED' || /extension|xmlhttprequest|fetch|network/i.test(errorText(err));
    return callout('critical', [
      h('strong', null, `Could not load the ${ds.kind === 'pipeline' ? `predictions of ${ds.label}` : ds.label.toLowerCase()} into the table.`),
      network
        ? h('p', null, 'Loading needs DuckDB extensions from extensions.duckdb.org: check whether you are offline or the site is blocked.')
        : null,
      detail(err),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm',
          onclick: () => {
            setOverlay(null);
            void load();
          },
        },
        'Try again',
      ),
    ]);
  }

  function crashed(err: unknown): HTMLElement {
    return callout('critical', [
      h('strong', null, 'The table engine stopped.'),
      h('p', null, 'DuckDB-WASM stopped working in this tab, and the table lost its data. Restart it to load the dataset again.'),
      detail(err),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => void restart() }, 'Restart the table'),
    ]);
  }

  function setBusy(on: boolean): void {
    busy.hidden = !on;
    host.setAttribute('aria-busy', String(on));
  }

  // --------------------------------------------------------------- table

  function ensureTable(): void {
    cancelAnimationFrame(raf);
    if (table || creating || initFailed || destroyed) return;
    // The table measures its container: mount only once it is laid out.
    if (!host.isConnected || host.clientHeight === 0) {
      if (mountTries < MOUNT_FRAMES) {
        mountTries += 1;
        raf = requestAnimationFrame(ensureTable);
      }
      return;
    }
    void createTable();
  }

  async function createTable(): Promise<void> {
    if (creating || destroyed) return;
    creating = true;
    initFailed = false;
    setOverlay([h('div', { class: 'spinner' }), h('div', null, 'Starting the table engine (DuckDB-WASM)…')], 'init');
    let t: DataTable;
    try {
      t = await createDataTable({
        container: host,
        // Tooltips and annotations are re-applied on every load; nothing
        // (patient data included) is written to IndexedDB.
        persistence: false,
        colorScheme: mode,
        rowHeight: ROW_HEIGHT,
        headerHeight: HEADER_HEIGHT,
      });
    } catch (err) {
      creating = false;
      if (destroyed) return;
      console.error(err);
      initFailed = true;
      setOverlay(initError(err), 'init-error');
      return;
    }
    creating = false;
    if (destroyed) {
      void t.destroy().catch(() => undefined);
      return;
    }
    table = t;
    if (t.getColorScheme() !== mode) t.setColorScheme(mode);
    t.on('selectionChange', ({ selectedRows }) => {
      if (t === table) openBtn.disabled = selectedRows.size !== 1;
    });
    t.on('error', ({ error }) => {
      if (t === table && error.code === 'WORKER_CRASHED') {
        console.error(error);
        setOverlay(crashed(error), 'crash');
      }
    });
    exportBtn.disabled = false;
    setOverlay(null);
    void load();
  }

  function retryInit(): void {
    if (table || creating || destroyed) return;
    initFailed = false;
    host.replaceChildren();
    mountTries = 0;
    ensureTable();
  }

  async function restart(): Promise<void> {
    const t = table;
    table = null;
    loadSeq += 1;
    openBtn.disabled = true;
    exportBtn.disabled = true;
    setBusy(false);
    if (t && !t.isDestroyed()) await t.destroy().catch(() => undefined);
    if (destroyed) return;
    host.replaceChildren();
    initFailed = false;
    mountTries = 0;
    ensureTable();
  }

  async function load(): Promise<void> {
    const t = table;
    if (!t || destroyed || t.isDestroyed()) return;
    const seq = ++loadSeq;
    const ds = datasetOf(current);
    openBtn.disabled = true;
    if (overlayKind === 'load-error' || overlayKind === 'empty') setOverlay(null);
    t.annotations.clear();
    if (!ds.rowCount) {
      setBusy(false);
      setOverlay(emptyState({ icon: 'table', title: 'No rows to show', body: `${ds.label} has no records.` }), 'empty');
      return;
    }
    setBusy(true);
    try {
      await t.loadData(new Blob([ds.json], { type: 'application/json' }), {
        tableName: ds.tableName,
        sourceFormat: 'json',
        sourceOptions: { json: { format: 'array', sampleSize: -1 } },
      });
      if (seq !== loadSeq || t !== table) return;
      await decorate(t, ds, seq);
    } catch (err) {
      if (seq !== loadSeq || t !== table || destroyed) return;
      console.error(err);
      if (overlayKind !== 'crash') setOverlay(loadError(ds, err), 'load-error');
    } finally {
      if (seq === loadSeq) setBusy(false);
    }
  }

  /** Header tooltips, the pinned id, annotations and the errors column for a freshly loaded dataset. */
  async function decorate(t: DataTable, ds: Dataset, seq: number): Promise<void> {
    const stale = () => seq !== loadSeq || t !== table || t.isDestroyed();
    for (const [column, content] of ds.tooltips) t.actions.setColumnHeaderTooltip(column, content);
    if (ds.keyed) {
      if (!t.state.pinnedColumns.get().includes(schema.idField)) t.actions.toggleColumnPin(schema.idField);
      // Annotations key on __rowid__: map record ids to it from the table itself.
      const [rowids, ids] = await Promise.all([t.actions.getColumnValues(ROWID), t.actions.getColumnValues(schema.idField)]);
      if (stale()) return;
      const rowOf = rowIdMap(rowids, ids);
      const notes = ds.annotations(rowOf);
      try {
        if (notes.length) t.annotations.addMany(notes);
      } catch (err) {
        console.warn('[data] annotations were not added', err);
      }
      if (ds.errorCounts) {
        try {
          const values = errorVector(ds.errorCounts, rowOf, t.state.totalRows.get());
          const result = await t.actions.addDerivedColumn({ kind: 'vector', name: ERRORS_COLUMN, vectorType: 'integer', values });
          if (stale()) return;
          if (result.success) {
            t.actions.setColumnHeaderTooltip(ERRORS_COLUMN, ERRORS_TOOLTIP);
            t.actions.setColumnOrder(placeAfter(t.state.columnOrder.get(), ERRORS_COLUMN, schema.idField));
          } else {
            console.warn(`[data] ${ERRORS_COLUMN} was not added: ${result.error ?? 'unknown error'}`);
          }
        } catch (err) {
          if (stale()) return;
          console.warn(`[data] ${ERRORS_COLUMN} was not added`, err);
        }
      }
    }
    if (stale()) return;
    // The set-up above is not the user's to undo.
    t.actions.getUndoManager()?.clear();
  }

  async function openSelected(): Promise<void> {
    const t = table;
    if (!t || t.isDestroyed()) return;
    try {
      const values = await t.actions.getColumnValues(schema.idField, { scope: 'selected' });
      const rid = values.length === 1 ? Number(values[0]) : Number.NaN;
      if (!Number.isFinite(rid)) {
        toast('The selected row is no longer in view — select one row again.');
        return;
      }
      ctx.navigate('records', [rid]);
    } catch (err) {
      console.error(err);
      toast('Could not read the selected row.');
    }
  }

  // ------------------------------------------------------------ datasets

  function show(key: string): void {
    current = key;
    picker.set(key);
    describe();
    void load();
  }

  function choose(key: string): void {
    if (key !== current) show(key);
    ctx.navigate('data', [], { dataset: key });
  }

  describe();

  return {
    el,
    update(state, changed) {
      if (changed.has('mode')) {
        mode = state.mode;
        if (table && !table.isDestroyed()) table.setColorScheme(mode);
      }
      if (changed.has('route') && state.route.view === 'data') {
        const key = resolveDatasetKey(options, state.route.query.get('dataset'));
        if (key && key !== current) show(key);
      }
      mountTries = 0;
      ensureTable();
    },
    destroy() {
      destroyed = true;
      loadSeq += 1;
      cancelAnimationFrame(raf);
      const t = table;
      table = null;
      if (t && !t.isDestroyed()) void t.destroy().catch(() => undefined);
    },
  };
};

export default createDataView;
