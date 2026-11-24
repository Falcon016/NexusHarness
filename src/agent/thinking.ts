import type { Config } from '../config/schema.js';
import type { ReasoningEffort, StreamEvent } from '../llm/types.js';
import type { ThinkingSwitch } from '../llm/thinking.js';

/**
 * Thinking where it pays. A tool loop is mostly routine steps (read a file, run a command, look at the result)
 * that need little reasoning, between a few that need a lot (planning, an error, being stuck). Reasoning on
 * every step at full length is where most of the wait goes on a local model.
 *
 * Each step gets a budget of reasoning tokens. A step that runs past it is not cut off blind: the request stops,
 * and the model is handed where its reasoning got to and asked to act on it, with reasoning off for that one
 * request. It keeps its conclusions and skips the rest of the deliberation.
 */

/** Starts the note given to the model when a step's reasoning is wrapped up (the UI hides these). */
export const THINK_NOTE = '[Reasoning budget]';

/** Why a step gets the larger budget. */
export type KeyReason = 'new message' | 'error' | 'loop' | 'steered' | 'compacted';

export interface StepBudget {
  /** Reasoning tokens allowed; undefined: no limit. 0 means reasoning off. */
  tokens: number | undefined;
  key: boolean;
  why?: KeyReason;
}

/**
 * How /effort scales the budget for models that have no effort levels of their own. It means "how hard to think
 * on the hard parts", so in adaptive mode it scales key steps only: routine steps stay quick at any effort.
 */
const SCALE: Record<ReasoningEffort, number> = { low: 0.5, medium: 1, high: 2, xhigh: 4 };

const limit = (n: number, scale: number): number | undefined =>
  n < 0 ? undefined : n === 0 ? 0 : Math.round(n * scale);

export function stepBudget(
  cfg: Config['reasoning'],
  effort: ReasoningEffort | undefined,
  sw: ThinkingSwitch | undefined,
  key: KeyReason | undefined,
): StepBudget {
  const isKey = key !== undefined;
  const base = { key: isKey, ...(key ? { why: key } : {}) };
  if (cfg.mode === 'never') return { tokens: 0, ...base };
  // A model with real effort levels (gpt-oss) gets /effort as is; for the rest, effort scales the budgets.
  const scale = effort && sw !== 'reasoning_effort' ? SCALE[effort] : 1;
  if (cfg.mode === 'always')
    return { tokens: effort && sw !== 'reasoning_effort' ? limit(cfg.keyBudget, scale) : undefined, ...base };
  return { tokens: isKey ? limit(cfg.keyBudget, scale) : limit(cfg.routineBudget, 1), ...base };
}

/** Thrown out of a reply whose reasoning ran past its budget, with the reasoning so far. */
export class ThinkingBudget extends Error {
  constructor(
    readonly reasoning: string,
    readonly budget: number,
  ) {
    super(`Reasoning passed its budget of ${budget} tokens.`);
    this.name = 'ThinkingBudget';
  }
}

/** Roughly four characters to a token, as elsewhere in the harness's own counts. */
export const CHARS_PER_TOKEN = 4;

/**
 * Pass a reply through, stopping it once its reasoning passes `budget` tokens (while the reply proper has not
 * started). `stop` aborts the request, so the server stops generating.
 */
export async function* watchBudget(
  stream: AsyncIterable<StreamEvent>,
  budget: number,
  stop: () => void,
): AsyncGenerator<StreamEvent> {
  let reasoning = '';
  let answering = false;
  for await (const e of stream) {
    if (e.type === 'thinking' && !answering) {
      reasoning += e.delta;
      if (reasoning.length / CHARS_PER_TOKEN > budget) {
        stop();
        throw new ThinkingBudget(reasoning, budget);
      }
    } else if (e.type === 'text' || e.type === 'tool_call_start') answering = true;
    yield e;
  }
}

/** The note that hands the model its own reasoning back, to act on. */
export function wrapUpNote(e: ThinkingBudget): string {
  const max = 2400;
  let tail = e.reasoning.trim();
  if (tail.length > max) {
    tail = tail.slice(-max);
    // Start at a sentence or line, not mid-word.
    const cut = tail.search(/(?<=[.!?\n])\s+\S/);
    if (cut > 0 && cut < 400) tail = tail.slice(cut).trimStart();
    tail = `…${tail}`;
  }
  return (
    `${THINK_NOTE} You reasoned for about ${Math.round(e.reasoning.length / CHARS_PER_TOKEN)} tokens on this step, ` +
    `which is enough for it. Here is where your reasoning got to:\n\n${tail}\n\n` +
    'Act on it now: make your next tool call or give your answer, without starting the reasoning over. ' +
    'If something is still unclear, check it with a tool rather than more reasoning.'
  );
}

export interface ThinkingStats {
  /** Requests sent. */
  requests: number;
  /** Requests with reasoning off (routine steps with no budget, wrap-ups, "never"). */
  off: number;
  /** Steps whose reasoning was wrapped up at the budget. */
  wrapped: number;
  /** Reasoning received, in tokens (estimated). */
  reasoningTokens: number;
  /** Key steps (the larger budget). */
  key: number;
}

export const emptyStats = (): ThinkingStats => ({
  requests: 0,
  off: 0,
  wrapped: 0,
  reasoningTokens: 0,
  key: 0,
});

/** `<provider>/<model>` against a pattern with `*` wildcards, ignoring case. */
export function matches(pattern: string, spec: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );
  return re.test(spec);
}

/** The sampling settings for a model: every matching pattern, in config order, later ones winning. */
export function samplingFor(cfg: Config['sampling'], spec: string): Config['sampling'][string] | undefined {
  let out: Config['sampling'][string] | undefined;
  for (const [pattern, s] of Object.entries(cfg)) if (matches(pattern, spec)) out = { ...out, ...s };
  return out;
}
