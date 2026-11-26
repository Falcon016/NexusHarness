import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFiles, looksLocal } from '../src/browser/files.js';
import { browserCandidates } from '../src/browser/service.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
let files: LocalFiles;
let root: string;
beforeEach(() => {
  ws = tmpWorkspace();
  root = realpathSync(ws.dir);
  mkdirSync(join(root, 'site', 'js'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), '<script type="module" src="js/app.js"></script>');
  writeFileSync(join(root, 'site', 'js', 'app.js'), 'export const x = 1;');
  writeFileSync(join(root, '.env'), 'TOKEN=placeholder');
  const sandbox = new GuardSandbox({ cwd: root, denyPaths: ['.env'] });
  files = new LocalFiles(root, (p) => sandbox.checkPath(p, 'read'));
});
afterEach(async () => {
  await files.close();
  ws.cleanup();
});

describe('which addresses are local files', () => {
  it('takes paths and file:// URLs, and leaves web addresses alone', () => {
    for (const t of [
      'index.html',
      './site/',
      '/home/u/p/game.html',
      'file:///home/u/x.html',
      'site/index.htm',
    ])
      expect(looksLocal(t), t).toBe(true);
    for (const t of [
      'https://example.com',
      'http://localhost:3000',
      'localhost:5173',
      'example.com/page',
      'about:blank',
    ])
      expect(looksLocal(t), t).toBe(false);
  });
});

describe('serving the project to the browser', () => {
  it('serves a page and its scripts with the right types, from a private address', async () => {
    const url = await files.urlFor('site/');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{12}\/site\/$/);
    const page = await fetch(url);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('js/app.js');
    const js = await fetch(new URL('js/app.js', url));
    expect(js.headers.get('content-type')).toContain('text/javascript');
    // The same file as a file:// URL gets the same address.
    expect(await files.urlFor(pathToFileURL(join(root, 'site', 'index.html')).href)).toBe(`${url}index.html`);
  });

  it('refuses files outside the project, files the sandbox protects, and requests without the prefix', async () => {
    await expect(files.urlFor('/etc/hostname')).rejects.toThrow();
    await expect(files.urlFor('.env')).rejects.toThrow(/denyPaths/);
    const base = new URL(await files.urlFor('site/'));
    const prefix = base.pathname.split('/')[1];
    expect((await fetch(`${base.origin}/${prefix}/.env`)).status).toBe(403);
    expect((await fetch(`${base.origin}/${prefix}/..%2F..%2Fetc%2Fhostname`)).status).toBe(403);
    expect((await fetch(`${base.origin}/site/index.html`)).status).toBe(404);
    expect((await fetch(`${base.origin}/${prefix}/site/index.html`, { method: 'POST' })).status).toBe(405);
  });
});

describe('finding a browser', () => {
  it('tries the configured one first, then the others, then a system Chromium, then the bundled one', () => {
    const has = (p: string) => p === '/usr/bin/chromium';
    expect(browserCandidates('chrome', has, 'linux').map((c) => c.label)).toEqual([
      'chrome',
      'msedge',
      'chromium (/usr/bin/chromium)',
      'chromium',
    ]);
    expect(browserCandidates('chromium', () => false, 'linux').map((c) => c.label)).toEqual([
      'chromium',
      'chrome',
      'msedge',
    ]);
    expect(browserCandidates('msedge', has, 'win32')[0]!.label).toBe('msedge');
  });
});
