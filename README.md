# Abstraction Evaluator

A browser app for comparing automated abstraction pipelines — open-weight LLMs self-hosted on your own hardware — that
extract structured variables from pathology report summaries, against a gold-standard abstraction.

**Live app:** https://jeyabbalas.github.io/detect-abstraction-evaluator/

Everything runs in your browser. Reports, gold labels and predictions are read from your disk and never uploaded;
closing the tab forgets them.

## Using it

Open the app and choose an experiment folder (or a `.zip` of it, or drag and drop it onto the page). The abstraction
code writes everything but the gold standard, which you add:

```
experiment/
├── data_dictionary/     JSON Schema of one abstraction record (*.json), with x-abstraction (prompts and stages)
├── gold_standard/       one or more gold standards, each a JSON array of records (primary key: record_id)
├── pathology_reports/   <record_id>.txt — one report per record
└── abstractions/
    └── <pipeline>/      one folder per pipeline run
        ├── config.json      strategy, model, client settings, schema_sha256
        ├── summary.json     records, calls, tokens, model time, finish reasons, stage runs, per-record notes
        ├── predictions.json the abstracted records
        └── records/         optional per-record outputs with the model trace (<record_id>.json)
```

The pipelines never see the gold standard: every metric is computed in the browser. Switch gold standards from the
header (every `gold_standard/*.json`, or **Load a gold-standard file…** from disk) and everything is re-scored in
place; a folder without a gold standard asks for one. Each pipeline is scored on its records that are in the gold
standard in use.

### Views

- **Overview** — the pipeline comparison: a leaderboard, headline metrics with 95% bootstrap confidence intervals,
  the error profile (missed vs. over-called), cost (tokens, calls, model time) vs. accuracy, paired differences between
  pipelines, a diff of the run configurations (`config.json` and `summary.json`) and what each run log reports.
- **Fields** — where the errors are: performance by category (the progressive pipeline's stages) and by variable, each
  variable's confusions and the records involved, free-text diagnostics, duplicate-text consistency and JSON Schema
  validity.
- **Records** — one record at a time: the pathology report next to the gold-standard and abstracted values, with the
  free-text (`*_text`) values highlighted in the report, disagreements flagged, the pipeline's own notes on the record
  (unresolved problems, fallbacks, gate changes, fixes) and its model trace (`records/<record_id>.json`).
- **Data** — the gold standard, each pipeline's predictions and a long-format cell comparison as interactive tables
  ([`@jeyabbalas/data-table`](https://www.npmjs.com/package/@jeyabbalas/data-table)): column charts with crossfilter,
  filters, sorting and export; cells that disagree with the gold standard, and the pipelines' notes, are flagged.
- **Dictionary** — the data dictionary rendered from the JSON Schema
  ([`json-schema-data-dictionary`](https://www.npmjs.com/package/json-schema-data-dictionary)), grouped by stage.

Every chart has a table view and exports to SVG, PNG (2×) and CSV; exports are re-rendered in light mode for print.

Views are linkable once an experiment is loaded, e.g. `#/fields?field=Uterine_cancer_primary` opens a variable's
details and `#/records/17?field=Specific_procedure_text&pipeline=<pipeline folder>` opens record 17 with that variable
and pipeline in focus. In the record viewer, `←`/`→` (or `j`/`k`) step through records.

## Metrics

Every metric is computed in the browser from each pipeline's `predictions.json` and the gold standard in use.

- **Scope.** Categorical variables only; free-text variables (names ending in `_text`) are excluded from the headline
  metrics and reported as diagnostics (presence agreement, exact match).
- **Informative F1 (headline).** Micro F1 over informative cells: a TP is a correct prediction whose gold value is not
  the variable's default label (`Cannot determine` > `Not identified` > `No`); an FP is a wrong prediction that is not
  the default label; an FN is a wrong prediction whose gold value is not the default label. A wrong informative label
  counts as both.
- **Mean field macro-F1**, **cell accuracy**, **error-free records** and **duplicate-text agreement** complement it.
- **Populations.** *Unique reports* scores each distinct report text once (the lowest `record_id` of identical texts);
  *All records* counts duplicated texts once per copy.
- **Uncertainty.** 95% percentile bootstrap intervals resample records (not cells, which are correlated within a
  report), B = 2,000 with a fixed seed. Differences between pipelines use a paired bootstrap (the same resampled records
  for both).
- **Comparison.** Pipelines are compared on the gold-standard records every one of them was run on; a record a run
  covered without a prediction (a failure in `summary.json`) is scored as wrong.
- **Validity.** Predictions and the gold standard are validated against the JSON Schema, including its numbered
  cross-field (`if`/`then`, `x-rule`) rules. Each run's `schema_sha256` is checked against the data dictionary loaded.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (+ checks on examples/new_experiment_1 when it exists)
npm run build      # type-check and build to dist/
```

Put an experiment folder at `examples/new_experiment_1/` (git-ignored — it may hold sensitive data) to get a *Load
examples/new_experiment_1* button on the dev server and to run the tests that use it.

Stack: TypeScript, Vite, [Observable Plot](https://observablehq.com/plot/), Ajv (JSON Schema 2020-12), fflate (zip).
Pushes to `main` are tested, built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.
