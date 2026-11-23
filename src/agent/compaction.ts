import { assemble } from '../llm/assemble.js';
import {
  ProviderError,
  type Message,
  type Provider,
  type ReasoningEffort,
  type ToolSpec,
} from '../llm/types.js';
import { truncateMiddle } from '../util/text.js';
import { estimateMessages, HARD_LIMIT } from './context.js';
import { isToolResultOnly, type Session } from './session.js';

export { estimateMessages } from './context.js';

const CHARS_PER_TOKEN = 3.5;

export interface CompactionPlan {
  /** Index (into the session's message entries) of the first message that stays verbatim. */
  cutIndex: number;
  firstKeptId: string;
  /** Exactly what the model currently sees before the cut (earlier summary included). */
  toSummarise: Message[];
  /** What stays verbatim after the cut: shown to the summariser so it knows what already happened next. */
  kept: Message[];
  keptCount: number;
  /** Session leaf when the plan was made; the commit is refused if it moved. */
  leaf: string | null;
}

/**
 * Choose where to cut. Any message except a tool_result-only user message is a safe boundary, because a
 * tool_use and its tool_result then always stay on the same side. (An assistant message starts a fresh
 * exchange; a user text message starts a fresh turn.) That makes it possible to compact even in the
 * middle of a long tool loop, which a "plain user message only" rule could not.
 */
export function planCompaction(session: Session, keepRecent: number): CompactionPlan | undefined {
  const entries = session.messageEntries();
  const n = entries.length;
  if (n < 2) return undefined;

  // Never cut inside the part an earlier compaction already summarised: that would summarise nothing new.
  const path = session.path();
  const lastComp = [...path].reverse().find((e) => e.type === 'compaction');
  const prevKept =
    lastComp && lastComp.type === 'compaction' ? entries.findIndex((e) => e.id === lastComp.firstKeptId) : -1;

  const start = Math.min(n - Math.max(1, keepRecent), n - 1);
  let cut = -1;
  for (let i = start; i > prevKept && i > 0; i--) {
    if (!isToolResultOnly(entries[i]!.message.content)) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return undefined;

  const visible = session.messages();
  const keptCount = n - cut;
  const toSummarise = visible.slice(0, Math.max(0, visible.length - keptCount));
  if (!toSummarise.length) return undefined;
  const kept = visible.slice(toSummarise.length);
  return { cutIndex: cut, firstKeptId: entries[cut]!.id, toSummarise, kept, keptCount, leaf: session.leaf };
}

function pieces(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') out.push(`${m.role.toUpperCase()}: ${b.text}`);
      else if (b.type === 'tool_use')
        out.push(`TOOL CALL ${b.name}: ${truncateMiddle(JSON.stringify(b.input), 600)}`);
      else if (b.type === 'tool_result') {
        out.push(`TOOL RESULT${b.isError ? ' (error)' : ''}: ${truncateMiddle(b.content, 800)}`);
      }
    }
  }
  return out;
}

const SUMMARY_SYSTEM =
  'You compress coding-agent conversations. Write a dense, factual summary another agent can continue from. ' +
  "Include: the user's goals and constraints, decisions made, files created or changed (with paths), commands run and their outcomes, " +
  'and errors still unresolved. Keep what is DONE apart from what REMAINS: under "Done" list the work that was finished, ' +
  'under "Remaining" only work that is still open. If the later conversation shows something finished, it is done, ' +
  'not remaining. If the latest request is complete, say so plainly and leave "Remaining" empty. ' +
  'Do not invent details. Use short bullet points.';

/** Starts the request appended to a conversation to have it summarised (tests and mock servers look for it). */
export const COMPACTION_REQUEST = '[Compaction request]';

/**
 * The conversation exactly as it was last sent to the model. Summarising it as one more message on the end
 * lets the server reuse what it has already read (llama.cpp keeps it cached), instead of reading the whole
 * conversation again from scratch as a transcript.
 */
export interface LiveConversation {
  system: string;
  tools: ToolSpec[];
  messages: Message[];
  /** Its size in tokens, to check the summary request still fits the window. */
  tokens: number;
  /** Sent as it was with the conversation, since some templates write it into the system prompt. */
  reasoningEffort?: ReasoningEffort | undefined;
}

