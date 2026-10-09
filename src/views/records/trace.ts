/**
 * Pipeline traces (`traces/<record_id>.json`): loaded lazily, cached, and
 * rendered for reading — known keys as chips, lists and small tables; the
 * stages as collapsed accordions; anything unknown as JSON.
 */

import { readTrace } from '../../core/load';
import type { Pipeline, RecordId } from '../../core/types';
import { badge } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtDuration, fmtInt, humanize, plural } from '../../ui/format';
import { icon } from '../../ui/icons';

export type Trace = Record<string, unknown>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Small LRU cache of parsed traces (they can be large). */
export class TraceCache {
  private readonly cache = new Map<string, Promise<Trace | null>>();

  constructor(private readonly size = 24) {}

  get(p: Pipeline, rid: RecordId): Promise<Trace | null> {
    const key = `${p.index}:${rid}`;
    let hit = this.cache.get(key);
    if (hit) this.cache.delete(key);
    else hit = readTrace(p, rid);
    this.cache.set(key, hit);
    while (this.cache.size > this.size) this.cache.delete(this.cache.keys().next().value!);
    return hit;
  }
}

const KNOWN: readonly string[] = ['examined', 'skipped', 'findings', 'gate_changes', 'final_fixes', 'final_schema_errors'];
const LABEL: Record<string, string> = {
  examined: 'Examined',
  skipped: 'Skipped',
  findings: 'Findings',
  gate_changes: 'Gate changes',
  final_fixes: 'Final fixes',
  final_schema_errors: 'Final schema errors',
};
const NORMAL_FINISH = new Set(['stop', 'end_turn', 'stop_sequence', 'finish_reason_stop']);

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
  cached: number;
  prompt: number;
  output: number;
  thought: number;
  seconds: number;
}

function usageOf(replies: Obj[]): Usage {
  const u: Usage = { calls: replies.length, cached: 0, prompt: 0, output: 0, thought: 0, seconds: 0 };
  for (const r of replies) {
    if (r.cached === true) u.cached += 1;
    u.prompt += num(r.prompt_tokens) ?? 0;
    u.output += num(r.output_tokens) ?? 0;
    u.thought += num(r.thought_tokens) ?? 0;
    u.seconds += num(r.seconds) ?? 0;
  }
  return u;
}

function usageText(u: Usage): string[] {
  return [
    u.prompt ? `${fmtInt(u.prompt)} prompt` : '',
    u.output ? `${fmtInt(u.output)} output` : '',
    u.thought ? `${fmtInt(u.thought)} thinking tokens` : '',
    u.seconds ? fmtDuration(u.seconds) : '',
    u.cached ? `${fmtInt(u.cached)} cached` : '',
  ].filter(Boolean);
}

const repliesOf = (stage: Obj): Obj[] => (Array.isArray(stage.replies) ? stage.replies.filter(isObj) : []);

function replyView(r: Obj, i: number, n: number): HTMLElement {
  const finish = typeof r.finish_reason === 'string' ? r.finish_reason : null;
  const meta = [
    n > 1 ? `Reply ${i + 1} of ${n}` : 'Reply',
    num(r.prompt_tokens) !== null ? `${fmtInt(num(r.prompt_tokens))} prompt` : '',
    num(r.output_tokens) !== null ? `${fmtInt(num(r.output_tokens))} output` : '',
    num(r.thought_tokens) !== null ? `${fmtInt(num(r.thought_tokens))} thinking tokens` : '',
    num(r.seconds) !== null ? fmtDuration(num(r.seconds)) : '',
    finish && NORMAL_FINISH.has(finish.toLowerCase()) ? finish : '',
    r.cached === true ? 'cached' : '',
  ].filter(Boolean);
  const known = new Set(['text', 'thoughts', 'prompt_tokens', 'output_tokens', 'thought_tokens', 'seconds', 'finish_reason', 'cached']);
  const other = Object.fromEntries(Object.entries(r).filter(([k]) => !known.has(k)));
  const thoughts = typeof r.thoughts === 'string' && r.thoughts ? r.thoughts : null;
  return h(
    'div',
    { class: 'rec-reply' },
    h(
      'div',
      { class: 'rec-reply-meta' },
      meta.join(' · '),
      finish && !NORMAL_FINISH.has(finish.toLowerCase()) ? badge(`finish: ${finish}`, 'warning') : null,
    ),
    typeof r.text === 'string' ? h('pre', { class: 'rec-pre' }, r.text) : null,
    thoughts
      ? h(
          'details',
          { class: 'disclosure rec-reasoning' },
          h('summary', null, icon('chevronRight'), 'Reasoning', h('span', { class: 'muted' }, ` · ${plural(thoughts.length, 'character')}`)),
          h('pre', { class: 'rec-pre' }, thoughts),
        )
      : null,
    Object.keys(other).length ? jsonPre(other) : null,
  );
}

function stageView(name: string, stage: unknown): HTMLElement {
  const summary = (meta: Child) =>
    h('summary', null, icon('chevronRight'), h('span', { class: 'rec-stage-name' }, name), meta);
  if (!isObj(stage)) return h('details', { class: 'disclosure rec-stage' }, summary(null), h('div', { class: 'rec-stage-body' }, jsonPre(stage)));
  const replies = repliesOf(stage);
  const rounds = num(stage.rounds);
  const problems = Array.isArray(stage.problems) ? stage.problems : null;
  const meta = [
    rounds !== null ? plural(rounds, 'round') : '',
    replies.length ? plural(replies.length, 'reply', 'replies') : '',
    ...usageText(usageOf(replies)),
  ].filter(Boolean);
  const known = new Set(['rounds', 'problems', 'extra', 'replies']);
  const other = Object.fromEntries(Object.entries(stage).filter(([k]) => !known.has(k)));
  const extra = isObj(stage.extra) ? Object.entries(stage.extra) : [];
  return h(
    'details',
    { class: 'disclosure rec-stage' },
    summary([
      h('span', { class: 'rec-stage-meta' }, meta.join(' · ')),
      problems?.length ? badge(plural(problems.length, 'problem'), 'warning') : null,
    ]),
    h(
      'div',
      { class: 'rec-stage-body' },
      problems?.length ? h('div', { class: 'rec-stage-part' }, h('div', { class: 'rec-trace-key' }, 'Problems'), valueView(problems)) : null,
      extra.map(([k, v]) => h('div', { class: 'rec-stage-part' }, h('div', { class: 'rec-trace-key' }, sentence(k)), valueView(v))),
      replies.map((r, i) => replyView(r, i, replies.length)),
      Object.keys(other).length ? h('div', { class: 'rec-stage-part' }, h('div', { class: 'rec-trace-key' }, 'Other'), jsonPre(other)) : null,
    ),
  );
}

/** Render one parsed trace. */
export function traceView(trace: Trace): HTMLElement {
  const stages = isObj(trace.stages) ? trace.stages : null;
  const allReplies = stages ? Object.values(stages).flatMap((st) => (isObj(st) ? repliesOf(st) : [])) : [];
  const totals = stages
    ? [plural(Object.keys(stages).length, 'stage'), plural(allReplies.length, 'call'), ...usageText(usageOf(allReplies))]
    : [];
  const rows = KNOWN.filter((k) => k in trace).map((k) => [h('dt', null, LABEL[k] ?? sentence(k)), h('dd', null, valueView(trace[k]))]);
  const unknown = Object.keys(trace).filter((k) => !KNOWN.includes(k) && k !== 'stages');
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
    unknown.map((k) => h('section', { class: 'rec-trace-section' }, h('h3', null, k), jsonPre(trace[k]))),
  );
}
