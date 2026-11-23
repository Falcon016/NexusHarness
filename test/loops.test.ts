import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionWatch, ARGS_RULE, findRepeat, isLoopNote, LOOP_NOTE, PROSE_RULE } from '../src/agent/loops.js';
import { buildBody } from '../src/llm/openai.js';
import type { StreamEvent, StreamRequest } from '../src/llm/types.js';
import { todoTool } from '../src/tools/misc.js';
import { AutoProvider, callTool, makeAgent, say, standardTools, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

/** A passage of the kind a stuck model repeats. */
const PASSAGE =
  'Wait, let me reconsider the layout of the brain mesh before I write the shader again, because the ' +
  'normals might be inverted on the left hemisphere. ';
const INTRO = 'I will set up the scene first, then wire the HUD.\n\n';

/** A reply streamed a few characters at a time, as a server sends it. */
function streamed(kind: 'text' | 'thinking', body: string, size = 40): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (let i = 0; i < body.length; i += size) out.push({ type: kind, delta: body.slice(i, i + size) });
  return out;
}
const done = (stopReason: 'end_turn' | 'tool_use' = 'end_turn'): StreamEvent[] => [
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'done', stopReason },
];
const notes = (events: { type: string }[]) =>
  events.filter((e) => e.type === 'status').map((e) => (e as unknown as { text: string }).text);

