/**
 * Builds the field contract from the data-dictionary JSON Schema, which
 * describes one abstraction record:
 *  - every root property except `record_id` is a variable, in schema order;
 *  - categorical fields have a closed value domain (`enum` / `oneOf` consts);
 *    free-text fields end with `_text` and are excluded from headline metrics;
 *  - categories are the progressive pipeline's stages
 *    (`x-abstraction.progressive.stages`, each listing the fields it codes);
 *    a field listed by several stages belongs to the first;
 *  - the default label is the first of 'Cannot determine', 'Not identified', 'No'
 *    present in the domain.
 */

import {
  findSchemaRoots,
  schemaDocumentsToTable,
  type DataDictionaryCategory,
  type DataDictionaryRow,
  type DataDictionaryTable,
  type JsonSchema,
} from 'json-schema-data-dictionary';
import type { CategoryInfo, FieldInfo, FieldKind, SchemaDocument, SchemaModel } from './types';

const DEFAULT_LABEL_ORDER = ['Cannot determine', 'Not identified', 'No'] as const;
export const TEXT_DEFAULT = 'Not identified';
export const ID_FIELD = 'record_id';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The default (uninformative) label for a domain, or null when none applies. */
export function defaultLabelFor(domain: readonly string[]): string | null {
  for (const label of DEFAULT_LABEL_ORDER) if (domain.includes(label)) return label;
  return null;
}

/** "specimens" → "Specimens", "benign_uterine" → "Benign uterine". */
export function stageTitle(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A `$comment` (a string or an array of lines) as text. */
const commentText = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(' ') : '';

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

/** The progressive pipeline's stages as categories (fields not in `names` are ignored). */
function stageCategories(root: Obj, names: ReadonlySet<string>): CategoryInfo[] {
  const xa = root['x-abstraction'];
  const stages = isObj(xa) && isObj(xa.progressive) ? xa.progressive.stages : null;
  if (!isObj(stages)) return [];
  const taken = new Set<string>();
  const out: CategoryInfo[] = [];
  for (const [key, stage] of Object.entries(stages)) {
    if (!isObj(stage) || !Array.isArray(stage.fields)) continue;
    const fields = stage.fields.filter((n): n is string => typeof n === 'string' && names.has(n) && !taken.has(n));
    for (const n of fields) taken.add(n);
    if (!fields.length) continue;
    out.push({ key, title: stageTitle(key), description: commentText(stage.$comment), fields, categorical: [], text: [] });
  }
  return out;
}

/** The dictionary table regrouped into the model's categories (the id field leads the first). */
function regroup(dictionary: DataDictionaryTable, categories: readonly CategoryInfo[], idField: string): DataDictionaryTable {
  const top = (row: DataDictionaryRow): string => {
    const first = row.__path?.[0];
    return first && 'name' in first && typeof first.name === 'string' ? first.name : row['Variable name'];
  };
  const byField = new Map<string, DataDictionaryRow[]>();
  for (const row of dictionary.rows) {
    const name = top(row);
    if (!byField.has(name)) byField.set(name, []);
    byField.get(name)!.push(row);
  }
  const groups: DataDictionaryCategory[] = categories.map((cat, i) => ({
    id: cat.key,
    title: cat.title,
    description: cat.description || undefined,
    rows: [...(i === 0 ? (byField.get(idField) ?? []) : []), ...cat.fields.flatMap((n) => byField.get(n) ?? [])],
  }));
  return { ...dictionary, categories: groups };
}

/** Distinct `x-rule` numbers of the root's if/then blocks; blocks without one count once each. */
function ruleCount(root: Obj, fallback: number): number {
  const blocks = Array.isArray(root.allOf) ? root.allOf.filter((b): b is Obj => isObj(b) && 'if' in b) : [];
  if (!blocks.length) return fallback;
  const numbered = new Set(blocks.map((b) => b['x-rule']).filter((n) => n !== undefined));
  return numbered.size + blocks.filter((b) => b['x-rule'] === undefined).length;
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
  let dictionary = schemaDocumentsToTable(documents, { rootIndex });

  const rows = new Map<string, DataDictionaryRow>();
  for (const row of dictionary.rows) {
    if ((row.__depth ?? 0) === 0 && !rows.has(row['Variable name'])) rows.set(row['Variable name'], row);
  }
  const idField = ID_FIELD;
  const props = isObj(root.properties) ? root.properties : {};
  const names = (Object.keys(props).length ? Object.keys(props) : [...rows.keys()]).filter((n) => n !== idField);

  let categories = stageCategories(root, new Set(names));
  const staged = categories.length > 0;
  // Without stages, the dictionary's own sections.
  if (!staged) {
    const known = new Set(names);
    for (const cat of dictionary.categories) {
      const fields = cat.rows
        .filter((r) => (r.__depth ?? 0) === 0)
        .map((r) => r['Variable name'])
        .filter((n) => known.has(n));
      if (fields.length) categories.push({ key: cat.id, title: cat.title, description: cat.description ?? '', fields, categorical: [], text: [] });
    }
  }
  // Variables no category covers go last, in schema order.
  const covered = new Set(categories.flatMap((c) => c.fields));
  const leftovers = names.filter((n) => !covered.has(n));
  if (leftovers.length) {
    categories = [...categories, { key: 'other', title: 'Other variables', description: '', fields: leftovers, categorical: [], text: [] }];
  }

  const fields: FieldInfo[] = [];
  const byName = new Map<string, FieldInfo>();
  for (const cat of categories) {
    for (const name of cat.fields) {
      const raw = resolveLocal(root, props[name]);
      const row = rows.get(name);
      let domain = constDomain(root, raw);
      if (!domain.length && row && !name.endsWith('_text') && row['Data type'].startsWith('categorical')) {
        domain = row['Valid values'].map((v) => v.value).filter((v): v is string => typeof v === 'string');
      }
      const kind: FieldKind = name.endsWith('_text') || !domain.length ? 'text' : 'categorical';
      const info: FieldInfo = {
        name,
        title: isObj(raw) && typeof raw.title === 'string' ? raw.title : name,
        description: isObj(raw) && typeof raw.description === 'string' ? raw.description : (row?.Description ?? ''),
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
  if (staged) dictionary = regroup(dictionary, categories, idField);

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
    ruleCount: ruleCount(root, dictionary.conditionalRules.length),
    dictionary,
  };
}
