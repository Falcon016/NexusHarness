import { createHash } from 'node:crypto';
import type { Message, StreamEvent } from '../llm/types.js';
import { draftInfo } from './draft.js';

/**
 * Loop detection. A model, local quantized ones most of all, can get stuck two ways:
 *
 *  - while it writes: the same passage over and over in its reply, its reasoning, or a file it is writing.
 *    That request is stopped as soon as the repetition is clear, what came before it is kept, and the model is
 *    asked to carry on (with a little anti-repetition sampling, and no reasoning when the reasoning looped).
 *  - between calls: the same tool call with the same result again and again, or the same few calls in a cycle.
 *    Nothing is stopped or skipped there: the model is told, in the result itself, that it is going round in a
 *    loop, and every time it goes round again it is told again, more firmly, until it changes approach.
 *
 * Neither ever ends the turn, rolls anything back, or drops a task: the point is that the work carries on.
 */

/** Starts every message the harness adds about a loop (the UI and saved-session readers skip these). */
export const LOOP_NOTE = '[Loop check]';

// ---- repetition while writing ---------------------------------------------------------------------

export interface Repeat {
  /** Where the copies after the first one begin: everything before this is kept. */
  start: number;
  period: number;
  reps: number;
}

export interface RepeatRule {
  /** Shortest repeating block worth looking for, in characters. */
  minPeriod: number;
  maxPeriod: number;
  /** Copies in a row, at least. */
  minReps: number;
  /** Characters the copies must cover between them, at least: short repeats need many copies. */
  minSpan: number;
}

/** Replies and reasoning: a few copies of a passage. */
export const PROSE_RULE: RepeatRule = { minPeriod: 20, maxPeriod: 3000, minReps: 3, minSpan: 600 };
/** File contents and commands: data can repeat legitimately, so it takes many more. */
export const ARGS_RULE: RepeatRule = { minPeriod: 40, maxPeriod: 3000, minReps: 6, minSpan: 4000 };

/** Does `s` end with the same block repeated? Pure; cost is a few string comparisons per candidate period. */
export function findRepeat(s: string, rule: RepeatRule): Repeat | undefined {
  const { minPeriod, minReps, minSpan } = rule;
  const maxPeriod = Math.min(rule.maxPeriod, Math.floor(s.length / minReps));
  if (maxPeriod < minPeriod) return undefined;
  const probe = s.slice(-minPeriod);
  const probeAt = s.length - minPeriod;
  // Every earlier place the last few characters occur is a candidate period, the shortest first.
  let at = probeAt;
  for (let tries = 0; tries < 64; tries++) {
    at = s.lastIndexOf(probe, at - 1);
    if (at < 0) return undefined;
    const p = probeAt - at;
    if (p > maxPeriod) return undefined;
    if (p < minPeriod) continue;
    const block = s.slice(-p);
    let reps = 1;
    while ((reps + 1) * p <= s.length && s.slice(s.length - (reps + 1) * p, s.length - reps * p) === block)
      reps++;
    if (reps >= minReps && reps * p >= minSpan) {
      // The copies need not line up with the end of the text: walk back to where the repetition really began,
      // so exactly one whole copy is kept.
      let begin = s.length - reps * p;
      while (begin > 0 && s[begin - 1] === s[begin - 1 + p]) begin--;
      return { start: begin + p, period: p, reps: Math.floor((s.length - begin) / p) };
    }
  }
  return undefined;
}

export type WritingLoopKind = 'text' | 'thinking' | 'tool';

/** Thrown out of a reply that started repeating itself, with what to keep of it. */
export class WritingLoop extends Error {
  constructor(
    readonly kind: WritingLoopKind,
    /** The reply up to where the repetition began: only its text, since an unfinished tool call cannot run. */
    readonly kept: Message,
    readonly tool?: { name: string; target?: string },
  ) {
    super(`The model started repeating itself (${kind}).`);
    this.name = 'WritingLoop';
  }
}