describe('repetition while writing', () => {
  it('finds a passage repeated at the end, and where the copies after the first begin', () => {
    const s = INTRO + PASSAGE.repeat(5);
    const r = findRepeat(s, PROSE_RULE);
    expect(r).toMatchObject({ period: PASSAGE.length, reps: 5 });
    expect(s.slice(0, r!.start)).toBe(INTRO + PASSAGE);
  });

  it('leaves ordinary writing and code alone, repeated lines and all', () => {
    const prose = Array.from({ length: 40 }, (_, i) => `Step ${i}: check item ${i * 7} and note it.`).join(
      ' ',
    );
    expect(findRepeat(prose, PROSE_RULE)).toBeUndefined();
    const code = Array.from(
      { length: 60 },
      (_, i) => `  if (x === ${i}) {\n    return handle(${i});\n  }\n`,
    ).join('');
    expect(findRepeat(code, PROSE_RULE)).toBeUndefined();
    // Two copies is a coincidence, not a loop.
    expect(findRepeat(INTRO + PASSAGE.repeat(2), PROSE_RULE)).toBeUndefined();
    // A table rule or a few identical rows in a file are fine; thousands of characters of them are not.
    expect(findRepeat('| a | b |\n'.repeat(30), ARGS_RULE)).toBeUndefined();
    expect(
      findRepeat(`{"content":"${'row,1,2,3,4,5,6,7,8,9,10,11,12,13\\n'.repeat(200)}`, ARGS_RULE),
    ).toBeDefined();
  });

  it('stops a reply that repeats itself, keeps what came before, and carries on', async () => {
    let first: StreamRequest | undefined;
    const p = new AutoProvider([
      (req) => {
        first = req;
        return [...streamed('text', INTRO + PASSAGE.repeat(40)), ...done()];
      },
      say('The scene is set up and the HUD is wired.'),
    ]);
    const { agent, events, session } = makeAgent(ws.dir, p);
    await agent.run('build the brain scene');

    expect(first!.signal!.aborted).toBe(true); // the server was told to stop generating
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(notes(events).join('\n')).toMatch(/Loop stopped: the model started repeating itself in its reply/);
    const msgs = session.messages();
    const kept = msgs.find((m) => m.role === 'assistant')!;
    expect(kept.content).toEqual([{ type: 'text', text: (INTRO + PASSAGE).trimEnd() }]);
    const note = msgs[2]!.content[0]!;
    expect(note.type === 'text' && isLoopNote(note.text)).toBe(true);
    // The next request knows what happened and discourages repeating; then the turn ends as usual.
    expect(p.calls[1]!.antiRepeat).toBe(1);
    expect(p.calls[1]!.thinking).toBeUndefined();
    expect(msgs.at(-1)!.content[0]).toMatchObject({ text: 'The scene is set up and the HUD is wired.' });
    // The cut reply is reported with what was kept, so the screen does not keep the repeats.
    expect(events.find((e) => e.type === 'assistant')).toMatchObject({ cut: true });
  });

  it('asks for no reasoning on the retry when the reasoning went round in circles', async () => {
    const p = new AutoProvider([[...streamed('thinking', PASSAGE.repeat(30)), ...done()], say('Done.')]);
    const { agent, session } = makeAgent(ws.dir, p);
    await agent.run('go');
    expect(p.calls[1]).toMatchObject({ thinking: false, antiRepeat: 1 });
    // Nothing worth keeping was written, so only the note was added.
    const roles = session.messages().map((m) => m.role);
    expect(roles).toEqual(['user', 'user', 'assistant']);
    expect(JSON.stringify(session.messages()[1])).toContain('going round in circles');
  });

  it('discourages repeating more firmly each time it happens in a row, and never gives up', async () => {
    const looping = () => [...streamed('text', INTRO + PASSAGE.repeat(40)), ...done()];
    const p = new AutoProvider([looping(), looping(), looping(), looping(), say('Finally done.')]);
    const { agent, events, session } = makeAgent(ws.dir, p);
    await agent.run('go');
    expect(p.calls.map((r) => r.antiRepeat)).toEqual([undefined, 1, 2, 3, 3]);
    expect(p.calls[3]!.thinking).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(session.messages().at(-1)!.content[0]).toMatchObject({ text: 'Finally done.' });
  });

  it('stops a file being written over and over without writing it, and lets the model write it again', async () => {
    const big = {
      path: 'data.txt',
      content: 'the same line of generated text, again and again\n'.repeat(400),
    };
    const p = new AutoProvider([
      callTool('w1', 'write', big),
      callTool('w2', 'write', { path: 'data.txt', content: 'one line\n' }),
      say('Written.'),
    ]);
    // The arguments arrive in pieces, as they do from a server.
    const json = JSON.stringify(big);
    p.main[0] = [
      { type: 'tool_call_start', id: 'w1', name: 'write' },
      ...Array.from({ length: Math.ceil(json.length / 100) }, (_, i) => ({
        type: 'tool_call_delta' as const,
        id: 'w1',
        json: json.slice(i * 100, i * 100 + 100),
      })),
      ...done('tool_use'),
    ];
    const { agent, events } = makeAgent(ws.dir, p, { mode: 'auto' });
    await agent.run('write the data file');
    expect(notes(events).join('\n')).toMatch(/repeating itself in a write call \(data\.txt\)/);
    expect(JSON.stringify(p.calls[1]!.messages)).toContain('nothing was run or written');
    expect(existsSync(join(ws.dir, 'data.txt'))).toBe(true); // the second, sensible write
  });
});

