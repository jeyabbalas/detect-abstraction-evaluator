/**
 * Shared data model for an uploaded experiment directory.
 *
 * The abstraction code writes everything except the gold standard, which the
 * user supplies (and may swap for another to re-score):
 *
 *   <experiment>/
 *     data_dictionary/*.json        JSON Schema of one abstraction record (with x-abstraction)
 *     gold_standard/*.json          gold-standard records, one JSON array per file
 *     pathology_reports/<id>.txt    one report per record_id
 *     abstractions/<pipeline>/      config.json, summary.json, predictions.json, records/<id>.json
 */

import type { DataDictionaryTable, JsonSchema } from 'json-schema-data-dictionary';

export type RecordId = number;
/** One abstraction record: `record_id` plus one string value per variable. */
export type AbstractionRecord = Record<string, unknown>;

/** A file inside the uploaded directory, with its path relative to the experiment root. */
export interface VirtualFile {
  /** '/'-separated path relative to the experiment root, e.g. `abstractions/run_a/config.json`. */
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
  /** Category key (the progressive pipeline's stage, e.g. `specimens`). */
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
  /** Stage name from `x-abstraction.progressive.stages`, e.g. `specimens`. */
  key: string;
  /** Display title, e.g. "Specimens". */
  title: string;
  /** What the stage codes (its `$comment`). */
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
  /** The root schema: one abstraction record. */
  root: Record<string, unknown>;
  idField: string;
  /** Every variable except the id, in schema order. */
  fields: FieldInfo[];
  byName: Map<string, FieldInfo>;
  categories: CategoryInfo[];
  categoryByKey: Map<string, CategoryInfo>;
  categoricalFields: string[];
  textFields: string[];
  /** Cross-field rules: distinct `x-rule` numbers of the root's if/then blocks (else one per block). */
  ruleCount: number;
  /** Flattened data dictionary (json-schema-data-dictionary). */
  dictionary: DataDictionaryTable;
}

// ---------------------------------------------------------------------------
// Scores (computed by evaluate.ts)
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

/** `config.json`: how a pipeline was run. */
export interface PipelineConfig {
  /** Strategy, e.g. `baseline` or `progressive`. */
  pipeline?: string;
  model?: string;
  /** SHA-256 of the data dictionary file the run used. */
  schema_sha256?: string;
  max_repairs?: number;
  client_settings?: Record<string, unknown>;
  package_version?: string;
  created?: string;
  [key: string]: unknown;
}

/** One record's entry in `summary.json` `issues`: what the pipeline itself reported. */
export interface RecordNotes {
  /** Problems still open after the repair rounds, by stage. */
  unresolved?: Record<string, string[]>;
  /** Values the model did not give, filled with the field's least informative label. */
  fallbacks?: string[];
  /** Negative labels changed to 'Cannot determine' because no gating compartment was examined. */
  gate_changes?: string[];
  /** Skip patterns (x-fix rules) applied to the finished record. */
  fixes?: string[];
  schema_errors?: string[];
  [key: string]: unknown;
}

/** `summary.json`: totals over a pipeline run. */
export interface PipelineSummary {
  config?: PipelineConfig;
  /** Records the run abstracted. */
  records?: number;
  failures?: unknown[];
  unreadable_records?: unknown[];
  /** Records with at least one note of each kind. */
  records_with?: Record<string, number>;
  /** Replies per finish reason (`length` = cut off at the token limit). */
  finish_reasons?: Record<string, number>;
  /** Records each stage ran on. */
  stage_runs?: Record<string, number>;
  calls?: number;
  repair_rounds?: number;
  prompt_tokens?: number;
  /** Completion tokens, reasoning included. */
  completion_tokens?: number;
  /** Summed model-call time. */
  model_seconds?: number;
  issues?: Record<string, RecordNotes>;
  [key: string]: unknown;
}

/** A record the pipeline could not abstract (summary.json `failures` / `unreadable_records`). */
export interface RunFailure {
  rid: RecordId;
  message: string;
}

export interface Pipeline {
  /** Folder name under abstractions/ — the stable identity. */
  id: string;
  /** Display name (the folder name). */
  name: string;
  /** 0-based color slot, fixed by sorted folder order. */
  index: number;
  /** config.json (else summary.json `config`). */
  config: PipelineConfig | null;
  summary: PipelineSummary | null;
  predictions: Map<RecordId, AbstractionRecord>;
  /** Per-record outputs with the model trace (`records/<record_id>.json`), parsed lazily. */
  recordFiles: Map<RecordId, Blob>;
  /** The pipeline's own notes per record (summary.json `issues`). */
  notes: Map<RecordId, RecordNotes>;
  failures: RunFailure[];
  /** Every record the run covered: predictions, record files and failures. */
  attempted: RecordId[];
  /** The attempted records that are in the gold standard (the ones scored), sorted. */
  ids: RecordId[];
}

/** A gold-standard file the experiment can be scored against. */
export interface GoldFile {
  /** File name (relative to gold_standard/, or as picked from disk). */
  name: string;
  blob: Blob;
}

export interface Experiment {
  /** Name of the uploaded root folder (or zip). */
  name: string;
  schema: SchemaModel;
  /** SHA-256 (hex) of the root data-dictionary file, as config.json `schema_sha256` records it. */
  schemaSha256: string | null;
  /** Gold standards to choose from; `goldFileName` is the one in use. */
  goldFiles: GoldFile[];
  goldFileName: string;
  gold: Map<RecordId, AbstractionRecord>;
  /** Gold record ids, sorted ascending. */
  goldIds: RecordId[];
  reports: Map<RecordId, string>;
  /** Groups of record_ids with identical report text, lowest id first (singletons included). */
  duplicateGroups: RecordId[][];
  /** record_id → its identical-text group. */
  groupOf: Map<RecordId, RecordId[]>;
  /** Lowest record_id of each identical-text group, sorted. */
  uniqueIds: RecordId[];
  pipelines: Pipeline[];
  /** Every load issue: `baseIssues` plus those of the gold standard in use. */
  issues: LoadIssue[];
  /** Issues that do not depend on the gold standard. */
  baseIssues: LoadIssue[];
}
