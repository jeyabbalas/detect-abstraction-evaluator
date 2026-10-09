/**
 * Shared data model for an uploaded experiment directory.
 *
 * The directory layout mirrors what the abstraction code writes:
 *
 *   <experiment>/
 *     data_dictionary/*.json        JSON Schema of the abstraction (array of records)
 *     gold_standard/*.json          one JSON array of gold records
 *     pathology_reports/<id>.txt    one report per record_id
 *     abstractions/<pipeline>/      run.json, predictions.json, scores.json, traces/<id>.json
 */

import type { DataDictionaryTable, JsonSchema } from 'json-schema-data-dictionary';

export type RecordId = number;
/** One abstraction record: `record_id` plus one string value per variable. */
export type AbstractionRecord = Record<string, unknown>;

/** A file inside the uploaded directory, with its path relative to the experiment root. */
export interface VirtualFile {
  /** '/'-separated path relative to the experiment root, e.g. `abstractions/run_a/run.json`. */
  path: string;
  blob: Blob;
}

export type IssueLevel = 'error' | 'warning' | 'info';

export interface LoadIssue {
  level: IssueLevel;
  message: string;
  /** Optional pipeline the issue belongs to. */
  pipeline?: string;
}

// ---------------------------------------------------------------------------
// Schema model
// ---------------------------------------------------------------------------

export type FieldKind = 'id' | 'categorical' | 'text';

export interface FieldInfo {
  name: string;
  /** Short human title from the schema (`title`), or the name. */
  title: string;
  /** Long description (assignment rules) from the schema. */
  description: string;
  kind: FieldKind;
  /** Category key (the `$defs` key, e.g. `procedures`). */
  category: string;
  /** Allowed values for categorical fields (in schema order). Empty for text fields. */
  domain: string[];
  /**
   * The label that records missing/negative information: 'Cannot determine' >
   * 'Not identified' > 'No' (first present in the domain); 'Not identified' for text.
   */
  defaultLabel: string | null;
  /** Position in schema order (0-based, record_id excluded). */
  order: number;
}

export interface CategoryInfo {
  /** `$defs` key, as used by scores.json `per_category`. */
  key: string;
  /** Title after the em dash, e.g. "Procedures and evaluated sites". */
  title: string;
  description: string;
  /** All fields (categorical and text) in schema order. */
  fields: string[];
  categorical: string[];
  text: string[];
}

export interface SchemaDocument {
  uri: string;
  name: string;
  schema: JsonSchema;
}

export interface SchemaModel {
  title: string;
  description: string;
  /** The name of the root schema file. */
  rootName: string;
  documents: SchemaDocument[];
  /** The root (array-of-records) schema. */
  root: Record<string, unknown>;
  idField: string;
  /** Every variable except the id, in schema order. */
  fields: FieldInfo[];
  byName: Map<string, FieldInfo>;
  categories: CategoryInfo[];
  categoryByKey: Map<string, CategoryInfo>;
  categoricalFields: string[];
  textFields: string[];
  /** Flattened data dictionary (json-schema-data-dictionary). */
  dictionary: DataDictionaryTable;
}

// ---------------------------------------------------------------------------
// Scores (the structure of scores.json, which evaluate.ts reproduces)
// ---------------------------------------------------------------------------

export interface ScoreSummary {
  informative_precision: number | null;
  informative_recall: number | null;
  informative_f1: number | null;
  tp: number;
  fp: number;
  fn: number;
  mean_field_macro_f1: number;
  cell_accuracy: number;
  cells: number;
  errors: number;
}

export interface LabelScore {
  support: number;
  f1: number;
}

export interface FieldScore {
  n: number;
  accuracy: number;
  macro_f1: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  per_label: Record<string, LabelScore>;
  /** `"<gold> -> <pred>"` → count, for every disagreement. */
  confusion: Record<string, number>;
}

export interface TextScore {
  presence_agreement: number;
  exact_match: number;
}

export interface PopulationScores {
  records: number;
  summary: ScoreSummary;
  per_category: Record<string, ScoreSummary>;
  per_field: Record<string, FieldScore>;
  text: Record<string, TextScore>;
}

export interface DuplicateConsistency {
  agreement: number | null;
  cells: number;
  unstable_fields: Record<string, number>;
}

export type PopulationName = 'unique' | 'all';

export interface Scores {
  unique?: PopulationScores;
  all?: PopulationScores;
  duplicate_consistency?: DuplicateConsistency;
}

// ---------------------------------------------------------------------------
// Pipelines and the experiment
// ---------------------------------------------------------------------------

export interface RunUsage {
  calls?: number;
  cached_calls?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  seconds?: number;
  retries?: number;
  failures?: number;
  finish_reasons?: Record<string, number>;
  [key: string]: unknown;
}

export interface RunMeta {
  strategy?: string;
  settings?: Record<string, unknown>;
  ids?: number[];
  failures?: Record<string, string>;
  wall_seconds?: number;
  usage?: RunUsage;
  [key: string]: unknown;
}

export interface Pipeline {
  /** Folder name under abstractions/ — the stable identity. */
  id: string;
  /** Display name (the folder name). */
  name: string;
  /** 0-based color slot, fixed by sorted folder order. */
  index: number;
  run: RunMeta | null;
  predictions: Map<RecordId, AbstractionRecord>;
  /** Reported scores (scores.json), if present. */
  reportedScores: Scores | null;
  /** scores.txt, if present. */
  scoresText: string | null;
  /** Lazily parsed per-record traces. */
  traceFiles: Map<RecordId, Blob>;
  /** The records this run was asked to abstract (run.json `ids`), else the gold ids. */
  ids: RecordId[];
}

export interface Experiment {
  /** Name of the uploaded root folder (or zip). */
  name: string;
  schema: SchemaModel;
  gold: Map<RecordId, AbstractionRecord>;
  /** Gold record ids, sorted ascending. */
  goldIds: RecordId[];
  goldFileName: string;
  reports: Map<RecordId, string>;
  /** Groups of record_ids with identical report text, lowest id first (singletons included). */
  duplicateGroups: RecordId[][];
  /** record_id → its identical-text group. */
  groupOf: Map<RecordId, RecordId[]>;
  /** Lowest record_id of each identical-text group, sorted. */
  uniqueIds: RecordId[];
  pipelines: Pipeline[];
  issues: LoadIssue[];
}
