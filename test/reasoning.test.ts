import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyStats,
  matches,
  samplingFor,
  stepBudget,
  ThinkingBudget,
  watchBudget,
  wrapUpNote,
} from '../src/agent/thinking.js';
import { buildBody, OpenAICompatProvider } from '../src/llm/openai.js';
import type { PROBE_MESSAGES } from '../src/llm/thinking.js';
import { cacheVerdict, detectSwitch, type ThinkingInfo, type ThinkingSwitch } from '../src/llm/thinking.js';
import type { StreamEvent, StreamRequest } from '../src/llm/types.js';
import { AutoProvider, callTool, makeAgent, say, testConfig, tmpWorkspace, type Turn } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

/** Fragments of real chat templates, as llama.cpp serves them on /props. */
const QWEN = `{%- if enable_thinking is defined and enable_thinking is false %}{{- '<think>\\n\\n</think>\\n\\n' }}{%- endif %}`;
const DEEPSEEK = `{%- if thinking %}{{'<think>'}}{%- else %}{{'</think>'}}{%- endif %}`;
const GPT_OSS = `{%- if reasoning_effort is defined %}{{- "Reasoning: " + reasoning_effort }}{%- endif %}<|channel|>`;
const PLAIN = `{%- for message in messages %}{{ message.content }}{%- endfor %}`;

describe("finding each model's reasoning switch", () => {
  it('reads the switch from the chat template', () => {
    expect(detectSwitch(QWEN)).toBe('enable_thinking');
    expect(detectSwitch(DEEPSEEK)).toBe('thinking');
    expect(detectSwitch(GPT_OSS)).toBe('reasoning_effort');
    expect(detectSwitch(PLAIN)).toBe('unknown');
    expect(detectSwitch(undefined)).toBe('unknown');
  });

  it('switches reasoning off the way each template understands', () => {
    const req: StreamRequest = { model: 'm', system: 's', messages: [], tools: [], thinking: false };
    const local = (sw: ThinkingSwitch) => buildBody(req, { templateKwargs: true, switch: sw });
    expect(local('enable_thinking').chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(local('thinking').chat_template_kwargs).toEqual({ thinking: false });
    expect(local('reasoning_effort')).toMatchObject({
      reasoning_effort: 'low',
      chat_template_kwargs: { reasoning_effort: 'low' },
    });
    expect(local('unknown').chat_template_kwargs).toEqual({ enable_thinking: false, thinking: false });
    // OpenAI's own API is never sent template fields.
    expect(buildBody(req)).not.toHaveProperty('chat_template_kwargs');
  });

  it('tells whether switching keeps the cached conversation', () => {
    const conv = 'system...user: Thanks. zq-cache-check-7f3a<|im_end|>\n<|im_start|>assistant\n';
    expect(cacheVerdict(conv, `${conv}<think>\n\n</think>\n\n`)).toBe('safe');
    expect(cacheVerdict(conv.replace('system', 'SYSTEM'), conv)).toBe('unsafe');
    expect(cacheVerdict(conv, conv)).toBe('unverified');
    expect(cacheVerdict(undefined, conv)).toBe('unverified');
  });

  it('asks a llama.cpp server once per model: its template, the cache check, its sampling default', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = new URL(u);
      seen.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/props')
        return Response.json({
          chat_template: QWEN + '<think>',
          default_generation_settings: { params: { temperature: 0 } },
        });
      if (url.pathname === '/apply-template') {
        const body = JSON.parse(String(init?.body)) as {
          messages: typeof PROBE_MESSAGES;
          chat_template_kwargs?: unknown;
        };
        const base = body.messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:';
        return Response.json({ prompt: body.chat_template_kwargs ? `${base}<think>\n\n</think>` : base });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ id: 'llamacpp', baseUrl: 'http://x/v1', fetchImpl });
    const info = await p.thinkingInfo('qwen3.8-27b');
    expect(info).toEqual({ switch: 'enable_thinking', cache: 'safe', reasons: true, temperature: 0 });
    await p.thinkingInfo('qwen3.8-27b');
    expect(seen.filter((x) => x === 'GET /props')).toHaveLength(1);
  });
});