describe('repeated actions', () => {
  const ok = { content: 'Error: Cannot find module ./brain.js' };

  it('notices the same call with the same result three times in a row, and every time after', () => {
    const w = new ActionWatch();
    expect(w.observe('bash', { command: 'npm test' }, ok)).toBeUndefined();
    expect(w.observe('bash', { command: 'npm test' }, ok)).toBeUndefined();
    expect(w.observe('bash', { command: 'npm test' }, ok)).toMatchObject({
      kind: 'cycle',
      period: 1,
      strike: 1,
    });
    expect(w.observe('bash', { command: 'npm test' }, ok)).toMatchObject({ strike: 2 });
    expect(w.observe('bash', { command: 'npm test' }, ok)).toMatchObject({ strike: 3 });
  });

  it('does not count waiting for something to change, or the same call in different order of keys', () => {
    const w = new ActionWatch();
    for (let i = 0; i < 6; i++)
      expect(w.observe('bash', { command: 'curl localhost:3000' }, { content: `try ${i}` })).toBeUndefined();
    const v = new ActionWatch();
    v.observe('read', { path: 'a', limit: 5 }, ok);
    v.observe('read', { limit: 5, path: 'a' }, ok);
    expect(v.observe('read', { path: 'a', limit: 5 }, ok)).toMatchObject({ kind: 'cycle', period: 1 });
  });

  it('notices a cycle of a few calls, and a result that keeps coming back despite the work in between', () => {
    const w = new ActionWatch();
    const round = () => [
      w.observe('edit', { path: 'a.js', old_string: 'x', new_string: 'y' }, { content: 'Edited' }),
      w.observe('edit', { path: 'a.js', old_string: 'y', new_string: 'x' }, { content: 'Edited' }),
    ];
    round();
    round();
    expect(round()[1]).toMatchObject({ kind: 'cycle', period: 2, count: 3 });

    const v = new ActionWatch();
    let last;
    for (let i = 0; i < 4; i++) {
      v.observe('edit', { path: 'a.js', new_string: `attempt ${i}` }, { content: 'Edited' });
      last = v.observe('bash', { command: 'npm test' }, ok);
    }
    expect(last).toMatchObject({ kind: 'repeat', count: 4 });
  });

  it('forgets a loop once the model has moved on', () => {
    const w = new ActionWatch();
    for (let i = 0; i < 4; i++) w.observe('ls', {}, ok);
    for (let i = 0; i < 8; i++) w.observe('read', { path: `f${i}` }, { content: `file ${i}` });
    for (let i = 0; i < 2; i++) w.observe('grep', { pattern: 'x' }, ok);
    expect(w.observe('grep', { pattern: 'x' }, ok)).toMatchObject({ strike: 1 });
  });

  it('tells the model in the result each time round, names its task, and never stops the work', async () => {
    writeFileSync(join(ws.dir, 'brain.js'), 'export const mesh = null;\n');
    const read = () => callTool(`r${Math.random()}`, 'read', { path: 'brain.js' });
    const p = new AutoProvider([
      callTool('t', 'todo_write', { todos: [{ content: 'Build brain scene', status: 'in_progress' }] }),
      read(),
      read(),
      read(),
      read(),
      read(),
      callTool('t2', 'todo_write', { todos: [{ content: 'Build brain scene', status: 'completed' }] }),
      say('The scene is built.'),
    ]);
    const { agent, events, session } = makeAgent(ws.dir, p, {
      tools: standardTools().register(todoTool),
      config: { maxToolIterations: 5 },
    });
    await agent.run('build it');

    const results = session
      .messages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? b.content : ''));
    const reads = results.slice(1, 6);
    expect(reads.slice(0, 2).every((r) => !r.includes(LOOP_NOTE))).toBe(true);
    expect(reads[2]).toContain('this exact call 3 times in a row');
    expect(reads[2]).toContain('("Build brain scene")');
    expect(reads[2]).toContain('do not skip it');
    expect(reads[3]).toContain('(Reminder 2.)');
    expect(reads[4]).toContain('(Reminder 3.)');
    expect(notes(events).filter((t) => t.startsWith('Loop:'))).toHaveLength(3);
    // Eight requests against a limit of five: the three spent going round the loop did not count.
    expect(notes(events).join('\n')).not.toMatch(/Stopped after/);
    expect(session.messages().at(-1)!.content[0]).toMatchObject({ text: 'The scene is built.' });
  });

  it('can be turned off', async () => {
    const p = new AutoProvider([
      ...Array.from({ length: 4 }, (_, i) => callTool(`r${i}`, 'ls', {})),
      say('ok'),
    ]);
    const { agent, session } = makeAgent(ws.dir, p, { config: { loopDetection: false } });
    await agent.run('go');
    expect(JSON.stringify(session.messages())).not.toContain(LOOP_NOTE);
  });
});

describe('the request after a loop', () => {
  const req: StreamRequest = {
    model: 'm',
    system: 's',
    messages: [],
    tools: [],
    antiRepeat: 2,
    thinking: false,
  };
  it('asks a local server for less repetition and no reasoning', () => {
    expect(buildBody(req, { templateKwargs: true })).toMatchObject({
      presence_penalty: 1,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
  it("sends OpenAI's own API neither, since its reasoning models refuse them", () => {
    const body = buildBody(req);
    expect(body).not.toHaveProperty('presence_penalty');
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });
});
