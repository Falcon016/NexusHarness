import { mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findSession,
  listSessions,
  searchSessions,
  transcript,
  type HistorySource,
} from '../src/agent/history.js';
import { Session } from '../src/agent/session.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { sessionsTool } from '../src/tools/sessions.js';
import type { ToolContext } from '../src/tools/types.js';
import { tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
let src: HistorySource;
let current: string | undefined;
const dir = () => join(src.root, src.project);

/** A saved conversation: a request, a tool call and its result, a reply. `age` in minutes sets its mtime. */
function conversation(
  prompt: string,
  opts: { reply?: string; tool?: string; age?: number; later?: string } = {},
) {
  const s = Session.create('/work/app', dir());
  s.append({ role: 'user', content: [{ type: 'text', text: prompt }] });
  s.append({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } },
    ],
  });
  s.append({
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: 't1', content: opts.tool ?? 'ok, 12 tests passed' }],
  });
  s.append({ role: 'assistant', content: [{ type: 'text', text: opts.reply ?? 'Done.' }] });
  if (opts.later) s.append({ role: 'user', content: [{ type: 'text', text: opts.later }] });
  const t = new Date(Date.now() - (opts.age ?? 0) * 60_000);
  utimesSync(s.filePath!, t, t);
  return s;
}

const ctx = (): ToolContext =>
  ({
    cwd: ws.dir,
    signal: new AbortController().signal,
    sandbox: new GuardSandbox({ cwd: ws.dir }),
    history: src,
    progress: () => {},
  }) as unknown as ToolContext;
const run = (input: Record<string, unknown>) => sessionsTool.execute(input as never, ctx());

beforeEach(() => {
  ws = tmpWorkspace();
  current = undefined;
  src = { root: join(ws.dir, 'sessions'), project: 'abc123', currentFile: () => current };
  mkdirSync(dir(), { recursive: true });
});
afterEach(() => ws.cleanup());

describe('saved conversations', () => {
  it('lists them newest first with their first and last request, the one in use marked', () => {
    conversation('fix the login bug', { age: 60, later: 'now add a test for it' });
    const b = conversation('write the release notes', { age: 5 });
    current = b.filePath;
    const list = listSessions(src);
    expect(list.map((s) => s.first)).toEqual(['write the release notes', 'fix the login bug']);
    expect(list[1]).toMatchObject({ last: 'now add a test for it', current: false, cwd: '/work/app' });
    expect(list[0]!.current).toBe(true);
  });

  it('reads the first request even when it is longer than the part of the file read for the list', () => {
    conversation(`summarise this: ${'x'.repeat(100_000)}`);
    expect(listSessions(src)[0]!.first).toMatch(/^summarise this: x+…$/);
    expect(Session.list(dir())[0]!.preview).toMatch(/^summarise this/);
  });

  it('finds one by id, prefix, latest (not the one in use) or current, and never by path', () => {
    const a = conversation('first', { age: 30 });
    const b = conversation('second', { age: 1 });
    current = b.filePath;
    expect(findSession(src, 'latest')).toEqual({ file: a.filePath });
    expect(findSession(src, 'current')).toEqual({ file: b.filePath });
    expect(findSession(src, a.id)).toEqual({ file: a.filePath });
    expect(findSession(src, a.id.slice(0, 10))).toEqual({ file: a.filePath });
    expect(findSession(src, '../../etc/passwd')).toHaveProperty('error');
    expect(findSession(src, '')).toHaveProperty('error'); // matches both: ambiguous
  });

  it('turns a conversation into a transcript: prompts, replies with tool calls, results and summaries', () => {
    const s = conversation('fix the login bug');
    s.appendCompaction('We fixed the login bug in auth.ts.', s.messageEntries().at(-1)!.id);
    const t = transcript(s.filePath!);
    expect(t.map((e) => e.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'summary']);
    expect(t[1]!.text).toContain('→ bash: npm test');
    expect(t[2]!.text).toBe('bash: ok, 12 tests passed');
    expect(t[4]!.text).toContain('We fixed the login bug in auth.ts.');
  });

  it('searches every word across conversations, tool output included, and exact phrases in quotes', () => {
    conversation('deploy the app', { tool: 'Error: ECONNREFUSED 127.0.0.1:5432', age: 10 });
    conversation('tidy the docs', { age: 2 });
    const { hits } = searchSessions(src, 'econnrefused 5432');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ role: 'tool', n: 3 });
    expect(hits[0]!.snippet).toContain('ECONNREFUSED 127.0.0.1:5432');
    expect(searchSessions(src, '"the docs"').hits.map((h) => h.n)).toEqual([1]);
    expect(searchSessions(src, '"docs the"').hits).toEqual([]);
  });
});

describe('the sessions tool', () => {
  it('lists, searches and reads, wrapping saved text as data', async () => {
    const a = conversation('fix the login bug', { reply: 'Fixed it in auth.ts.' });
    const list = await run({ action: 'list' });
    expect(list.content).toContain(a.id);
    expect(list.content).toContain('first: fix the login bug');
    expect(list.content).toMatch(/^<untrusted_content source="saved sessions">/);

    const found = await run({ action: 'search', query: 'auth.ts' });
    expect(found.content).toContain(`${a.id} #4 assistant`);

    const read = await run({ action: 'read', id: a.id });
    expect(read.content).toContain(`Conversation ${a.id}: entries 1–4 of 4.`);
    expect(read.content).toContain('#4 assistant');
    expect(read.content).toContain('Fixed it in auth.ts.');
  });

  it('reads the end by default and pages with offset', async () => {
    const s = Session.create('/work/app', dir());
    for (let i = 1; i <= 60; i++)
      s.append({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `message ${i}` }] });
    const end = await run({ action: 'read', id: 'latest', limit: 10 });
    expect(end.content).toContain('entries 51–60 of 60. Earlier entries: offset 1 to 50.');
    expect(end.content).not.toContain('message 50\n');
    const start = await run({ action: 'read', id: 'latest', offset: 1, limit: 5 });
    expect(start.content).toContain('entries 1–5 of 60');
    expect(start.content).toContain('message 5');
    expect(start.content).not.toContain('message 6');
  });

  it('hides secrets that were saved in a conversation', async () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwx1234567890';
    process.env.TEST_SESSIONS_API_KEY = secret;
    try {
      conversation('use this key', { tool: `API_KEY=${secret}` });
      const read = await run({ action: 'read', id: 'latest' });
      expect(read.content).not.toContain(secret);
    } finally {
      delete process.env.TEST_SESSIONS_API_KEY;
    }
  });

  it('says so plainly when there is nothing, or no such conversation', async () => {
    expect((await run({ action: 'list' })).content).toBe('No saved conversations yet.');
    expect(await run({ action: 'read', id: 'nope' })).toMatchObject({ isError: true });
    expect(await run({ action: 'search' })).toMatchObject({ isError: true });
  });

  it('covers every folder with scope "all"', async () => {
    conversation('here');
    const other: HistorySource = { ...src, project: 'zzz999' };
    mkdirSync(join(src.root, other.project), { recursive: true });
    const s = Session.create('/work/other', join(src.root, other.project));
    s.append({ role: 'user', content: [{ type: 'text', text: 'over there' }] });
    expect((await run({ action: 'list' })).content).not.toContain('over there');
    const all = await run({ action: 'list', scope: 'all' });
    expect(all.content).toContain('over there');
    expect(all.content).toContain('folder: /work/other');
  });
});