describe('budgets', () => {
  const cfg = { mode: 'adaptive' as const, routineBudget: 1024, keyBudget: 8192 };

  it('gives key steps more room than routine ones, and /effort scales the key steps only', () => {
    expect(stepBudget(cfg, undefined, 'enable_thinking', 'new message')).toMatchObject({
      tokens: 8192,
      key: true,
    });
    expect(stepBudget(cfg, undefined, 'enable_thinking', undefined)).toMatchObject({
      tokens: 1024,
      key: false,
    });
    expect(stepBudget(cfg, 'low', 'enable_thinking', 'new message').tokens).toBe(4096);
    expect(stepBudget(cfg, 'xhigh', 'enable_thinking', undefined).tokens).toBe(1024); // routine stays quick
    expect(stepBudget(cfg, 'xhigh', 'enable_thinking', 'error').tokens).toBe(32768);
    expect(stepBudget({ ...cfg, keyBudget: -1 }, undefined, 'unknown', 'loop').tokens).toBeUndefined();
    expect(stepBudget({ ...cfg, routineBudget: 0 }, undefined, 'unknown', undefined).tokens).toBe(0);
  });

  it('changes nothing in "always" unless /effort is set, and leaves real effort levels to the model', () => {
    const always = { ...cfg, mode: 'always' as const };
    expect(stepBudget(always, undefined, 'enable_thinking', undefined).tokens).toBeUndefined();
    expect(stepBudget(always, 'medium', 'enable_thinking', undefined).tokens).toBe(8192);
    expect(stepBudget(always, 'low', 'reasoning_effort', undefined).tokens).toBeUndefined(); // gpt-oss has its own
    expect(stepBudget({ ...cfg, mode: 'never' }, 'xhigh', 'enable_thinking', 'error').tokens).toBe(0);
  });

  it('stops reasoning that runs past its budget, but never an answer already under way', async () => {
    const events = (parts: StreamEvent[]) =>
      (async function* () {
        yield* parts;
      })();
    let stopped = 0;
    const long = 'x'.repeat(4 * 120);
    await expect(
      (async () => {
        for await (const _ of watchBudget(events([{ type: 'thinking', delta: long }]), 100, () => stopped++));
      })(),
    ).rejects.toBeInstanceOf(ThinkingBudget);
    expect(stopped).toBe(1);
    // Reasoning after the answer began (some models interleave) is not cut.
    const after: StreamEvent[] = [
      { type: 'text', delta: 'Answer' },
      { type: 'thinking', delta: long },
    ];
    const seen: StreamEvent[] = [];
    for await (const e of watchBudget(events(after), 100, () => stopped++)) seen.push(e);
    expect(seen).toHaveLength(2);
  });

  it('hands the model the end of its own reasoning, from a sentence start', () => {
    const reasoning = 'First I list the files. '.repeat(80) + 'So the bug is in parse(). I will fix line 12.';
    const note = wrapUpNote(new ThinkingBudget(reasoning, 512));
    expect(note).toMatch(/^\[Reasoning budget\] You reasoned for about \d+ tokens/);
    expect(note).toContain('So the bug is in parse(). I will fix line 12.');
    expect(note).toContain('without starting the reasoning over');
    expect(note.length).toBeLessThan(3000);
  });
});

describe('sampling per model', () => {
  it('matches patterns and merges them in order', () => {
    expect(matches('llamacpp/qwen*', 'llamacpp/qwen3.8-27b')).toBe(true);
    expect(matches('*gemma*', 'mini/gemma-4-12b')).toBe(true);
    expect(matches('llamacpp/qwen*', 'mini/qwen3-4b')).toBe(false);
    expect(
      samplingFor(
        { '*': { temperature: 0.7 }, '*qwen*': { temperature: 0.6, top_k: 20 } },
        'llamacpp/qwen3.8-27b',
      ),
    ).toEqual({ temperature: 0.6, top_k: 20 });
  });

  it('sends the local-server extensions only to local servers', () => {
    const req: StreamRequest = {
      model: 'm',
      system: 's',
      messages: [],
      tools: [],
      sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1 },
    };
    expect(buildBody(req, { templateKwargs: true })).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 1,
    });
    const openai = buildBody(req);
    expect(openai).toMatchObject({ temperature: 0.6, top_p: 0.95 });
    expect(openai).not.toHaveProperty('top_k');
    expect(openai).not.toHaveProperty('presence_penalty');
  });
});

/** A local model server: scripted replies, and what its template says about reasoning. */
class LocalModel extends AutoProvider {
  infoCalls = 0;
  constructor(
    turns: Turn[],
    private info: ThinkingInfo = { switch: 'enable_thinking', cache: 'safe', reasons: true },
  ) {
    super(turns);
  }
  async thinkingInfo(): Promise<ThinkingInfo> {
    this.infoCalls++;
    return this.info;
  }
}

/** Reasoning of about `chars` characters that never repeats itself (repeats are loop detection's job). */
const reasoningThen = (chars: number, then: Turn): Turn => {
  const rest = typeof then === 'function' ? undefined : then;
  const parts: StreamEvent[] = [];
  for (let i = 0, n = 0; n < chars; i++) {
    const delta = `Step ${i}: weigh option ${(i * 7919) % 1000} against ${(i * 104729) % 997}. `;
    parts.push({ type: 'thinking', delta });
    n += delta.length;
  }
  return () => [...parts, ...(rest ?? [])];
};