/** Checked every this many new characters: often enough to stop within a second or two of output. */
const CHECK_EVERY = 256;
/** Enough of the end of each stream to hold several copies of the longest block. */
const TAIL = 16_000;

/**
 * Pass a reply's events through, stopping it with a WritingLoop as soon as its text, reasoning or a tool call's
 * arguments start repeating. `stop` aborts the request, so a local server stops generating at once.
 */
export async function* watchRepeats(
  stream: AsyncIterable<StreamEvent>,
  stop: () => void,
): AsyncGenerator<StreamEvent> {
  let text = '';
  let thinking = '';
  let textChecked = 0;
  let thinkingChecked = 0;
  const calls = new Map<string, { name: string; json: string; checked: number }>();
  const fail = (kind: WritingLoopKind, keep: string, tool?: { name: string; target?: string }): never => {
    stop();
    const kept = keep.trimEnd();
    throw new WritingLoop(
      kind,
      { role: 'assistant', content: kept.trim() ? [{ type: 'text', text: kept }] : [] },
      tool,
    );
  };
  for await (const e of stream) {
    if (e.type === 'text') {
      text += e.delta;
      if (text.length - textChecked >= CHECK_EVERY) {
        textChecked = text.length;
        const base = Math.max(0, text.length - TAIL);
        const r = findRepeat(text.slice(base), PROSE_RULE);
        if (r) fail('text', text.slice(0, base + r.start));
      }
    } else if (e.type === 'thinking') {
      thinking += e.delta;
      if (thinking.length - thinkingChecked >= CHECK_EVERY) {
        thinkingChecked = thinking.length;
        if (thinking.length > TAIL) {
          thinkingChecked -= thinking.length - TAIL;
          thinking = thinking.slice(-TAIL);
        }
        if (findRepeat(thinking, PROSE_RULE)) fail('thinking', text);
      }
    } else if (e.type === 'tool_call_start') {
      calls.set(e.id, { name: e.name, json: '', checked: 0 });
    } else if (e.type === 'tool_call_delta') {
      const c = calls.get(e.id);
      if (c) {
        c.json += e.json;
        if (c.json.length - c.checked >= CHECK_EVERY * 4) {
          c.checked = c.json.length;
          if (findRepeat(c.json.slice(-TAIL), ARGS_RULE)) {
            const target = draftInfo(c.json.slice(0, 2000)).target;
            fail('tool', text, { name: c.name, ...(target ? { target } : {}) });
          }
        }
      }
    }
    yield e;
  }
}

/** What the model is told after a reply was stopped for repeating itself. */
export function writingLoopNote(e: WritingLoop): string {
  if (e.kind === 'thinking')
    return (
      `${LOOP_NOTE} Your reasoning started going round in circles, repeating the same passage, so it was ` +
      'stopped. You have thought about this enough: decide on the next step and take it, and keep working ' +
      'until the task is done.'
    );
  if (e.kind === 'tool') {
    const what = e.tool?.target
      ? `${e.tool.name} call for ${e.tool.target}`
      : `${e.tool?.name ?? 'tool'} call`;
    return (
      `${LOOP_NOTE} Your ${what} started repeating the same content over and over, so it was stopped and ` +
      'nothing was run or written. Make the call again without the repetition (write a large file in ' +
      'parts), then keep working until the task is done.'
    );
  }
  return (
    `${LOOP_NOTE} Your last reply started repeating the same passage over and over, so it was stopped there ` +
    'and the repeats were removed. Carry on from where it stopped without repeating yourself, and keep ' +
    'working until the task is done.'
  );
}

// ---- repeated actions -------------------------------------------------------------------------------