export interface SummariseOptions {
  provider: Provider;
  model: string;
  /** Context window of the summarising model, in tokens. */
  window: number;
  instructions?: string | undefined;
  /** The conversation after the part being summarised, kept verbatim: context only, not to be summarised. */
  after?: Message[] | undefined;
  signal?: AbortSignal | undefined;
  /** Called as the summary streams in: its size so far, whether the model is still reasoning, which part. */
  onProgress?: ((p: SummaryProgress) => void) | undefined;
  /** When given, and it fits, the summary is asked for at the end of it (see LiveConversation). */
  conversation?: LiveConversation | undefined;
}

export interface SummaryProgress {
  chars: number;
  thinking: boolean;
  part: number;
  parts: number;
}

interface Ask {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  reasoningEffort?: ReasoningEffort | undefined;
}

/** The summary text of one request; undefined when the model called a tool instead of answering. */
async function ask(
  o: SummariseOptions,
  req: Ask,
  part: { part: number; parts: number },
): Promise<string | undefined> {
  let chars = 0;
  const report = (thinking: boolean, n: number) => {
    chars += n;
    o.onProgress?.({ chars, thinking, ...part });
  };
  const send = (noThinking: boolean) =>
    assemble(
      o.provider.stream({
        model: o.model,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens,
        ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
        // A summary needs no reasoning first, and on a local model reasoning is minutes of waiting.
        ...(noThinking ? { thinking: false as const } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      }),
      { onText: (d) => report(false, d.length), onThinking: (d) => report(true, d.length) },
    );
  let res;
  try {
    res = await send(true);
  } catch (e) {
    // A server that refuses the template setting gets the request again without it.
    if (!(e instanceof ProviderError) || e.status !== 400 || o.signal?.aborted) throw e;
    chars = 0;
    res = await send(false);
  }
  const text = res.message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text && res.message.content.some((b) => b.type === 'tool_use')) return undefined;
  return text;
}

/** A few words of a message, to point at it. */
const opening = (m: Message | undefined) =>
  m ? truncateMiddle((pieces([m])[0] ?? '').replace(/\s+/g, ' '), 120) : '';

/**
 * Ask for the summary as one more message at the end of the conversation as it was last sent. The server has
 * all of it cached already, so only this request is new: seconds instead of re-reading the whole thing.
 * Undefined when it does not fit, or the model did not answer with a summary.
 */
async function summariseInPlace(
  o: SummariseOptions & { conversation: LiveConversation },
  targetTokens: number,
): Promise<string | undefined> {
  const c = o.conversation;
  const keptNote = o.after?.length
    ? `The last ${o.after.length} message${o.after.length === 1 ? '' : 's'} (from the one that starts ` +
      `"${opening(o.after[0])}") stay in the conversation word for word after your summary: do not summarise ` +
      'them, use them only to judge what is done.\n'
    : '';
  const instruction =
    `${COMPACTION_REQUEST} The conversation is about to be shortened: write the summary that will replace its ` +
    `older part, so the work can carry on from it. ${SUMMARY_SYSTEM}\n${keptNote}` +
    (o.instructions ? `Focus: ${o.instructions}\n` : '') +
    `Keep it under about ${Math.floor(targetTokens * 0.7)} words. Reply with the summary only, as plain text, ` +
    'and do not call any tools.';
  const maxTokens = targetTokens * 2;
  const room = Math.floor(o.window * HARD_LIMIT) - c.tokens - estimateMessages([textMessage(instruction)]);
  if (room < maxTokens) return undefined;

  // Added to the last message rather than as a new one, so the conversation's own messages stay as they were.
  const last = c.messages.at(-1);
  const messages =
    last?.role === 'user'
      ? [
          ...c.messages.slice(0, -1),
          { ...last, content: [...last.content, { type: 'text' as const, text: instruction }] },
        ]
      : [...c.messages, textMessage(instruction)];
  o.onProgress?.({ chars: 0, thinking: false, part: 1, parts: 1 });
  const text = await ask(
    o,
    { system: c.system, tools: c.tools, messages, maxTokens, reasoningEffort: c.reasoningEffort },
    { part: 1, parts: 1 },
  );
  return text && text.length >= 20 ? text : undefined;
}

const textMessage = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

/**
 * Summarise by folding chunks into a running summary, so the input to every model call fits the
 * summariser's window no matter how long the conversation is (important for small local models).
 */
