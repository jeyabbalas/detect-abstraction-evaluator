/**
 * A pipeline's record file (`records/<record_id>.json`: the finished record and
 * the model trace): loaded lazily, cached, and rendered for reading — the
 * trace's known keys as chips, lists and small tables; the stages as collapsed
 * accordions with every reply and its reasoning; anything unknown as JSON.
 */

import { readRecordFile } from '../../core/load';
import type { Pipeline, RecordId } from '../../core/types';
import { badge } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtDuration, fmtInt, humanize, plural } from '../../ui/format';
import { icon } from '../../ui/icons';

export type RecordFile = Record<string, unknown>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Small LRU cache of parsed record files (they can be large). */
export class TraceCache {
  private readonly cache = new Map<string, Promise<RecordFile | null>>();

  constructor(private readonly size = 24) {}

  get(p: Pipeline, rid: RecordId): Promise<RecordFile | null> {
    const key = `${p.index}:${rid}`;
    let hit = this.cache.get(key);
    if (hit) this.cache.delete(key);
    else hit = readRecordFile(p, rid);
    this.cache.set(key, hit);
    while (this.cache.size > this.size) this.cache.delete(this.cache.keys().next().value!);
    return hit;
  }
}

/** Trace keys shown above the stages, in this order. */
const KNOWN: readonly string[] = ['skipped', 'examined_compartments', 'neoplastic_findings', 'fallbacks', 'gate_changes', 'fixes', 'schema_errors'];
const LABEL: Record<string, string> = {
  skipped: 'Skipped stages',
  examined_compartments: 'Examined compartments',
  neoplastic_findings: 'Neoplastic findings',
  fallbacks: 'Fallbacks',
  gate_changes: 'Gate changes',
  fixes: 'Fixes',
  schema_errors: 'Schema errors',
};
const HELP: Record<string, string> = {
  skipped: 'Stages that did not run on this record; their fields got their least informative label without the model.',
  fallbacks: 'Values the model did not give, filled with the field’s least informative label.',
  gate_changes: 'Negative labels changed to “Cannot determine” because none of the field’s compartments was examined.',
  fixes: 'Skip patterns (the schema’s x-fix rules) applied to the finished record.',
  schema_errors: 'Schema violations left in the finished record.',
};
/** File keys rendered elsewhere: the record is the variables table. */
const FILE_KEYS = new Set(['record_id', 'record', 'trace', 'seconds']);
const NORMAL_FINISH = new Set(['stop', 'end_turn', 'stop_sequence', 'eos']);

const sentence = (key: string) => {
  const s = humanize(key);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const muted = (text: string) => h('span', { class: 'muted' }, text);
const jsonPre = (v: unknown) => h('pre', { class: 'rec-pre' }, JSON.stringify(v, null, 2));
const cellText = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** Generic rendering for trace values of unknown shape. */
function valueView(v: unknown, depth = 0): Child {
  if (v === null || v === undefined) return muted('—');
  if (typeof v === 'string') return v.length > 140 || v.includes('\n') ? h('pre', { class: 'rec-pre' }, v) : v;
  if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    if (!v.length) return muted('None');
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      const short = v.every((x) => String(x).length <= 40);
      return short
        ? h('div', { class: 'rec-chips-list' }, v.map((x) => h('span', { class: 'chip' }, String(x))))
        : h('ul', { class: 'rec-trace-list' }, v.map((x) => h('li', null, String(x))));
    }
    if (v.every((x) => isObj(x) && Object.values(x).every(isScalar))) {
      const keys = [...new Set(v.flatMap((x) => Object.keys(x as Obj)))];
      return h(
        'div',
        { class: 'rec-trace-table' },
        h(
          'table',
          { class: 'tbl' },
          h('thead', null, h('tr', null, keys.map((k) => h('th', { scope: 'col' }, humanize(k))))),
          h('tbody', null, v.map((x) => h('tr', null, keys.map((k) => h('td', null, cellText((x as Obj)[k])))))),
        ),
      );
    }
    return jsonPre(v);
  }
  if (isObj(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return muted('None');
    if (entries.every(([, x]) => isScalar(x))) {
      return h(
        'div',
        { class: 'rec-chips-list' },
        entries.map(([k, x]) => h('span', { class: ['chip', 'rec-kv', x === 'No' || x === false ? 'off' : null] }, k, h('b', null, cellText(x)))),
      );
    }
    if (depth < 2) return h('dl', { class: 'rec-trace-dl' }, entries.map(([k, x]) => [h('dt', null, sentence(k)), h('dd', null, valueView(x, depth + 1))]));
    return jsonPre(v);
  }
  return jsonPre(v);
}

