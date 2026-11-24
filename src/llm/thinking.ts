/**
 * How to turn a model's reasoning off for one request, read from its own chat template, so it works across
 * model families rather than guessing:
 *
 *  - `enable_thinking`: Qwen 3 and later, GLM, and most hybrid models built on their templates.
 *  - `thinking`: DeepSeek V3.1 and later, Granite, and templates that copied theirs.
 *  - `reasoning_effort`: gpt-oss and others whose reasoning has levels but cannot be switched off; "off" asks
 *    for the lowest level.
 *  - `unknown`: no template to read (a server other than llama.cpp, or a router): both of the first two are sent.
 *    Templates ignore variables they do not use, so this is harmless where it does nothing.
 *
 * It also checks that switching reasoning off changes only the end of the prompt, so the server can keep the
 * conversation it has cached: a template that rewrites earlier turns would make every switch a full re-read.
 */

export type ThinkingSwitch = 'enable_thinking' | 'thinking' | 'reasoning_effort' | 'unknown';

export interface ThinkingInfo {
  switch: ThinkingSwitch;
  /**
   * `safe`: only the end of the prompt changes; `unsafe`: earlier turns change too (switching costs a re-read);
   * `unverified`: the server could not show it.
   */
  cache: 'safe' | 'unsafe' | 'unverified';
  /** The template has a reasoning section at all (`<think>` and the like). */
  reasons?: boolean;
  /** The server's default sampling temperature, when it says. */
  temperature?: number;
}

/** Which switch a chat template reads. */
export function detectSwitch(template: string | undefined): ThinkingSwitch {
  if (!template) return 'unknown';
  if (/\benable_thinking\b/.test(template)) return 'enable_thinking';
  if (
    /\{%-?\s*(?:if|elif)\s+(?:not\s+)?thinking\b|\bthinking\s+is\s+(?:defined|true|false|not)|\bthinking\s*==/.test(
      template,
    )
  )
    return 'thinking';
  if (/\breasoning_effort\b/.test(template)) return 'reasoning_effort';
  return 'unknown';
}

/** The request fields that turn reasoning off with a given switch. */
export function offFields(sw: ThinkingSwitch): {
  kwargs: Record<string, unknown>;
  body: Record<string, unknown>;
} {
  switch (sw) {
    case 'enable_thinking':
      return { kwargs: { enable_thinking: false }, body: {} };
    case 'thinking':
      return { kwargs: { thinking: false }, body: {} };
    case 'reasoning_effort':
      return { kwargs: { reasoning_effort: 'low' }, body: { reasoning_effort: 'low' } };
    case 'unknown':
      return { kwargs: { enable_thinking: false, thinking: false }, body: {} };
  }
}

/** A short conversation with a tool call, ending in a marked user message. */
const MARK = 'zq-cache-check-7f3a';
export const PROBE_MESSAGES = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'List the files.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
  { role: 'assistant', content: 'There are two files.' },
  { role: 'user', content: `Thanks. ${MARK}` },
];

/**
 * Whether two renderings of the same conversation (reasoning on, reasoning off) differ only after its last
 * message: then switching keeps the cached prefix.
 */
export function cacheVerdict(on: string | undefined, off: string | undefined): ThinkingInfo['cache'] {
  if (on === undefined || off === undefined) return 'unverified';
  if (on === off) return 'unverified'; // the server ignored the switch here
  let i = 0;
  while (i < on.length && i < off.length && on[i] === off[i]) i++;
  const last = Math.max(on.lastIndexOf(MARK), off.lastIndexOf(MARK));
  return last >= 0 && i >= last + MARK.length ? 'safe' : 'unsafe';
}
