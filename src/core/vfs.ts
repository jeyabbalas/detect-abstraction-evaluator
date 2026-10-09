/**
 * Collects the files of an uploaded experiment directory from any of the
 * browser's entry points — a directory <input>, a drag-and-drop of a folder,
 * or a .zip archive — and re-roots their paths at the experiment folder.
 */

import { unzip } from 'fflate';
import type { VirtualFile } from './types';

export interface FileSet {
  /** Name of the experiment (its folder name, or the archive name). */
  name: string;
  files: VirtualFile[];
}

/** Folder names that mark the experiment root. */
const MARKERS = new Set(['abstractions', 'gold_standard', 'pathology_reports', 'data_dictionary']);

const isHidden = (path: string): boolean =>
  path.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX' || seg === 'Thumbs.db');

/**
 * Pick the experiment root among raw paths: the prefix that precedes a marker
 * folder in most files. Paths are returned relative to that root.
 */
export function rerootFiles(raw: VirtualFile[], fallbackName: string): FileSet {
  const visible = raw.filter((f) => !isHidden(f.path));
  const counts = new Map<string, number>();
  for (const f of visible) {
    const segs = f.path.split('/');
    const idx = segs.findIndex((s, i) => i < segs.length - 1 && MARKERS.has(s));
    if (idx >= 0) {
      const prefix = segs.slice(0, idx).join('/');
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  if (!counts.size) return { name: fallbackName, files: visible };
  const [prefix] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]!;
  const lead = prefix ? `${prefix}/` : '';
  const files = visible
    .filter((f) => f.path.startsWith(lead))
    .map((f) => ({ path: f.path.slice(lead.length), blob: f.blob }));
  const name = prefix ? prefix.split('/').pop()! : fallbackName;
  return { name, files };
}

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, '');

export async function fromZip(blob: Blob, name: string): Promise<FileSet> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(buffer, (err, data) => (err ? reject(err) : resolve(data))),
  );
  const raw: VirtualFile[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/')) continue; // directory entry
    raw.push({ path: path.replace(/\\/g, '/'), blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
  }
  return rerootFiles(raw, stripExt(name));
}

/** Files from `<input type="file" webkitdirectory>` (or a multi-file pick). */
export async function fromFileList(list: FileList | File[]): Promise<FileSet> {
  const files = Array.from(list);
  if (files.length === 1 && /\.zip$/i.test(files[0]!.name)) return fromZip(files[0]!, files[0]!.name);
  const raw = files.map((f) => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), blob: f as Blob }));
  const top = raw[0]?.path.includes('/') ? raw[0].path.split('/')[0]! : 'experiment';
  return rerootFiles(raw, top);
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

const entryFile = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

async function walk(entry: FileSystemEntry, prefix: string, out: VirtualFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ path, blob: await entryFile(entry as FileSystemFileEntry) });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    await Promise.all(children.map((c) => walk(c, path, out)));
  }
}

/** Files from a drag-and-drop: a folder, several items, or a single .zip. */
export async function fromDataTransfer(dt: DataTransfer): Promise<FileSet> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return fromFileList(Array.from(dt.files));
  if (entries.length === 1 && entries[0]!.isFile && /\.zip$/i.test(entries[0]!.name)) {
    const file = await entryFile(entries[0] as FileSystemFileEntry);
    return fromZip(file, file.name);
  }
  const raw: VirtualFile[] = [];
  await Promise.all(entries.map((e) => walk(e, '', raw)));
  const top = entries.length === 1 && entries[0]!.isDirectory ? entries[0]!.name : 'experiment';
  return rerootFiles(raw, top);
}