interface Usage {
  calls: number;
  prompt: number;
  completion: number;
  seconds: number;
  /** Replies that did not finish normally (e.g. cut off at the token limit). */
  unfinished: number;
}

const finishOf = (r: Obj): string | null => (typeof r.finish_reason === 'string' ? r.finish_reason : null);
const abnormal = (finish: string | null) => finish !== null && !NORMAL_FINISH.has(finish.toLowerCase());

function usageOf(replies: Obj[]): Usage {
  const u: Usage = { calls: replies.length, prompt: 0, completion: 0, seconds: 0, unfinished: 0 };
  for (const r of replies) {
    u.prompt += num(r.prompt_tokens) ?? 0;
    u.completion += num(r.completion_tokens) ?? 0;
    u.seconds += num(r.seconds) ?? 0;
    if (abnormal(finishOf(r))) u.unfinished += 1;
  }
  return u;
}

function usageText(u: Usage): string[] {
  return [
    u.prompt ? `${fmtInt(u.prompt)} prompt` : '',
    u.completion ? `${fmtInt(u.completion)} completion tokens` : '',
    u.seconds ? fmtDuration(u.seconds) : '',
  ].filter(Boolean);
}

const repliesOf = (stage: Obj): Obj[] => (Array.isArray(stage.replies) ? stage.replies.filter(isObj) : []);

function replyView(r: Obj, i: number, n: number): HTMLElement {
  const finish = finishOf(r);
  const tries = num(r.tries);
  const meta = [
    n > 1 ? `Reply ${i + 1} of ${n}` : 'Reply',
    num(r.prompt_tokens) !== null ? `${fmtInt(num(r.prompt_tokens))} prompt` : '',
    num(r.completion_tokens) !== null ? `${fmtInt(num(r.completion_tokens))} completion tokens` : '',
    num(r.seconds) !== null ? fmtDuration(num(r.seconds)) : '',
    tries !== null && tries > 1 ? `${fmtInt(tries)} tries` : '',
  ].filter(Boolean);
  const known = new Set(['text', 'reasoning', 'prompt_tokens', 'completion_tokens', 'seconds', 'finish_reason', 'tries']);
  const other = Object.fromEntries(Object.entries(r).filter(([k]) => !known.has(k)));
  const reasoning = typeof r.reasoning === 'string' && r.reasoning ? r.reasoning : null;
  return h(
    'div',
    { class: 'rec-reply' },
    h(
      'div',
      { class: 'rec-reply-meta' },
      meta.join(' · '),
      abnormal(finish) ? badge(finish === 'length' ? 'cut off at the token limit' : `finish: ${finish}`, 'warning') : null,
    ),
    typeof r.text === 'string' ? h('pre', { class: 'rec-pre' }, r.text.trim()) : null,
    reasoning
      ? h(
          'details',
          { class: 'disclosure rec-reasoning' },
          h('summary', null, icon('chevronRight'), 'Reasoning', h('span', { class: 'muted' }, ` · ${plural(reasoning.length, 'character')}`)),
          h('pre', { class: 'rec-pre' }, reasoning),
        )
      : null,
    Object.keys(other).length ? jsonPre(other) : null,
  );
}

