/**
 * JSON Schema validation of abstraction records (gold and predictions): each
 * record is validated against the root (record) schema, and errors raised
 * inside an `if/then` cross-field rule carry that rule's number (`x-rule`) and
 * `$comment`.
 */

import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { AbstractionRecord, RecordId, SchemaModel } from './types';

export interface SchemaIssue {
  /** Variable the issue is about (empty for record-level issues). */
  field: string;
  message: string;
  /** The cross-field rule the error comes from ("Rule 8: …", from its `x-rule` and `$comment`). */
  rule?: string;
  keyword: string;
}

export interface Validator {
  validate(record: AbstractionRecord): SchemaIssue[];
}

type Obj = Record<string, unknown>;

function pointerParts(pointer: string): string[] {
  return pointer
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** "Rule 8: <$comment>" for an if/then node (either part may be absent). */
function ruleLabel(o: Obj): string | undefined {
  const n = typeof o['x-rule'] === 'number' || typeof o['x-rule'] === 'string' ? `Rule ${o['x-rule']}` : '';
  const comment = typeof o.$comment === 'string' ? o.$comment : '';
  return n && comment ? `${n}: ${comment}` : n || comment || undefined;
}

/** The label of the nearest enclosing if/then node along a schema path. */
function ruleOf(root: Obj, schemaPath: string): string | undefined {
  let node: unknown = root;
  let rule: string | undefined;
  for (const step of pointerParts(schemaPath)) {
    if (!node || typeof node !== 'object') return rule;
    node = (node as Obj)[step];
    if (node && typeof node === 'object' && !Array.isArray(node) && 'if' in node) rule = ruleLabel(node as Obj) ?? rule;
  }
  return rule;
}

const fieldOf = (e: ErrorObject): string => {
  const first = e.instancePath.split('/')[1];
  return first ? decodeURIComponent(first).replace(/~1/g, '/').replace(/~0/g, '~') : '';
};

function describe(e: ErrorObject, record: AbstractionRecord, field: string): string {
  const value = field ? record[field] : undefined;
  const shown = typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
  switch (e.keyword) {
    case 'required':
      return `Missing variable ${(e.params as { missingProperty: string }).missingProperty}`;
    case 'unevaluatedProperties':
    case 'additionalProperties': {
      const p = e.params as { unevaluatedProperty?: string; additionalProperty?: string };
      return `Unexpected variable ${p.unevaluatedProperty ?? p.additionalProperty}`;
    }
    case 'const':
      return `${field} is ${shown}; the rule requires '${String((e.params as { allowedValue: unknown }).allowedValue)}'`;
    case 'enum':
      return `${field} is ${shown}, which is not an allowed value`;
    case 'not':
      return `${field} must not be ${shown} here`;
    case 'type':
      return `${field} must be a ${(e.params as { type: string }).type}`;
    case 'pattern':
      return `${field} does not match the required text pattern`;
    case 'minLength':
      return `${field} must not be empty`;
    default:
      return field ? `${field}: ${e.message ?? 'is invalid'}` : (e.message ?? 'Invalid record');
  }
}

export function createValidator(schema: SchemaModel): Validator | { error: string } {
  let validateFn: ValidateFunction;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    for (const doc of schema.documents) {
      if (doc.schema !== schema.root && typeof doc.schema === 'object' && doc.schema && '$id' in doc.schema) {
        try {
          ajv.addSchema(doc.schema as object);
        } catch {
          /* a component that fails to register only matters if it is referenced */
        }
      }
    }
    validateFn = ajv.compile(schema.root);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const root = schema.root;

  return {
    validate(record: AbstractionRecord): SchemaIssue[] {
      if (validateFn(record)) return [];
      const errors = validateFn.errors ?? [];
      // oneOf-of-consts failures arrive as one const error per branch plus a oneOf
      // error; report a single "not an allowed value" for that variable instead.
      const oneOfFields = new Set(errors.filter((e) => e.keyword === 'oneOf').map((e) => e.instancePath));
      const issues: SchemaIssue[] = [];
      const seen = new Set<string>();
      for (const e of errors) {
        if (e.keyword === 'if') continue; // the `then` error below it says what failed
        const field = fieldOf(e);
        if (e.keyword === 'const' && oneOfFields.has(e.instancePath) && /\/oneOf\/\d+\/const$/.test(e.schemaPath)) continue;
        const message =
          e.keyword === 'oneOf'
            ? `${field} is ${JSON.stringify(record[field])}, which is not one of its allowed values`
            : describe(e, record, field);
        const rule = ruleOf(root, e.schemaPath);
        const key = `${message}|${rule ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({ field, message, rule, keyword: e.keyword });
      }
      return issues;
    },
  };
}

export function validateAll(validator: Validator, records: Map<RecordId, AbstractionRecord>): Map<RecordId, SchemaIssue[]> {
  const out = new Map<RecordId, SchemaIssue[]>();
  for (const [rid, rec] of records) {
    const issues = validator.validate(rec);
    if (issues.length) out.set(rid, issues);
  }
  return out;
}
