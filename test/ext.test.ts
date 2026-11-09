import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadExtensions, loadPromptTemplates } from '../src/ext/extensions.js';
import { connectMcp } from '../src/ext/mcp.js';
import { BUILTIN_SKILLS_DIR, SkillStore } from '../src/ext/skills.js';
import { skillTool } from '../src/tools/misc.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { testConfig, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const ctx = () => ({
  cwd: ws.dir,
  sandbox: new GuardSandbox({ cwd: ws.dir }),
  signal: new AbortController().signal,
  readState: new Map(),
  progress() {},
  config: testConfig(),
  agentId: 't',
});

describe('extensions', () => {
  it('loads a TypeScript extension: tools, commands and hooks', async () => {
    const dir = join(ws.dir, 'ext');
    mkdirSync(dir);
    copyFileSync(resolve('examples/extensions/protect-lockfiles.ts'), join(dir, 'protect-lockfiles.ts'));
    writeFileSync(join(dir, 'broken.js'), 'export default 42;');

    const ext = await loadExtensions([dir], ws.dir, testConfig());
    expect(ext.loaded).toHaveLength(1);
    expect(ext.warnings.join(' ')).toMatch(/broken\.js.*no default export/);
    expect(ext.tools.map((t) => t.name)).toEqual(['word_count']);
    expect(ext.commands.map((c) => c.name)).toEqual(['todo-scan']);

    const blocked = await ext.hooks.beforeTool!({
      agentId: 'a',
      name: 'write',
      input: { path: 'package-lock.json', content: '' },
    });
    expect(blocked).toEqual({ block: expect.stringContaining('Lockfiles') });
    expect(
      await ext.hooks.beforeTool!({ agentId: 'a', name: 'write', input: { path: 'src/a.ts' } }),
    ).toBeUndefined();

    const r = await ext.tools[0]!.execute({ text: 'one two  three' } as never, ctx());
    expect(r.content).toBe('3');
  });

  it('loads skills and expands prompt templates', () => {
    const skills = join(ws.dir, 'skills', 'deploy');
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      join(skills, 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy the app\n---\nRun the script.\n',
    );
    mkdirSync(join(ws.dir, 'skills', 'bad'));
    writeFileSync(join(ws.dir, 'skills', 'bad', 'SKILL.md'), 'no front matter');
    const store = new SkillStore();
    const warnings = store.load([join(ws.dir, 'skills')]);
    expect(store.names()).toEqual(['deploy']);
    expect(store.get('deploy')).toContain('Run the script.');
    expect(warnings.join(' ')).toMatch(/no description/);

    const prompts = join(ws.dir, 'prompts');
    mkdirSync(prompts);
    writeFileSync(
      join(prompts, 'review.md'),
      '---\ndescription: Review a file\n---\nReview $1 focusing on: $ARGUMENTS',
    );
    const [cmd] = loadPromptTemplates([prompts]);
    let sent = '';
    cmd!.run('src/a.ts security', { cwd: ws.dir, prompt: (t) => (sent = t), notify() {} });
    expect(cmd!.description).toBe('Review a file');
    expect(sent).toBe('Review src/a.ts focusing on: src/a.ts security');
  });
});