export interface ActionLoop {
  /**
   * 'cycle': the same calls in the same order with the same results; 'repeat': one result again and again;
   * 'same': the very same call many times in a row, whatever it returned (a screenshot of an animated page,
   * polling with a call each time).
   */
  kind: 'cycle' | 'repeat' | 'same';
  /** Calls in one round of a cycle (1 = the same call back to back). */
  period: number;
  /** Rounds of the cycle, or times the result was seen. */
  count: number;
  /** How many times in this loop the model has been told: it is told again, more firmly, each time. */
  strike: number;
}

const WINDOW = 20;
const ROUNDS = 3;
const REPEATS = 4;
const MAX_PERIOD = 4;
/** The same call this many times in a row is a loop even when its result keeps changing. */
const SAME_CALL = 8;
/** From this reminder on, a call that is part of the loop is not run again: it is answered with the loop note. */
export const REFUSE_FROM = 3;
/** Calls without a loop after which the loop counts as over. */
const CALM = 8;

/**
 * Parts of a result that change every time without saying anything: where a screenshot was saved, clock times,
 * how long something took. Left in, they make every result look new, and a loop goes unnoticed (a model once
 * took 36 screenshots of the same page, each "saved to" a new file).
 */
const VOLATILE: [RegExp, string][] = [
  [/\bSaved to \S+/g, 'Saved to <file>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, '<time>'],
  [/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<time>'],
  [/\b\d+(\.\d+)?\s?(ms|µs|s|sec|secs|seconds)\b/g, '<duration>'],
];
export const steady = (s: string) => VOLATILE.reduce((t, [re, to]) => t.replace(re, to), s);

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v ?? null);
const hash = (s: string) => createHash('sha1').update(s).digest('base64').slice(0, 16);

/**
 * Remembers the last few tool calls and their results (not part of the conversation, so a compaction does
 * not hide a loop from it). A result that changes is progress, so polling something until it changes is fine.
 */
export class ActionWatch {
  /** Each call's fingerprint (the call and its result) and the call alone. */
  private seen: { fp: string; call: string }[] = [];
  private strikes = 0;
  private calm = 0;
  /** The same call, back to back: which, and how many times. */
  private run = { call: '', n: 0 };
  /** The calls that make up the loop last found. */
  private looping = new Set<string>();
  private last: Omit<ActionLoop, 'strike'> | undefined;

  observe(
    name: string,
    input: unknown,
    result: { content: string; isError?: boolean; images?: { data: string }[] },
  ): ActionLoop | undefined {
    const call = `${name}:${hash(stable(input))}`;
    // The picture counts too: a screenshot that shows something new is progress.
    const images = (result.images ?? []).map((i) => hash(i.data)).join(',');
    const fp = `${call}:${hash(`${result.isError ? 'E' : ''}${steady(result.content)}|${images}`)}`;
    this.seen.push({ fp, call });
    if (this.seen.length > WINDOW) this.seen.shift();
    this.run = this.run.call === call ? { call, n: this.run.n + 1 } : { call, n: 1 };
    const found = this.find();
    if (!found) {
      if (++this.calm >= CALM) {
        this.strikes = 0;
        this.looping.clear();
      }
      return undefined;
    }
    this.calm = 0;
    this.last = found.loop;
    this.looping = found.calls;
    return { ...found.loop, strike: ++this.strikes };
  }

  /**
   * Whether to answer this call with the loop note instead of running it: the model has been told REFUSE_FROM
   * times already, and it is making one of the loop's calls straight after another of them, with nothing else
   * in between that could have changed the answer. After any other call (an edit, say) it runs as usual, so
   * checking the effect of a change is never refused.
   */
  refuse(name: string, input: unknown): ActionLoop | undefined {
    if (this.strikes < REFUSE_FROM || !this.last) return undefined;
    const call = `${name}:${hash(stable(input))}`;
    if (!this.looping.has(call) || !this.looping.has(this.run.call)) return undefined;
    this.calm = 0;
    this.run = this.run.call === call ? { call, n: this.run.n + 1 } : { call, n: 1 };
    return { ...this.last, count: this.last.count + 1, strike: ++this.strikes };
  }

  private find(): { loop: Omit<ActionLoop, 'strike'>; calls: Set<string> } | undefined {
    const s = this.seen.map((x) => x.fp);
    const callsOf = (n: number) => new Set(this.seen.slice(-n).map((x) => x.call));
    for (let p = 1; p <= MAX_PERIOD; p++) {
      if (s.length < p * ROUNDS) break;
      const round = s.slice(-p);
      // A cycle of one distinct call repeated is period 1, not 2.
      if (p > 1 && round.every((x) => x === round[0])) continue;
      let rounds = 1;
      while (
        s.length >= (rounds + 1) * p &&
        s.slice(-(rounds + 1) * p, -rounds * p).every((x, i) => x === round[i])
      )
        rounds++;
      if (rounds >= ROUNDS) return { loop: { kind: 'cycle', period: p, count: rounds }, calls: callsOf(p) };
    }
    const last = s.at(-1)!;
    const count = s.filter((x) => x === last).length;
    if (count >= REPEATS) return { loop: { kind: 'repeat', period: 1, count }, calls: callsOf(1) };
    if (this.run.n >= SAME_CALL)
      return { loop: { kind: 'same', period: 1, count: this.run.n }, calls: callsOf(1) };
    return undefined;
  }
}

/** What the model is told, in the tool result, each time it goes round a loop. */
export function actionLoopNote(loop: ActionLoop, task?: string): string {
  const what =
    loop.kind === 'same'
      ? `You have made this same call ${loop.count} times in a row. If you are waiting for something, wait ` +
        'inside one command (a loop with sleep and a time limit) instead of calling again and again; if it is a ' +
        'screenshot or a snapshot, the page has not changed in between, so look at the one you have.'
      : loop.kind === 'repeat'
        ? `This call has now given exactly the same result ${loop.count} times recently. If you are trying to ` +
          'change that result, what you are doing in between is not reaching the cause: re-read it carefully and ' +
          'question your assumptions. If you already have what you need from it, use it instead of asking again.'
        : loop.period === 1
          ? `You have made this exact call ${loop.count} times in a row and got the same result each time. ` +
            'Making it again will not change anything.'
          : `You are going round in a loop: the same ${loop.period} calls, in the same order, with the same ` +
            `results, ${loop.count} times. Going round again will not change anything.`;
  const then =
    loop.strike === 1
      ? ' Try a different approach. If you are waiting for something to change, find out why it has not ' +
        'rather than checking again.'
      : ` (Reminder ${loop.strike}.) Before your next call, write one or two sentences: what you have tried, ` +
        'why it did not work, and what you will do differently. Then do that.';
  const keep =
    ` Keep going until the task${task ? ` ("${task}")` : ''} is actually done: do not skip it, give up on it, ` +
    'or mark it done before it is.';
  return `\n\n${LOOP_NOTE} ${what}${then}${keep}`;
}

/**
 * The answer to a call that was not run because it is part of a loop the model has been told about several
 * times. It is an error result, so the model reads it as "this did not happen", and it says what to do instead.
 */
export function actionRefusalNote(loop: ActionLoop, task?: string): string {
  return (
    `${LOOP_NOTE} Not run. This call is part of a loop you have been told about ${loop.strike - 1} times: ` +
    (loop.kind === 'same'
      ? `the same call ${loop.count} times in a row. `
      : `it has already given the same result again and again. `) +
    'Running it again cannot tell you anything new, so it was not run. Use the results you already have: ' +
    'write down in one or two sentences what they show and what you will do differently, then take a ' +
    `different step. Keep going until the task${task ? ` ("${task}")` : ''} is done; this call becomes ` +
    'available again once you have moved on to other work.'
  );
}

/** Messages the harness wrote to the model (loop checks, reasoning wrap-ups), not the user's own words. */
export const isLoopNote = (text: string) =>
  text.startsWith(LOOP_NOTE) || text.startsWith('[Reasoning budget]');