describe('adaptive reasoning in the agent', () => {
  it('reasons on the steps that need it and not on routine ones', async () => {
    const p = new LocalModel([
      callTool('a', 'ls', {}), // step 1: a new message, a key step
      callTool('b', 'read', { path: 'missing.txt' }), // step 2: routine (ls went fine)
      callTool('c', 'ls', {}), // step 3: after an error, a key step
      say('Done.'), // step 4: routine
    ]);
    const { agent } = makeAgent(ws.dir, p, {
      config: { reasoning: { mode: 'adaptive', routineBudget: 0, keyBudget: 8192 } },
    });
    await agent.run('look around');
    expect(p.calls.map((r) => r.thinking ?? 'on')).toEqual(['on', false, 'on', false]);
    expect(agent.thinkingStats).toMatchObject({ requests: 4, key: 2, off: 2 });
  });

  it('wraps up a step that reasons past its budget, and carries on from where it got', async () => {
    let wrapUp = '';
    const p = new LocalModel([
      reasoningThen(4000, say('never shown: this reply was stopped')),
      (req: StreamRequest) => {
        wrapUp = JSON.stringify(req.messages.at(-1));
        return say('Fixed parse() at line 12.');
      },
    ]);
    const { agent, events, session } = makeAgent(ws.dir, p, {
      config: { reasoning: { mode: 'adaptive', routineBudget: 1024, keyBudget: 256 } },
    });
    await agent.run('fix the bug');
    expect(p.calls[0]!.signal!.aborted).toBe(true); // the server was told to stop
    expect(p.calls[1]!.thinking).toBe(false);
    expect(wrapUp).toContain('[Reasoning budget] You reasoned for about');
    expect(agent.thinkingStats.wrapped).toBe(1);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(session.messages().at(-1)!.content[0]).toMatchObject({ text: 'Fixed parse() at line 12.' });
    // Told once, not on every wrap-up.
    expect(events.filter((e) => e.type === 'status' && /wrapped up at its budget/.test(e.text))).toHaveLength(
      1,
    );
  });

  it('does not wrap up twice: a model that ignores the switch finishes its reasoning', async () => {
    const p = new LocalModel(
      [reasoningThen(4000, say('x')), reasoningThen(4000, say('Answer after all that.'))],
      { switch: 'unknown', cache: 'unverified' },
    );
    const { agent, session } = makeAgent(ws.dir, p, {
      config: { reasoning: { mode: 'adaptive', routineBudget: 256, keyBudget: 256 } },
    });
    await agent.run('go');
    expect(agent.thinkingStats.wrapped).toBe(1);
    expect(
      session
        .messages()
        .at(-1)!
        .content.find((b) => b.type === 'text'),
    ).toMatchObject({
      text: 'Answer after all that.',
    });
  });

  it('changes nothing by default: no template check, no reasoning switch, no budget', async () => {
    const p = new LocalModel([reasoningThen(40_000, say('A long think, as before.'))]);
    const { agent, session } = makeAgent(ws.dir, p);
    await agent.run('go');
    expect(p.infoCalls).toBe(0);
    expect(p.calls[0]!.thinking).toBeUndefined();
    expect(agent.thinkingStats.wrapped).toBe(0);
    expect(
      session
        .messages()
        .at(-1)!
        .content.find((b) => b.type === 'text'),
    ).toMatchObject({
      text: 'A long think, as before.',
    });
  });

  it('warns once when a reasoning model is sampled almost greedily', async () => {
    const p = new LocalModel([say('a'), say('b')], {
      switch: 'enable_thinking',
      cache: 'safe',
      reasons: true,
      temperature: 0,
    });
    const { agent, events } = makeAgent(ws.dir, p, {
      config: { reasoning: { ...testConfig().reasoning, mode: 'adaptive' } },
    });
    await agent.run('one');
    await agent.run('two');
    expect(events.filter((e) => e.type === 'status' && /sampled almost greedily/.test(e.text))).toHaveLength(
      1,
    );
  });

  it('sends the configured sampling for the model', async () => {
    const p = new LocalModel([say('ok')]);
    const { agent } = makeAgent(ws.dir, p, {
      config: { sampling: { '*': { temperature: 0.6, top_k: 20 } } },
    });
    await agent.run('go');
    expect(p.calls[0]!.sampling).toEqual({ temperature: 0.6, top_k: 20 });
    expect(emptyStats()).toEqual({ requests: 0, off: 0, wrapped: 0, reasoningTokens: 0, key: 0 });
  });
});
