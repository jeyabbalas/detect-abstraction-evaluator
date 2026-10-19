/**
 * The pipeline's own notes on a record (summary.json `issues`): problems left
 * after the repair rounds, fallbacks, gate changes, fixes and schema errors,
 * flattened for display.
 */

import type { RecordNotes, SchemaModel } from './types';

export type RunNoteKind = 'unresolved' | 'fallback' | 'schema' | 'gate' | 'fix' | 'other';

export interface RunNote {
  kind: RunNoteKind;
  /** Short label of the kind ("Gate change"). */
  label: string;
  text: string;
  /** Stage the note comes from (unresolved problems). */
  stage?: string;
}

const NOTE_KINDS: [key: string, kind: RunNoteKind, label: string][] = [
  ['unresolved', 'unresolved', 'Unresolved'],
  ['fallbacks', 'fallback', 'Fallback'],
  ['schema_errors', 'schema', 'Schema error'],
  ['gate_changes', 'gate', 'Gate change'],
  ['fixes', 'fix', 'Fix'],
];

const noteText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** A record's summary.json notes as a flat list, most serious first. */
export function runNotes(notes: RecordNotes | undefined): RunNote[] {
  if (!notes) return [];
  const out: RunNote[] = [];
  const known = new Set(NOTE_KINDS.map(([key]) => key));
  for (const [key, kind, label] of NOTE_KINDS) {
    const v = notes[key];
    if (Array.isArray(v)) for (const x of v) out.push({ kind, label, text: noteText(x) });
    else if (v && typeof v === 'object') {
      for (const [stage, list] of Object.entries(v)) {
        for (const x of Array.isArray(list) ? list : [list]) out.push({ kind, label, text: noteText(x), stage });
      }
    } else if (v !== undefined && v !== null) out.push({ kind, label, text: noteText(v) });
  }
  for (const [key, v] of Object.entries(notes)) {
    if (known.has(key) || v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.push({ kind: 'other', label: key, text: noteText(x) });
  }
  return out;
}

/** The first variable a note names ("GI_cancer_primary: 'No' -> …" → GI_cancer_primary), if any. */
export function fieldNamed(text: string, schema: SchemaModel): string | null {
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) if (schema.byName.has(m[0])) return m[0];
  return null;
}