export async function summarise(messages: Message[], o: SummariseOptions): Promise<string> {
  const window = Math.max(2048, o.window);
  const targetTokens = Math.max(250, Math.min(1500, Math.floor(window * 0.08)));
  if (o.conversation) {
    try {
      const text = await summariseInPlace({ ...o, conversation: o.conversation }, targetTokens);
      if (text) return text;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      // Refused or failed (a server whose real window is smaller, say): the transcript way below still works.
    }
  }
  const budgetChars = Math.max(2000, Math.floor(window * 0.4 * CHARS_PER_TOKEN));
  const focus = o.instructions ? `Focus: ${o.instructions}\n` : '';
  const limit = `Keep the summary under about ${Math.floor(targetTokens * 0.7)} words.`;
  // What happens after this part decides what counts as done; the newest messages matter most.
  const laterText = truncateMiddle(
    pieces(o.after ?? [])
      .map((p) => truncateMiddle(p, 400))
      .join('\n'),
    Math.floor(budgetChars * 0.25),
  );
  const later = laterText
    ? `For reference only, do not summarise this: the conversation continues after this part with:\n${laterText}\n\n`
    : '';

  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces(messages)) {
    const piece = truncateMiddle(p, Math.floor(budgetChars * 0.5));
    if (cur && cur.length + piece.length + 1 > budgetChars) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + piece;
  }
  if (cur) chunks.push(cur);

  let summary = '';
  for (const [i, chunk] of chunks.entries()) {
    const part = { part: i + 1, parts: chunks.length };
    o.onProgress?.({ chars: 0, thinking: false, ...part });
    const prompt = summary
      ? `Existing summary so far:\n${summary}\n\nMerge in this later part of the conversation:\n${chunk}\n\n${later}${focus}${limit}\nWrite the updated summary now.`
      : `${chunk}\n\n${later}${focus}${limit}\nWrite the summary now.`;
    const req = (maxTokens: number): Ask => ({
      system: SUMMARY_SYSTEM,
      messages: [textMessage(prompt)],
      tools: [],
      maxTokens,
    });
    // A model that reasons anyway can spend the whole budget on it; retry once with a larger one.
    let text = await ask(o, req(targetTokens * 2), part);
    if (!text) text = await ask(o, req(Math.min(targetTokens * 6, Math.floor(window * 0.4))), part);
    if (!text) throw new Error('The model returned an empty summary.');
    summary = text;
  }
  return summary;
}

export interface CompactResult {
  summary: string;
  droppedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
}

export class CompactionError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'CompactionError';
  }
}

/**
 * Transactional compaction. The summary is produced first from an immutable snapshot; the session is
 * written to (one appended line) only if it is valid, smaller than what it replaces, and the conversation
 * did not change meanwhile. On any failure the session is untouched. Nothing is ever deleted: the full
 * original messages stay in the append-only session file, compaction only changes what is sent to the model.
 */
export async function compact(opts: {
  session: Session;
  provider: Provider;
  model: string;
  window: number;
  keepRecent: number;
  signal?: AbortSignal;
  instructions?: string;
  /** Appended to the stored summary as is (the agent's current task list). */
  appendix?: string;
  onProgress?: (p: SummaryProgress) => void;
  /** The conversation as last sent, when the summariser is the model it was sent to. */
  conversation?: LiveConversation;
}): Promise<CompactResult | undefined> {
  const plan = planCompaction(opts.session, opts.keepRecent);
  if (!plan) return undefined;

  const summary = await summarise(plan.toSummarise, {
    provider: opts.provider,
    model: opts.model,
    window: opts.window,
    instructions: opts.instructions,
    after: plan.kept,
    onProgress: opts.onProgress,
    signal: opts.signal,
    conversation: opts.conversation,
  });
  if (summary.length < 20) throw new CompactionError('The summary was too short to be trustworthy.');

  const before = estimateMessages(plan.toSummarise);
  const after = estimateMessages([{ role: 'user', content: [{ type: 'text', text: summary }] }]);
  if (after >= before)
    throw new CompactionError('The summary was not smaller than the text it replaces.', false);

  if (opts.signal?.aborted) throw new CompactionError('Compaction was interrupted.', false);
  if (opts.session.leaf !== plan.leaf) {
    throw new CompactionError(
      'The conversation changed while it was being summarised; nothing was modified.',
    );
  }
  opts.session.appendCompaction(opts.appendix ? `${summary}\n\n${opts.appendix}` : summary, plan.firstKeptId);
  return { summary, droppedMessages: plan.toSummarise.length, tokensBefore: before, tokensAfter: after };
}
