import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local files in the browser. A page the agent built (a game, a site, a WebGL demo) is opened over a private
 * address on this machine instead of file://, which is not allowed: a file:// page can link to any file on the
 * disk, where the browser's host checks cannot follow it. Here every file is checked against the sandbox on
 * every request, nothing outside the project is served, and scripts, modules and fetch work as they would on a
 * real server (file:// breaks most of them).
 *
 * The server listens on 127.0.0.1 only, under a random path prefix, and only while the browser is open.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.csv': 'text/csv; charset=utf-8',
};

/** A browser address for a local file: a file:// URL, an absolute path, or a path relative to the project. */
export function looksLocal(target: string): boolean {
  if (/^file:/i.test(target)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(about|data|javascript|blob):/i.test(target)) return false;
  // "localhost:3000" or "example.com/x" are hosts, not paths; "index.html", "./site/", "/home/u/x.html" are paths.
  if (/^[\w.-]+:\d+/.test(target)) return false;
  if (/^[\w-]+(\.[\w-]+)+\//.test(target) && !/\.(html?|svg|xml|json|txt|md)$/i.test(target.split('/')[0]!))
    return false;
  return true;
}

export class LocalFiles {
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private readonly prefix = randomBytes(9).toString('base64url');

  /**
   * @param root The project folder: nothing outside it is served.
   * @param check The sandbox's check for reading a path (throws when it is not allowed), run on every request.
   */
  constructor(
    private readonly root: string,
    private readonly check: (path: string) => string,
  ) {}

  /** The browser address for a local file, starting the server if it is not running. */
  async urlFor(target: string): Promise<string> {
    let path = /^file:/i.test(target) ? fileURLToPath(target.split(/[?#]/)[0]!) : target;
    const suffix = /^file:/i.test(target) ? (/[?#].*$/.exec(target)?.[0] ?? '') : '';
    path = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    const real = this.check(path);
    const rel = relative(this.root, real);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error(`Only files inside the project folder can be opened in the browser: ${path}`);
    const base = await this.start();
    const url = `${base}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
    return isDir(real) && !url.endsWith('/') ? `${url}/${suffix}` : `${url}${suffix}`;
  }

  /** Whether a URL is one this server handed out. */
  owns(url: string): boolean {
    return !!this.base && url.startsWith(`${this.base}/`);
  }

  private base: string | undefined;

  private start(): Promise<string> {
    this.starting ??= new Promise<string>((resolveStart, reject) => {
      const server = createServer((req, res) => {
        const send = (code: number, text: string) => {
          res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(text);
        };
        // Only GET and HEAD, from this machine, under the private prefix.
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
        const url = new URL(req.url ?? '/', 'http://x');
        const parts = url.pathname.split('/');
        if (parts[1] !== this.prefix) return send(404, 'Not found');
        let rel: string;
        try {
          rel = parts.slice(2).map(decodeURIComponent).join('/');
        } catch {
          return send(400, 'Bad path');
        }
        let path = resolve(this.root, rel);
        try {
          if (isDir(path)) path = join(path, 'index.html');
          path = this.check(path);
          const r = relative(this.root, path);
          if (r.startsWith('..') || isAbsolute(r)) throw new Error('outside the project');
          const st = statSync(path);
          if (!st.isFile()) return send(404, 'Not found');
          res.writeHead(200, {
            'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'content-length': st.size,
            // Always the file as it is now: the agent edits and reloads.
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          if (req.method === 'HEAD') return res.end();
          createReadStream(path)
            .on('error', () => res.destroy())
            .pipe(res);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          send(
            code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 403,
            code === 'ENOENT' ? 'Not found' : 'Not allowed',
          );
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${this.prefix}`;
        resolveStart(this.base);
      });
    });
    return this.starting;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.starting = undefined;
    this.base = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
