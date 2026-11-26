import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveScreenshot } from '../src/browser/screenshots.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { globTool, grepTool } from '../src/tools/search-tools.js';
import type { ToolContext } from '../src/tools/types.js';
import { tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
let ctx: ToolContext;
beforeEach(() => {
  ws = tmpWorkspace();
  for (const d of ['src', '.mozilla/profile', '.config/app', '.github/workflows'])
    mkdirSync(join(ws.dir, d), { recursive: true });
  writeFileSync(join(ws.dir, 'src', 'shot.png'), 'x');
  writeFileSync(join(ws.dir, 'src', 'app.ts'), 'const needle = 1;');
  writeFileSync(join(ws.dir, '.mozilla', 'profile', 'cache.png'), 'x');
  writeFileSync(join(ws.dir, '.config', 'app', 'settings.ts'), 'const needle = 2;');
  writeFileSync(join(ws.dir, '.github', 'workflows', 'ci.yml'), 'needle: 3');
  writeFileSync(join(ws.dir, '.eslintrc'), 'needle');
  ctx = {
    cwd: ws.dir,
    sandbox: new GuardSandbox({ cwd: ws.dir }),
    signal: new AbortController().signal,
  } as unknown as ToolContext;
});
afterEach(() => ws.cleanup());

const run = async (tool: typeof globTool | typeof grepTool, input: Record<string, unknown>) =>
  (await tool.execute(input as never, ctx)).content;

describe('searching skips hidden folders', () => {
  it('glob does not walk into hidden folders, but still finds hidden files at the top', async () => {
    expect(await run(globTool, { pattern: '**/*.png' })).toBe('src/shot.png');
    expect(await run(globTool, { pattern: '.eslintrc' })).toBe('.eslintrc');
  });

  it('searches a hidden folder when the pattern names it, or when asked to', async () => {
    expect(await run(globTool, { pattern: '.github/**' })).toBe('.github/workflows/ci.yml');
    expect((await run(globTool, { pattern: '**/*.png', include_hidden: true })).split('\n').sort()).toEqual([
      '.mozilla/profile/cache.png',
      'src/shot.png',
    ]);
  });

  it('grep skips them too, unless its glob names one or it is asked to', async () => {
    const plain = await run(grepTool, { pattern: 'needle' });
    expect(plain).toContain('src/app.ts:1:');
    expect(plain).not.toContain('.config/');
    expect(plain).not.toContain('.github/');
    expect(await run(grepTool, { pattern: 'needle', glob: '.github/**' })).toContain(
      '.github/workflows/ci.yml',
    );
    expect(await run(grepTool, { pattern: 'needle', include_hidden: true })).toContain(
      '.config/app/settings.ts',
    );
  });
});

describe('screenshot files', () => {
  it('are saved in one folder, private to the user, and only the newest 50 are kept', () => {
    const dir = join(ws.dir, 'shots');
    const img = { mediaType: 'image/jpeg' as const, data: Buffer.from('jpeg bytes').toString('base64') };
    const first = saveScreenshot(img, dir, new Date('2026-11-26T01:02:03Z'));
    expect(first).toMatch(/shots[\\/]screenshot-20261126-010203-\d{3}\.jpg$/);
    expect(readFileSync(first, 'utf8')).toBe('jpeg bytes');
    if (process.platform !== 'win32') {
      expect(statSync(first).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    for (let i = 0; i < 60; i++) saveScreenshot(img, dir);
    expect(readdirSync(dir)).toHaveLength(50);
  });
});
