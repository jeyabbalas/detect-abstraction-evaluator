/**
 * Consistency and validity: run-to-run stability on identical report texts,
 * and whether predictions satisfy the JSON Schema, each variable's domain and
 * the record list each pipeline was asked to abstract.
 */

import { duplicateConsistencyFor, type Analysis, type MetricSource, type PipelineAnalysis } from '../../core/analysis';
import type { RecordId } from '../../core/types';
import type { SchemaIssue } from '../../core/validate';
import { badge, callout, infoTip, pipelineLabel } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtInt, fmtMetric, plural } from '../../ui/format';
import { icon } from '../../ui/icons';

const ISSUE_CAP = 8;

function card(title: Child, subtitle: Child, body: Child): HTMLElement {
  return h(
    'section',
    { class: 'card fx-qcard' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-titles' }, h('div', { class: 'card-title' }, title), h('div', { class: 'card-subtitle' }, subtitle))),
    h('div', { class: 'card-body' }, body),
  );
}

// ------------------------------------------------------------ consistency

export function consistencyCard(analysis: Analysis, source: MetricSource, onField: (name: string) => void): HTMLElement {
  const groups = analysis.experiment.duplicateGroups.filter((g) => g.length > 1);
  const records = groups.reduce((sum, g) => sum + g.length, 0);
  const title = [
    'Duplicate consistency',
    infoTip(
      'Some reports have exactly the same text. A stable pipeline gives every copy the same prediction, so the share of categorical cells on which all copies agree measures run-to-run stability (it is not compared with the gold standard).',
    ),
  ];
  if (!groups.length) {
    return card(title, 'Identical report texts should get identical predictions.', h('p', { class: 'fx-d-note' }, 'No report text appears more than once, so run-to-run stability cannot be measured here.'));
  }
  const subtitle = `Identical report texts should get identical predictions — a measure of run-to-run stability over ${plural(groups.length, 'group')} of identical texts (${plural(records, 'record')}).`;
  const rows = analysis.pipelines.map((pa, i) => {
    const dc = duplicateConsistencyFor(analysis, i, source);
    const unstable = Object.entries(dc?.unstable_fields ?? {});
    return h(
      'div',
      { class: 'fx-qrow' },
      h(
        'div',
        { class: 'fx-qrow-head' },
        pipelineLabel(pa.pipeline),
        h(
          'span',
          { class: 'fx-qrow-value' },
          dc && dc.agreement !== null
            ? [h('strong', { class: 'num' }, fmtMetric(dc.agreement)), h('span', { class: 'muted' }, ` agreement over ${plural(dc.cells, 'cell')}`)]
            : h('span', { class: 'muted' }, 'Not measured (copies without predictions)'),
        ),
      ),
      unstable.length
        ? h(
            'div',
            { class: 'fx-chips', role: 'group', 'aria-label': `Unstable variables of ${pa.pipeline.name}` },
            h('span', { class: 'fx-chips-label' }, 'Unstable:'),
            unstable.map(([name, n]) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'chip fx-unstable',
                  title: `Copies of ${n === 1 ? 'one identical-text group' : `${n} identical-text groups`} got different ${name} predictions — open the variable`,
                  onclick: () => onField(name),
                },
                h('span', { class: 'fx-mono' }, name),
                h('span', { class: 'fx-chip-count' }, fmtInt(n)),
              ),
            ),
          )
        : dc && dc.agreement !== null
          ? h('p', { class: 'fx-d-note' }, icon('checkCircle', { size: 14 }), ' Every copy got the same predictions.')
          : null,
    );
  });
  return card(title, subtitle, h('div', { class: 'fx-qrows' }, rows));
}

// --------------------------------------------------------------- validity

interface Issue {
  rid: RecordId;
  field: string;
  message: string;
  rule?: string;
}

function issuesOf(pa: PipelineAnalysis): Issue[] {
  const issues: Issue[] = [];
  const covered = new Set<string>();
  const schemaIssues = [...(pa.schemaIssues ?? new Map<RecordId, SchemaIssue[]>())].sort((a, b) => a[0] - b[0]);
  for (const [rid, list] of schemaIssues) {
    for (const issue of list) {
      issues.push({ rid, field: issue.field, message: issue.message, rule: issue.rule });
      covered.add(`${rid}|${issue.field}`);
    }
  }
  for (const inv of pa.invalid) {
    if (!covered.has(`${inv.rid}|${inv.field}`)) issues.push({ rid: inv.rid, field: inv.field, message: `${inv.field} is '${inv.value}', which is not an allowed value` });
  }
  for (const rid of pa.missing) issues.push({ rid, field: '', message: 'No prediction for this record' });
  return issues;
}

