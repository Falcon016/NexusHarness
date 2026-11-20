import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/agent/session.js';
import type { Message, StreamRequest } from '../src/llm/types.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { writeTool } from '../src/tools/fs-tools.js';
import { AutoProvider, callTool, makeAgent, say, ScriptedProvider, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
let outputs: string;
beforeEach(() => {
  ws = tmpWorkspace();
  outputs = join(ws.dir, '..', `${ws.dir.split(/[\\/]/).pop()}-outputs`);
  mkdirSync(outputs, { recursive: true });
});
afterEach(() => ws.cleanup());

/** The tool result the model saw for a call. */
const resultOf = (r: StreamRequest, id: string) => {
  for (const m of r.messages as Message[])
    for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId === id) return b.content;
  return undefined;
};

describe('long tool output', () => {
  it('keeps its start and end in the context and saves all of it, readable by the file tools', async () => {
    const script = join(ws.dir, 'noisy.js');
    writeFileSync(
      script,
      "for (let i = 1; i <= 4000; i++) console.log(`log line ${i} ${'x'.repeat(30)}`); console.log('BUILD FAILED: 3 errors');",
    );
    const p = new ScriptedProvider([
      callTool('b1', 'bash', { command: `node "${script}"` }),
      say('Read it.'),
    ]);
    const { agent } = makeAgent(ws.dir, p, { outputDir: outputs });
    await agent.run('build it');

    const seen = resultOf(p.requests[1]!, 'b1')!;
    expect(seen.length).toBeLessThan(26_000);
    expect(seen).toContain('log line 1 '); // the start
    expect(seen).toContain('BUILD FAILED: 3 errors'); // and the end
    const m = /not shown here\. The whole output is saved in (.+?): read it/.exec(seen);
    expect(m).not.toBeNull();
    const saved = m![1]!;
    expect(saved.startsWith(outputs)).toBe(true);
    const full = readFileSync(saved, 'utf8');
    expect(full).toContain('log line 2000 '); // the middle is not lost
    expect(full).toContain('BUILD FAILED');

    // The agent's file tools may read it, never write it.
    const sandbox = new GuardSandbox({ cwd: ws.dir, readOnlyPaths: [outputs] });
    expect(() => sandbox.checkPath(saved, 'read')).not.toThrow();
    expect(() => sandbox.checkPath(saved, 'write')).toThrow(/blocked by the sandbox/);
    expect(() => sandbox.checkPath(join(ws.dir, '..', 'elsewhere.txt'), 'read')).toThrow();
  });

  it('cuts a very long file read at a line and says where to read on', async () => {
    writeFileSync(
      join(ws.dir, 'big.ts'),
      Array.from({ length: 1900 }, (_, i) => `export const value${i} = ${i}; // ${'c'.repeat(20)}`).join(
        '\n',
      ),
    );
    const p = new ScriptedProvider([callTool('r1', 'read', { path: 'big.ts' }), say('ok')]);
    const { agent } = makeAgent(ws.dir, p, { outputDir: outputs });
    await agent.run('read big.ts');
    const seen = resultOf(p.requests[1]!, 'r1')!;
    const m = /read on with offset=(\d+)\]$/.exec(seen);
    expect(m).not.toBeNull();
    const next = Number(m![1]);
    const lastShown = seen.split('\n').at(-2)!;
    expect(lastShown).toMatch(new RegExp(`^\\s*${next - 1}\\t`)); // no line skipped
    expect(seen.length).toBeLessThan(49_000);
  });

  it('leaves outputs that fit alone', async () => {
    const p = new ScriptedProvider([callTool('b1', 'bash', { command: 'echo short' }), say('ok')]);
    const { agent } = makeAgent(ws.dir, p, { outputDir: outputs });
    await agent.run('go');
    expect(resultOf(p.requests[1]!, 'b1')).toMatch(/short/);
    expect(readdirSync(outputs)).toEqual([]); // nothing saved
  });
});

describe('reading the same file again', () => {
  it('points back to an identical earlier read, but never twice in a row, and not after the file changes', async () => {
    writeFileSync(join(ws.dir, 'a.ts'), 'export const a = 1;\n');
    const p = new ScriptedProvider([
      callTool('r1', 'read', { path: 'a.ts' }),
      callTool('r2', 'read', { path: 'a.ts' }), // unchanged: a note
      callTool('r3', 'read', { path: 'a.ts' }), // asked again: the text
      callTool('w1', 'edit', { path: 'a.ts', old_string: '= 1', new_string: '= 2' }),
      callTool('r4', 'read', { path: 'a.ts' }), // changed: the text
      say('done'),
    ]);
    const { agent } = makeAgent(ws.dir, p);
    await agent.run('go');
    const last = p.requests.at(-1)!;
    expect(resultOf(last, 'r1')).toContain('export const a = 1;');
    expect(resultOf(last, 'r2')).toMatch(/unchanged since you read it earlier/);
    expect(resultOf(last, 'r3')).toContain('export const a = 1;');
    expect(resultOf(last, 'r4')).toContain('export const a = 2;');
  });

  it('sends the text again once the earlier read has been compacted away', async () => {
    writeFileSync(join(ws.dir, 'a.ts'), 'export const a = 1;\n');
    const session = Session.create(ws.dir);
    const p = new AutoProvider([callTool('r1', 'read', { path: 'a.ts' }), say('read it')]);
    const { agent } = makeAgent(ws.dir, p, { session });
    await agent.run('read a.ts');
    // Fold everything so far into a summary: the earlier read is no longer in the context.
    session.appendCompaction('Summary: a.ts was read.', session.messageEntries().at(-1)!.id);
    p.main.push(callTool('r2', 'read', { path: 'a.ts' }), say('again'));
    await agent.run('read it again');
    expect(resultOf(p.calls.at(-1)!, 'r2')).toContain('export const a = 1;');
  });
});

describe('writing a whole file to change part of it', () => {
  const ctx = () =>
    ({
      cwd: ws.dir,
      sandbox: new GuardSandbox({ cwd: ws.dir }),
      readState: new Map<string, number>(),
    }) as never;
  const lines = (n: number, change?: number) =>
    Array.from({ length: n }, (_, i) => (i === change ? `changed line ${i}` : `line ${i}`)).join('\n');

  it('says to use edit next time when most of the file was already there', async () => {
    const c = ctx();
    await writeTool.execute({ path: 'f.txt', content: lines(60) }, c);
    const r = await writeTool.execute({ path: 'f.txt', content: lines(60, 30) }, c);
    expect(r.content).toMatch(
      /^Overwrote f\.txt \(\+1 -1\)\. Note: 59 of these 60 lines were already there\./,
    );
    expect(r.content).toContain('use `edit`');
  });

  it('says nothing for a new file, a small file or a real rewrite', async () => {
    const c = ctx();
    expect((await writeTool.execute({ path: 'n.txt', content: lines(60) }, c)).content).not.toContain('Note');
    await writeTool.execute({ path: 's.txt', content: lines(10) }, c);
    expect((await writeTool.execute({ path: 's.txt', content: lines(10, 5) }, c)).content).not.toContain(
      'Note',
    );
    const fresh = Array.from({ length: 60 }, (_, i) => `brand new ${i}`).join('\n');
    expect((await writeTool.execute({ path: 'n.txt', content: fresh }, c)).content).not.toContain('Note');
  });
});
