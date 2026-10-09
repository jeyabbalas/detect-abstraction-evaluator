/**
 * Builds the field contract from the data-dictionary JSON Schema.
 *
 * Mirrors the abstraction code's `schema.py`:
 *  - categories are the root schema's `$defs` entries that declare properties,
 *    titled by the text after the em dash;
 *  - categorical fields have a closed value domain (`enum` / `oneOf` consts);
 *    free-text fields end with `_text` and are excluded from headline metrics;
 *  - the default label is the first of 'Cannot determine', 'Not identified', 'No'
 *    present in the domain.
 */

import {
  findSchemaRoots,
  schemaDocumentsToTable,
  type DataDictionaryRow,
  type JsonSchema,
} from 'json-schema-data-dictionary';
import type { CategoryInfo, FieldInfo, FieldKind, SchemaDocument, SchemaModel } from './types';

const DEFAULT_LABEL_ORDER = ['Cannot determine', 'Not identified', 'No'] as const;
export const TEXT_DEFAULT = 'Not identified';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The default (uninformative) label for a domain, or null when none applies. */
export function defaultLabelFor(domain: readonly string[]): string | null {
  for (const label of DEFAULT_LABEL_ORDER) if (domain.includes(label)) return label;
  return null;
}

/** Text after the last em dash, as `schema.py` titles categories. */
export function categoryTitle(title: string): string {
  return title.split('—').pop()!.trim();
}

/** Resolve a local JSON pointer `$ref` (`#/$defs/x`) against the root document. */
function resolveLocal(root: Obj, node: unknown, depth = 0): unknown {
  if (!isObj(node) || typeof node.$ref !== 'string' || depth > 16) return node;
  const ref = node.$ref;
  if (!ref.startsWith('#')) return node;
  const parts = ref
    .slice(1)
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const p of parts) {
    if (!isObj(cur) && !Array.isArray(cur)) return node;
    cur = (cur as Obj)[p];
  }
  return resolveLocal(root, cur, depth + 1);
}

/** Closed set of string constants a property allows (enum / oneOf / anyOf consts). */
function constDomain(root: Obj, prop: unknown): string[] {
  const p = resolveLocal(root, prop);
  if (!isObj(p)) return [];
  if (Array.isArray(p.enum)) return p.enum.filter((v): v is string => typeof v === 'string');
  if (typeof p.const === 'string') return [p.const];
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = p[key];
    if (Array.isArray(branches) && branches.length) {
      const resolved = branches.map((b) => resolveLocal(root, b));
      if (resolved.every((b) => isObj(b) && 'const' in b)) {
        return resolved.map((b) => (b as Obj).const).filter((v): v is string => typeof v === 'string');
      }
      // A mix of consts and open strings (free text with a sentinel) is not a closed domain.
      return [];
    }
  }
  return [];
}

function rowText(row: DataDictionaryRow | undefined): { title: string; description: string } {
  if (!row) return { title: '', description: '' };
  const [first, ...rest] = (row.Description ?? '').split('\n');
  return { title: first ?? '', description: rest.join('\n').trim() };
}

export interface SchemaInput {
  name: string;
  json: unknown;
}

export class SchemaError extends Error {}

