# Abstraction Evaluator

A browser app for comparing automated abstraction pipelines — open-source LLMs that run on consumer hardware — that
extract structured variables from pathology report summaries, against a gold-standard abstraction.

**Live app:** https://jeyabbalas.github.io/detect-abstraction-evaluator/

Everything runs in your browser. Reports, gold labels and predictions are read from your disk and never uploaded;
closing the tab forgets them.

## Using it

Open the app and choose an experiment folder (or a `.zip` of it, or drag and drop it onto the page). The folder is the
one written by the abstraction code:

```
experiment/
├── data_dictionary/     JSON Schema of the abstraction (*.json; an array of records)
├── gold_standard/       the gold-standard records, one JSON array (primary key: record_id)
├── pathology_reports/   <record_id>.txt — one report per record
└── abstractions/
    └── <pipeline>/      one folder per evaluated pipeline
        ├── run.json         strategy, model settings, record ids, failures, token usage, timing
        ├── predictions.json the abstracted records
        ├── scores.json      the evaluation metrics (scores.txt: the same, as text)
        └── traces/          optional per-record model traces (<record_id>.json)
```

### Views

- **Overview** — the pipeline comparison: a leaderboard, headline metrics with 95% bootstrap confidence intervals,
  the error profile (missed vs. over-called), cost vs. accuracy, paired differences between pipelines, and a diff of
  the run configurations.
- **Fields** — where the errors are: performance by category and by variable, each variable's confusions and the
  records involved, free-text diagnostics, duplicate-text consistency and JSON Schema validity.
- **Records** — one record at a time: the pathology report next to the gold-standard and abstracted values, with the
  free-text (`*_text`) values highlighted in the report, disagreements flagged, and the model trace when available.
- **Data** — the gold standard, each pipeline's predictions and a long-format cell comparison as interactive tables
  ([`@jeyabbalas/data-table`](https://www.npmjs.com/package/@jeyabbalas/data-table)): column charts with crossfilter,
  filters, sorting and export; cells that disagree with the gold standard are flagged.
- **Dictionary** — the data dictionary rendered from the JSON Schema
  ([`json-schema-data-dictionary`](https://www.npmjs.com/package/json-schema-data-dictionary)).

Every chart has a table view and exports to SVG, PNG (2×) and CSV; exports are re-rendered in light mode for print.

Views are linkable once an experiment is loaded, e.g. `#/fields?field=Uterine_cancer_primary` opens a variable's
details and `#/records/17?field=Specific_procedure_text&pipeline=<pipeline folder>` opens record 17 with that variable
and pipeline in focus. In the record viewer, `←`/`→` (or `j`/`k`) step through records.

## Metrics

The app recomputes every metric in the browser with a faithful port of the abstraction code's `evaluate.py` and checks
the result against each pipeline's `scores.json` (the header shows *Verified against scores.json* when they agree).

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
- **Validity.** Predictions are validated against the JSON Schema, including its cross-field (`if`/`then`) rules.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (+ parity with scores.json when examples/experiment_1 exists)
npm run build      # type-check and build to dist/
```

Put an experiment folder at `examples/experiment_1/` (git-ignored — it may hold sensitive data) to get a *Load local
example* button on the dev server and to run the `scores.json` parity test.

Stack: TypeScript, Vite, [Observable Plot](https://observablehq.com/plot/), Ajv (JSON Schema 2020-12), fflate (zip).
Pushes to `main` are tested, built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.
