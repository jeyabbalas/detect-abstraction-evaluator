/** Upload screen: pick or drop an experiment folder (or a .zip of it). */

import { analyze, type Analysis } from '../core/analysis';
import { LoadError, MissingGoldError, UnreadableFileError, loadExperiment } from '../core/load';
import { SchemaError } from '../core/schema';
import { fromDataTransfer, fromFileList, rerootFiles, type FileSet } from '../core/vfs';
import { callout } from '../ui/components';
import { h, render } from '../ui/dom';
import { icon } from '../ui/icons';

const TREE: [string, string][] = [
  ['experiment/', ''],
  ['├── data_dictionary/', 'JSON Schema of one record (*.json)'],
  ['├── gold_standard/', 'one or more gold standards (JSON arrays)'],
  ['├── pathology_reports/', '<record_id>.txt, one report per record'],
  ['└── abstractions/', ''],
  ['    └── <pipeline>/', 'config.json · summary.json · predictions.json · records/'],
];

const EXAMPLE = 'new_experiment_1';

export function mountLanding(parent: HTMLElement, onLoaded: (analysis: Analysis) => void): { destroy(): void } {
  const status = h('div', { class: 'landing-status', 'aria-live': 'polite' });

  const folderInput = h('input', { type: 'file', class: 'visually-hidden', webkitdirectory: true, multiple: true, tabIndex: -1 });
  const zipInput = h('input', { type: 'file', class: 'visually-hidden', accept: '.zip,application/zip', tabIndex: -1 });
  const goldInput = h('input', { type: 'file', class: 'visually-hidden', accept: '.json,application/json', tabIndex: -1 });
  /** The last folder read, kept so a gold standard can be added to it. */
  let lastSet: FileSet | null = null;
  folderInput.addEventListener('change', () => {
    if (folderInput.files?.length) void run(() => fromFileList(folderInput.files!));
    folderInput.value = '';
  });
  zipInput.addEventListener('change', () => {
    if (zipInput.files?.length) void run(() => fromFileList(zipInput.files!));
    zipInput.value = '';
  });
  goldInput.addEventListener('change', () => {
    const file = goldInput.files?.[0];
    goldInput.value = '';
    const set = lastSet;
    if (file && set) {
      const files = [...set.files.filter((f) => !f.path.startsWith('gold_standard/')), { path: `gold_standard/${file.name}`, blob: file as Blob }];
      void run(async () => ({ name: set.name, files }));
    }
  });

  const chooseFolder = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => folderInput.click() }, icon('folderOpen'), 'Choose folder');
  const chooseZip = h('button', { type: 'button', class: 'btn btn-lg', onclick: () => zipInput.click() }, icon('archive'), 'Choose .zip');

  const drop = h(
    'div',
    { class: 'dropzone', tabIndex: 0, role: 'region', 'aria-label': 'Drop an experiment folder here' },
    h('div', { class: 'dropzone-icon' }, icon('folderOpen')),
    h('div', { class: 'dropzone-title' }, 'Drop an experiment folder here'),
    h('div', { class: 'dropzone-sub' }, 'or a .zip of it'),
    h('div', { class: 'dropzone-actions' }, chooseFolder, chooseZip),
    folderInput,
    zipInput,
    goldInput,
  );

  let depth = 0;
  drop.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth += 1;
    drop.classList.add('over');
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  drop.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.classList.remove('over');
  });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    if (e.dataTransfer) {
      const dt = e.dataTransfer;
      void run(() => fromDataTransfer(dt));
    }
  });
  // Dropping anywhere on the page works too.
  const onWindowDragOver = (e: DragEvent) => e.preventDefault();
  const onWindowDrop = (e: DragEvent) => {
    if (drop.contains(e.target as Node)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      const dt = e.dataTransfer;
      void run(() => fromDataTransfer(dt));
    }
  };
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);

  let busy = false;
  async function run(collect: () => Promise<FileSet>) {
    if (busy) return;
    busy = true;
    drop.classList.add('busy');
    const setStage = (text: string) => render(status, h('div', { class: 'landing-progress' }, h('div', { class: 'spinner' }), text));
    try {
      setStage('Reading files…');
      const set = await collect();
      if (!set.files.length) throw new LoadError('No files found. Choose the experiment folder itself (the one that contains abstractions/).');
      lastSet = set;
      const experiment = await loadExperiment(set, (p) => setStage(`${p.stage}…`));
      setStage('Scoring pipelines…');
      await new Promise((r) => setTimeout(r, 0));
      const analysis = analyze(experiment);
      render(status);
      onLoaded(analysis);
    } catch (err) {
      console.error(err);
      if (err instanceof MissingGoldError) {
        render(
          status,
          callout('warning', [
            h('strong', null, 'This folder has no gold standard.'),
            h('div', null, 'Metrics need one: choose a gold-standard file (a JSON array of records), or add it to the folder under gold_standard/.'),
            h('div', { class: 'landing-actions' }, h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => goldInput.click() }, icon('upload'), 'Choose gold-standard file')),
          ]),
        );
        return;
      }
      const known = err instanceof LoadError || err instanceof SchemaError;
      render(
        status,
        callout('critical', [
          h('strong', null, known ? 'This folder could not be loaded.' : 'Something went wrong while loading.'),
          h('div', null, (err as Error).message || String(err)),
          err instanceof UnreadableFileError
            ? h(
                'div',
                null,
                'Your browser would not read it: the file changed after it was chosen, or security software (such as data-loss prevention) blocked it. Choosing the folder with Choose folder can work where dropping it does not.',
              )
            : null,
        ]),
      );
    } finally {
      busy = false;
      drop.classList.remove('busy');
    }
  }

  const devButton = import.meta.env.DEV
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-ghost',
          onclick: () =>
            void run(async () => {
              const list = (await (await fetch('/__examples/list')).json()) as string[];
              const files = await Promise.all(
                list.map(async (path) => ({ path, blob: await (await fetch(`/__examples/file/${path.split('/').map(encodeURIComponent).join('/')}`)).blob() })),
              );
              return rerootFiles(files, EXAMPLE);
            }),
        },
        icon('sparkle'),
        `Load examples/${EXAMPLE} (dev server only)`,
      )
    : null;

  const el = h(
    'div',
    { class: 'landing' },
    h(
      'div',
      { class: 'landing-inner' },
      h(
        'div',
        { class: 'landing-hero' },
        h('h1', null, 'Compare automated abstraction pipelines'),
        h(
          'p',
          null,
          'Load an experiment folder to compare LLM abstraction pipelines against a gold standard: headline metrics with confidence intervals, where the errors are, and every report side by side with what each pipeline extracted. Switch gold standards at any time to re-score.',
        ),
      ),
      drop,
      status,
      h(
        'div',
        { class: 'landing-grid' },
        h(
          'section',
          { class: 'landing-panel' },
          h('h2', null, 'Expected folder'),
          h(
            'pre',
            { class: 'tree' },
            TREE.map(([path, note]) => h('div', null, h('span', { class: 'tree-path' }, path), note ? h('span', { class: 'tree-note' }, note) : null)),
          ),
        ),
        h(
          'section',
          { class: 'landing-panel' },
          h('h2', null, icon('shield'), 'Private by design'),
          h(
            'p',
            null,
            'Everything runs in your browser. Reports, gold labels and predictions are read from your disk and never uploaded. Closing the tab forgets them.',
          ),
          h(
            'p',
            { class: 'muted', style: { marginTop: '8px' } },
            'Every metric is computed in the browser from the predictions and the gold standard; free-text (*_text) variables are excluded from the headline metrics.',
          ),
        ),
      ),
      devButton ? h('div', { class: 'landing-dev' }, devButton) : null,
    ),
  );
  parent.appendChild(el);

  return {
    destroy() {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
      el.remove();
    },
  };
}