describe('built-in skills', () => {
  it('ship with the harness, load first, and give way to a user skill of the same name', () => {
    const store = new SkillStore();
    const warnings = store.load([{ dir: BUILTIN_SKILLS_DIR, source: 'built-in' }]);
    expect(warnings).toEqual([]);
    expect(store.names().sort()).toEqual([
      'debugging',
      'documents',
      'frontend-design',
      'init',
      'it-admin',
      'mcp-builder',
      'pr-review',
      'pre-commit-review',
      'python-env',
      'resume-work',
      'security-review',
      'simplify',
      'skill-creator',
      'webapp-testing',
    ]);
    for (const s of store.list()) {
      expect(s.source).toBe('built-in');
      expect(s.path.replaceAll('\\', '/')).toContain(`/${s.name}/SKILL.md`); // the name matches its folder
      // Every description sits in every system prompt: keep them short.
      expect(s.description.length).toBeLessThan(350);
      expect(s.description.length).toBeGreaterThan(40); // the model picks skills by their description
      expect(s.body).toMatch(/## Report/); // each ends with what to tell the user
    }

    const mine = join(ws.dir, 'my-skills', 'security-review');
    mkdirSync(mine, { recursive: true });
    writeFileSync(
      join(mine, 'SKILL.md'),
      '---\nname: security-review\ndescription: My own checklist\n---\nMine.',
    );
    store.load([
      { dir: BUILTIN_SKILLS_DIR, source: 'built-in' },
      { dir: join(ws.dir, 'my-skills'), source: 'user' },
    ]);
    expect(store.get('security-review')).toContain('Mine.');
    expect(store.list().find((s) => s.name === 'security-review')!.source).toBe('user');
  });
});

describe('skill files', () => {
  it("lists a skill's other files when it loads and reads them on request, never outside its folder", async () => {
    const dir = join(ws.dir, 'skills', 'ops');
    mkdirSync(join(dir, 'playbooks'), { recursive: true });
    mkdirSync(join(dir, '.git'));
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: ops\ndescription: Ops runbooks for the team\n---\nRead a playbook.',
    );
    writeFileSync(join(dir, 'playbooks', 'dns.md'), '# DNS\nCheck the resolver.');
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
    writeFileSync(join(ws.dir, 'secret.txt'), 'top secret');
    const store = new SkillStore();
    store.load([{ dir: join(ws.dir, 'skills'), source: 'user' }]);

    expect(store.files('ops')).toEqual(['playbooks/dns.md']);
    const body = store.get('ops')!;
    expect(body).toContain('Read a playbook.');
    expect(body).toContain('- playbooks/dns.md');
    expect(store.file('ops', 'playbooks/dns.md')).toEqual({ text: '# DNS\nCheck the resolver.' });
    for (const bad of ['../../secret.txt', join(ws.dir, 'secret.txt'), 'playbooks/../../../secret.txt'])
      expect(store.file('ops', bad)).toHaveProperty('error');
    expect(store.file('ops', 'nope.md')).toEqual({
      error: 'No file "nope.md" in skill ops. It has: playbooks/dns.md',
    });

    // Through the tool, as the agent uses it.
    const skills = {
      get: (n: string) => store.get(n),
      names: () => store.names(),
      file: (n: string, p: string) => store.file(n, p),
    };
    const read = await skillTool.execute({ name: 'ops', file: 'playbooks/dns.md' }, {
      ...ctx(),
      skills,
    } as never);
    expect(read.content).toBe('# DNS\nCheck the resolver.');
    const out = await skillTool.execute({ name: 'ops', file: '../../secret.txt' }, {
      ...ctx(),
      skills,
    } as never);
    expect(out).toMatchObject({ isError: true });
    expect(out.content).not.toContain('top secret');
  });

  it('ships the IT admin playbooks and scripts with the skill', () => {
    const store = new SkillStore();
    store.load([{ dir: BUILTIN_SKILLS_DIR, source: 'built-in' }]);
    const files = store.files('it-admin');
    expect(files).toEqual(
      expect.arrayContaining(['scripts/snapshot.sh', 'scripts/snapshot.ps1', 'playbooks/network.md']),
    );
    // Every playbook the index names exists.
    const index = store.get('it-admin')!;
    for (const m of index.matchAll(/`(playbooks\/[a-z-]+\.md)`/g)) expect(files).toContain(m[1]);
    // And every format the documents skill points at.
    for (const f of ['pdf', 'docx', 'xlsx', 'pptx'])
      expect(store.files('documents')).toContain(`formats/${f}.md`);
  });
});

describe('MCP client', () => {
  it('connects over stdio, namespaces tools, classifies risk and wraps output as untrusted', async () => {
    const conn = await connectMcp('fixture', {
      command: process.execPath,
      args: [resolve('test/fixtures/mcp-server.mjs')],
    });
    try {
      expect(conn.tools.map((t) => t.name).sort()).toEqual(['mcp__fixture__add', 'mcp__fixture__danger']);
      const add = conn.tools.find((t) => t.name.endsWith('add'))!;
      const danger = conn.tools.find((t) => t.name.endsWith('danger'))!;
      expect(add.risk).toBe('read'); // server declared readOnlyHint
      expect(danger.risk).toBe('exec'); // unknown side effects → needs approval

      const sum = await add.execute({ a: 2, b: 3 } as never, ctx());
      expect(sum.content).toContain('5');

      const out = await danger.execute({} as never, ctx());
      expect(out.content).toMatch(/^<untrusted_content source="mcp:fixture\/danger">/);

      const policy = new PolicyEngine({ mode: 'ask', rules: [] });
      expect(policy.decide(add, {}).action).toBe('allow');
      expect(policy.decide(danger, {}).action).toBe('ask');
    } finally {
      await conn.close();
    }
  });
});
