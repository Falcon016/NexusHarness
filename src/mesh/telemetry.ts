import { execFile } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os';

/**
 * The `nexus node` service: what a machine's hardware is doing, for the mesh to place work by. It answers one
 * read-only request and runs nothing it is asked to: there is no way to send it a command. Requests and replies
 * are signed with a key shared at pairing, so nothing else on the network can read it or feed the harness false
 * numbers.
 */

export interface Gpu {
  name: string;
  /** MiB. */
  memoryTotal: number;
  memoryUsed: number;
  /** Percent. */
  utilization?: number;
  temperature?: number;
}

export interface Telemetry {
  hostname: string;
  platform: string;
  cpuCount: number;
  /** One-minute load average divided by the core count: 1 is fully busy. */
  cpuLoad: number;
  /** Bytes. */
  memoryTotal: number;
  memoryFree: number;
  uptime: number;
  gpus: Gpu[];
  at: number;
}

const run = (cmd: string, args: string[], timeoutMs = 3000) =>
  new Promise<string | undefined>((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, out) =>
      resolve(err ? undefined : out),
    );
  });

/** NVIDIA GPUs through nvidia-smi (fixed arguments, never a shell). None when it is not installed. */
export function parseNvidiaSmi(out: string): Gpu[] {
  return out
    .split('\n')
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((f) => f.length >= 3 && f[0])
    .map(([name, total, used, util, temp]) => {
      const num = (s: string | undefined) => (s && /^\d+(\.\d+)?$/.test(s) ? Number(s) : undefined);
      const utilization = num(util);
      const temperature = num(temp);
      return {
        name: name!,
        memoryTotal: num(total) ?? 0,
        memoryUsed: num(used) ?? 0,
        ...(utilization !== undefined ? { utilization } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      };
    });
}

export async function collectTelemetry(): Promise<Telemetry> {
  const smi = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  const n = Math.max(1, cpus().length);
  return {
    hostname: hostname(),
    platform: platform(),
    cpuCount: n,
    cpuLoad: Math.round(((loadavg()[0] ?? 0) / n) * 100) / 100,
    memoryTotal: totalmem(),
    memoryFree: freemem(),
    uptime: Math.round(uptime()),
    gpus: smi ? parseNvidiaSmi(smi) : [],
    at: Date.now(),
  };
}

// ---- signing ----------------------------------------------------------------------------------------

/** A new pairing key: 32 random bytes. */
export const newNodeKey = () => randomBytes(32).toString('base64url');

/** Requests older or newer than this are refused, so a captured one cannot be replayed later. */
const SKEW_MS = 60_000;

export function sign(key: string, ...parts: string[]): string {
  return createHmac('sha256', key).update(parts.join('\n')).digest('base64url');
}

export function verify(key: string, sig: string | undefined, ...parts: string[]): boolean {
  if (!sig) return false;
  const want = Buffer.from(sign(key, ...parts));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface NodeServiceOptions {
  key: string;
  port?: number;
  host?: string;
  /** Tests replace the hardware reading. */
  collect?: () => Promise<Telemetry>;
  now?: () => number;
}

export function startNodeService(o: NodeServiceOptions): Promise<Server> {
  const now = o.now ?? Date.now;
  const collect = o.collect ?? collectTelemetry;
  const server = createServer((req, res) => {
    const ts = String(req.headers['x-nexus-ts'] ?? '');
    const fresh = /^\d+$/.test(ts) && Math.abs(now() - Number(ts)) <= SKEW_MS;
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/telemetry') {
      res.writeHead(404).end();
      return;
    }
    if (!fresh || !verify(o.key, String(req.headers['x-nexus-sig'] ?? ''), ts, 'GET', '/telemetry')) {
      res.writeHead(401).end();
      return;
    }
    void collect().then(
      (t) => {
        const body = JSON.stringify(t);
        res
          .writeHead(200, {
            'content-type': 'application/json',
            // The reply is signed too, tied to this request, so it cannot be swapped on the way back.
            'x-nexus-sig': sign(o.key, ts, body),
          })
          .end(body);
      },
      () => res.writeHead(500).end(),
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 7878, o.host ?? '0.0.0.0', () => resolve(server));
  });
}

/** Ask a node's service how its hardware is doing. Undefined when it is unreachable or the signature is wrong. */
export async function fetchTelemetry(
  url: string,
  key: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<Telemetry | undefined> {
  const f = opts.fetchImpl ?? fetch;
  const ts = String((opts.now ?? Date.now)());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await f(`${url.replace(/\/+$/, '')}/telemetry`, {
      headers: { 'x-nexus-ts': ts, 'x-nexus-sig': sign(key, ts, 'GET', '/telemetry') },
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const body = await res.text();
    if (!verify(key, res.headers.get('x-nexus-sig') ?? undefined, ts, body)) return undefined;
    return JSON.parse(body) as Telemetry;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