function stageView(name: string, stage: unknown): HTMLElement {
  const summary = (meta: Child) => h('summary', null, icon('chevronRight'), h('span', { class: 'rec-stage-name' }, name), meta);
  if (!isObj(stage)) return h('details', { class: 'disclosure rec-stage' }, summary(null), h('div', { class: 'rec-stage-body' }, jsonPre(stage)));
  const replies = repliesOf(stage);
  const usage = usageOf(replies);
  const round = num(stage.round);
  const calls = num(stage.calls) ?? replies.length;
  const problems = Array.isArray(stage.problems) ? stage.problems : null;
  const outputs = isObj(stage.outputs) ? Object.entries(stage.outputs) : [];
  const meta = [round !== null ? `Round ${round}` : '', calls ? plural(calls, 'call') : '', ...usageText(usage)].filter(Boolean);
  const known = new Set(['round', 'calls', 'problems', 'outputs', 'replies']);
  const other = Object.fromEntries(Object.entries(stage).filter(([k]) => !known.has(k)));
  return h(
    'details',
    { class: 'disclosure rec-stage' },
    summary([
      h('span', { class: 'rec-stage-meta' }, meta.join(' · ')),
      problems?.length ? badge(plural(problems.length, 'unresolved problem'), 'warning') : null,
      usage.unfinished ? badge(plural(usage.unfinished, 'reply', 'replies') + ' cut off', 'warning') : null,
    ]),
    h(
      'div',
      { class: 'rec-stage-body' },
      problems?.length
        ? h('div', { class: 'rec-stage-part' }, h('div', { class: 'rec-trace-key' }, 'Problems left after the repair rounds'), valueView(problems))
        : null,
      outputs.map(([k, v]) => h('div', { class: 'rec-stage-part' }, h('div', { class: 'rec-trace-key' }, sentence(k)), valueView(v))),
      replies.map((r, i) => replyView(r, i, replies.length)),
      Object.keys(other).length ? h('div', { class: 'rec-stage-part' }, h('div', { class: 'rec-trace-key' }, 'Other'), jsonPre(other)) : null,
    ),
  );
}

/** Render one parsed record file. */
export function traceView(file: RecordFile): HTMLElement {
  const trace = isObj(file.trace) ? file.trace : {};
  const stages = isObj(trace.stages) ? trace.stages : null;
  const allReplies = stages ? Object.values(stages).flatMap((st) => (isObj(st) ? repliesOf(st) : [])) : [];
  const usage = usageOf(allReplies);
  const seconds = num(file.seconds);
  const totals = [
    typeof trace.pipeline === 'string' ? trace.pipeline : '',
    stages ? plural(Object.keys(stages).length, 'stage') : '',
    stages ? plural(allReplies.length, 'call') : '',
    ...usageText({ ...usage, seconds: seconds ?? usage.seconds }),
  ].filter(Boolean);
  const rows = KNOWN.filter((k) => k in trace).map((k) => [
    h('dt', { title: HELP[k] }, LABEL[k] ?? sentence(k)),
    h('dd', null, valueView(trace[k])),
  ]);
  const unknown = Object.keys(trace).filter((k) => !KNOWN.includes(k) && k !== 'stages' && k !== 'pipeline');
  const extra = Object.keys(file).filter((k) => !FILE_KEYS.has(k));
  return h(
    'div',
    { class: 'rec-trace-view' },
    totals.length ? h('p', { class: 'rec-trace-totals' }, totals.join(' · ')) : null,
    rows.length ? h('dl', { class: 'rec-trace-dl' }, rows) : null,
    stages
      ? h(
          'section',
          { class: 'rec-trace-section' },
          h('h3', null, 'Stages'),
          Object.entries(stages).map(([name, st]) => stageView(name, st)),
        )
      : null,
    [...unknown.map((k) => [k, trace[k]] as const), ...extra.map((k) => [k, file[k]] as const)].map(([k, v]) =>
      h('section', { class: 'rec-trace-section' }, h('h3', null, k), jsonPre(v)),
    ),
  );
}