export function validityCard(analysis: Analysis, onRecord: (rid: RecordId, field?: string) => void): HTMLElement {
  const { schema } = analysis.experiment;
  const rules = schema.dictionary.conditionalRules.length;
  const subtitle = `Predictions checked against the JSON Schema${rules ? ` and its ${plural(rules, 'cross-field rule')}` : ''}, each variable's allowed values, and the records each pipeline was asked to abstract.`;
  const per = analysis.pipelines.map((pa) => ({
    pa,
    schema: pa.schemaIssues?.size ?? 0,
    invalid: pa.invalid.length,
    missing: pa.missing.length,
  }));
  const clean = per.every((p) => !p.schema && !p.invalid && !p.missing);
  const blocks: Child[] = [];

  if (analysis.validatorError) {
    blocks.push(callout('warning', `JSON Schema validation is unavailable: ${analysis.validatorError}. Value domains and missing predictions are still checked.`));
  }
  if (clean) {
    blocks.push(
      callout(
        'good',
        analysis.validatorError
          ? 'Every value is within its variable’s domain and no prediction is missing.'
          : `All predictions satisfy the JSON Schema${rules ? `, including its ${plural(rules, 'cross-field rule')}` : ''}. Every value is within its variable’s domain and no prediction is missing.`,
      ),
    );
  } else {
    blocks.push(
      h(
        'div',
        { class: 'fx-qrows' },
        per.map(({ pa, schema: nSchema, invalid, missing }) => {
          const issues = issuesOf(pa);
          const tags = [
            nSchema ? badge(`${plural(nSchema, 'record')} fail the schema`, 'warning', 'alert') : null,
            invalid ? badge(`${plural(invalid, 'value')} out of domain`, 'warning', 'alert') : null,
            missing ? badge(`${fmtInt(missing)} missing`, 'warning', 'alert') : null,
          ].filter(Boolean);
          return h(
            'div',
            { class: 'fx-qrow' },
            h('div', { class: 'fx-qrow-head' }, pipelineLabel(pa.pipeline), h('span', { class: 'fx-d-badges' }, tags.length ? tags : badge('No issues', 'good', 'check'))),
            issues.length
              ? h(
                  'ul',
                  { class: 'fx-issues' },
                  issues.slice(0, ISSUE_CAP).map((is) =>
                    h(
                      'li',
                      null,
                      h('button', { type: 'button', class: 'chip fx-rec', title: `Open record ${is.rid}`, onclick: () => onRecord(is.rid, is.field || undefined) }, `#${is.rid}`),
                      h('span', { class: 'fx-issue-text' }, is.message, is.rule ? h('span', { class: 'fx-issue-rule' }, is.rule) : null),
                    ),
                  ),
                  issues.length > ISSUE_CAP ? h('li', { class: 'fx-more' }, `+ ${fmtInt(issues.length - ISSUE_CAP)} more`) : null,
                )
              : null,
          );
        }),
      ),
    );
  }

  const goldBad = analysis.goldSchemaIssues?.size ?? 0;
  if (goldBad) {
    const rids = [...analysis.goldSchemaIssues!.keys()].sort((a, b) => a - b);
    blocks.push(
      callout('warning', [
        `The gold standard itself has ${plural(goldBad, 'record')} that fail the JSON Schema: `,
        h(
          'span',
          { class: 'fx-chips fx-inline-chips' },
          rids.slice(0, ISSUE_CAP).map((rid) => h('button', { type: 'button', class: 'chip fx-rec', title: `Open record ${rid}`, onclick: () => onRecord(rid) }, `#${rid}`)),
          rids.length > ISSUE_CAP ? h('span', { class: 'fx-more' }, `+ ${fmtInt(rids.length - ISSUE_CAP)} more`) : null,
        ),
      ]),
    );
  }
  return card('Validity', subtitle, blocks);
}