export function buildSchemaModel(inputs: SchemaInput[]): SchemaModel {
  const documents: SchemaDocument[] = inputs
    .filter((d) => isObj(d.json))
    .map((d) => ({
      uri: `file:///data_dictionary/${encodeURIComponent(d.name)}`,
      name: d.name,
      schema: d.json as JsonSchema,
    }));
  if (!documents.length) throw new SchemaError('No JSON Schema document found in data_dictionary/.');

  const roots = findSchemaRoots(documents);
  if (!roots.length) throw new SchemaError('None of the data_dictionary/ files reads like a JSON Schema.');
  const rootIndex = roots[0]!.index;
  const rootDoc = documents[rootIndex]!;
  const root = rootDoc.schema as Obj;
  const dictionary = schemaDocumentsToTable(documents, { rootIndex });

  const rows = new Map<string, DataDictionaryRow>();
  for (const row of dictionary.rows) {
    if ((row.__depth ?? 0) === 0 && !rows.has(row['Variable name'])) rows.set(row['Variable name'], row);
  }

  // The id field: the property marked as primary key, else `record_id`.
  let idField = 'record_id';
  const defs = isObj(root.$defs) ? root.$defs : isObj(root.definitions) ? (root.definitions as Obj) : {};
  for (const def of Object.values(defs)) {
    if (!isObj(def) || !isObj(def.properties)) continue;
    for (const [name, prop] of Object.entries(def.properties)) {
      if (isObj(prop) && prop['x-role'] === 'primary key') idField = name;
    }
  }

  // Categories, in $defs order (exactly as schema.py's categories()).
  const categories: CategoryInfo[] = [];
  const rawProps = new Map<string, unknown>();
  for (const [key, def] of Object.entries(defs)) {
    if (!isObj(def) || !isObj(def.properties)) continue;
    const names = Object.keys(def.properties).filter((n) => n !== idField);
    for (const n of Object.keys(def.properties)) if (!rawProps.has(n)) rawProps.set(n, def.properties[n]);
    if (!names.length) continue;
    const title = typeof def.title === 'string' ? def.title : key;
    categories.push({
      key,
      title: categoryTitle(title),
      description: typeof def.description === 'string' ? def.description : '',
      fields: names,
      categorical: [],
      text: [],
    });
  }

  // Fallback: no $defs groups — use the dictionary's own sections.
  if (!categories.length) {
    for (const cat of dictionary.categories) {
      const names = cat.rows
        .filter((r) => (r.__depth ?? 0) === 0)
        .map((r) => r['Variable name'])
        .filter((n) => n !== idField);
      if (names.length) {
        categories.push({
          key: cat.id,
          title: categoryTitle(cat.title),
          description: cat.description ?? '',
          fields: names,
          categorical: [],
          text: [],
        });
      }
    }
  }

  // Variables the categories do not cover (e.g. inline item properties) go last.
  const covered = new Set(categories.flatMap((c) => c.fields));
  const leftovers = [...rows.keys()].filter((n) => n !== idField && !covered.has(n));
  if (leftovers.length) {
    categories.push({ key: 'other', title: 'Other variables', description: '', fields: leftovers, categorical: [], text: [] });
  }

  const fields: FieldInfo[] = [];
  const byName = new Map<string, FieldInfo>();
  for (const cat of categories) {
    for (const name of cat.fields) {
      if (byName.has(name)) continue;
      const raw = resolveLocal(root, rawProps.get(name));
      const row = rows.get(name);
      let domain = constDomain(root, raw);
      if (!domain.length && row && !name.endsWith('_text')) {
        const vals = row['Valid values'].map((v) => v.value).filter((v): v is string => typeof v === 'string');
        if (row['Data type'].startsWith('categorical')) domain = vals;
      }
      let kind: FieldKind;
      if (name.endsWith('_text')) kind = 'text';
      else if (domain.length) kind = 'categorical';
      else kind = 'text';
      const fromRow = rowText(row);
      const title = isObj(raw) && typeof raw.title === 'string' ? raw.title : fromRow.title || name;
      const description = isObj(raw) && typeof raw.description === 'string' ? raw.description : fromRow.description;
      const info: FieldInfo = {
        name,
        title,
        description,
        kind,
        category: cat.key,
        domain: kind === 'categorical' ? domain : [],
        defaultLabel: kind === 'categorical' ? defaultLabelFor(domain) : TEXT_DEFAULT,
        order: fields.length,
      };
      fields.push(info);
      byName.set(name, info);
      (kind === 'categorical' ? cat.categorical : cat.text).push(name);
    }
  }

  return {
    title: typeof root.title === 'string' ? root.title : dictionary.title ?? rootDoc.name,
    description: typeof root.description === 'string' ? root.description : dictionary.description ?? '',
    rootName: rootDoc.name,
    documents,
    root,
    idField,
    fields,
    byName,
    categories,
    categoryByKey: new Map(categories.map((c) => [c.key, c])),
    categoricalFields: fields.filter((f) => f.kind === 'categorical').map((f) => f.name),
    textFields: fields.filter((f) => f.kind === 'text').map((f) => f.name),
    dictionary,
  };
}
