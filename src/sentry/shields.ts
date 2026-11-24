import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ownAddresses, publicIp } from './checks.js';
import type { Run } from './run.js';

/**
 * Shields: narrow, reversible protections, after Shirudo's. Each one blocks one thing (an address, a service,
 * a file, a key, an account), records how to undo it, expires when it should, and goes on a ledger that shows
 * if anyone edits it. Nothing is ever deleted: files and keys are moved aside, never removed.
 */

export type ShieldKind =
  'block-ip' | 'quarantine-file' | 'quarantine-key' | 'stop-service' | 'kill-process' | 'lock-account';

export const SHIELD_KINDS: ShieldKind[] = [
  'block-ip',
  'quarantine-file',
  'quarantine-key',
  'stop-service',
  'kill-process',
  'lock-account',
];

export interface Shield {
  id: string;
  kind: ShieldKind;
  target: string;
  reason: string;
  /** Who put it up: sentry on its own, the agent with your approval, or you. */
  by: 'sentry' | 'agent' | 'user';
  at: number;
  /** When it comes down on its own. */
  expires?: number;
  /** What was there before, to put back. */
  undo: Record<string, string>;
  /** False for what cannot be put back (a stopped process). */
  reversible: boolean;
  /** `done`: a one-off action that cannot be lifted (a stopped process); kept on the record. */
  status: 'active' | 'lifted' | 'expired' | 'done';
}

export interface ShieldEnv {
  run: Run;
  /** Sentry's folder: shields.json, ledger.jsonl, quarantine/. */
  dir: string;
  /** Addresses never blocked: this machine, the model servers, the mesh. */
  protect: string[];
  now?: () => number;
}

/** Programs that, moved or stopped, take the machine down with them. */
const SYSTEM_PATHS = /^\/(bin|sbin|lib|lib32|lib64|libx32|boot|usr\/(bin|sbin|lib|lib32|lib64|libexec))\//;
const SYSTEM_FILES = new Set([
  '/etc/passwd',
  '/etc/shadow',
  '/etc/group',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/fstab',
]);
const ESSENTIAL_UNITS =
  /^(systemd-|dbus|NetworkManager|networking|network-manager|ssh|sshd|display-manager|gdm|lightdm|sddm|polkit|udisks2|getty@|user@|cron|rsyslog|ufw|nftables|firewalld|apparmor|auditd)/;

/** Why a shield cannot go up at all, whoever asks. */
export function refusal(
  kind: ShieldKind,
  target: string,
  env: Pick<ShieldEnv, 'protect'>,
): string | undefined {
  switch (kind) {
    case 'block-ip':
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return 'only IPv4 addresses can be blocked';
      if (ownAddresses().includes(target) || env.protect.includes(target))
        return 'that address is this machine, a model server or a mesh node';
      return undefined;
    case 'quarantine-file': {
      if (!isAbsolute(target)) return 'give the full path of the file';
      const p = resolve(target);
      if (SYSTEM_PATHS.test(p) || SYSTEM_FILES.has(p))
        return 'that is a system file; moving it could break the machine. Stop what uses it instead, or remove its setuid bit';
      if (!existsSync(p) || !statSync(p).isFile()) return 'there is no file there';
      return undefined;
    }
    case 'quarantine-key':
      return /^[\w@.-]+ [0-9a-f]{16}$/.test(target)
        ? undefined
        : 'give the key as sentry lists it: "<type> <fingerprint>"';
    case 'stop-service':
      if (!/^[\w@.:-]+\.service$/.test(target)) return 'give the unit name, like "foo.service"';
      if (ESSENTIAL_UNITS.test(target)) return 'that service keeps the machine running or reachable';
      return undefined;
    case 'kill-process': {
      const pid = Number(target);
      if (!Number.isInteger(pid) || pid <= 1) return 'give a process id';
      if (pid === process.pid || pid === process.ppid) return 'that is the harness itself';
      return undefined;
    }
    case 'lock-account':
      if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(target)) return 'give a user name';
      if (target === 'root' || target === (process.env.USER ?? ''))
        return 'locking root or yourself would lock you out';
      return undefined;
  }
}

/**
 * Whether sentry may put this up without asking: blocking an outside address (it comes down on its own), or
 * moving a file you could move yourself. Everything else asks you first.
 */
export function automatic(kind: ShieldKind, target: string, allowed: ShieldKind[]): boolean {
  if (!allowed.includes(kind)) return false;
  if (kind === 'block-ip') return publicIp(target);
  if (kind === 'quarantine-file')
    try {
      accessSync(dirname(resolve(target)), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  return false;
}

// ---- the ledger --------------------------------------------------------------------------------------

/**
 * Every shield raised or lifted, and every change accepted into the baseline, in order. Each entry carries an
 * HMAC over itself and the one before, with a key only this user can read, so an edited or deleted entry
 * breaks the chain. (Root on this machine could still rewrite it all: it shows tampering, it cannot stop it.)
 */
export class Ledger {
  private file: string;
  private key: Buffer;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'ledger.jsonl');
    const keyFile = join(dir, 'ledger.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
  }

  private entries(): { seq: number; at: number; event: string; data: unknown; prev: string; mac: string }[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as never);
  }

  private mac(prev: string, seq: number, at: number, event: string, data: unknown): string {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([prev, seq, at, event, data]))
      .digest('hex');
  }

  append(event: string, data: unknown, at = Date.now()): void {
    const all = this.entries();
    const last = all.at(-1);
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.mac ?? 'start';
    appendFileSync(
      this.file,
      JSON.stringify({ seq, at, event, data, prev, mac: this.mac(prev, seq, at, event, data) }) + '\n',
      {
        mode: 0o600,
      },
    );
  }

  /** Whether the chain is whole; the first entry that does not fit, when it is not. */
  verify(): { ok: true; count: number } | { ok: false; at: number; why: string } {
    let prev = 'start';
    let seq = 0;
    let all;
    try {
      all = this.entries();
    } catch {
      return { ok: false, at: 0, why: 'a line is not valid JSON' };
    }
    for (const e of all) {
      if (e.seq !== seq + 1) return { ok: false, at: e.seq, why: 'an entry is missing or out of order' };
      if (e.prev !== prev || e.mac !== this.mac(prev, e.seq, e.at, e.event, e.data))
        return { ok: false, at: e.seq, why: 'an entry was changed' };
      prev = e.mac;
      seq = e.seq;
    }
    return { ok: true, count: all.length };
  }

  recent(n = 20): { seq: number; at: number; event: string; data: unknown }[] {
    return this.entries().slice(-n);
  }
}

// ---- raising and lifting -----------------------------------------------------------------------------

const NFT_TABLE = ['inet', 'nexus_sentry'];

/** The table, set and rule that blocked addresses go into, made once; sentry's own, never anyone else's. */
async function ensureBlockTable(run: Run): Promise<string | undefined> {
  const has = await run('nft', ['list', 'table', ...NFT_TABLE], { sudo: true });
  if (has.ok) return undefined;
  if (has.missing) return 'nft is not installed';
  for (const args of [
    ['add', 'table', ...NFT_TABLE],
    ['add', 'set', ...NFT_TABLE, 'blocked4', '{ type ipv4_addr; flags timeout; }'],
    ['add', 'chain', ...NFT_TABLE, 'input', '{ type filter hook input priority -10; policy accept; }'],
    ['add', 'rule', ...NFT_TABLE, 'input', 'ip', 'saddr', '@blocked4', 'drop'],
    ['add', 'chain', ...NFT_TABLE, 'output', '{ type filter hook output priority -10; policy accept; }'],
    ['add', 'rule', ...NFT_TABLE, 'output', 'ip', 'daddr', '@blocked4', 'drop'],
  ]) {
    const r = await run('nft', args, { sudo: true });
    if (!r.ok) return sudoHint(r.stderr, `nft ${args.join(' ')}`);
  }
  return undefined;
}

function sudoHint(stderr: string, cmd: string): string {
  return /password|sudo:/i.test(stderr)
    ? `needs sudo without a password for this; run it yourself: sudo ${cmd}`
    : `failed: ${stderr.trim().slice(0, 200)}`;
}

export type Outcome = { ok: true; shield: Shield; note?: string } | { ok: false; error: string };

export async function raise(
  env: ShieldEnv,
  req: { kind: ShieldKind; target: string; reason: string; by: Shield['by']; minutes?: number },
): Promise<Outcome> {
  const now = (env.now ?? Date.now)();
  const no = refusal(req.kind, req.target, env);
  if (no) return { ok: false, error: no };
  const id = createHash('sha256').update(`${req.kind}\0${req.target}\0${now}`).digest('hex').slice(0, 8);
  const base = {
    id,
    kind: req.kind,
    target: req.target,
    reason: req.reason,
    by: req.by,
    at: now,
    status: 'active' as const,
  };
  const { run } = env;
  switch (req.kind) {
    case 'block-ip': {
      const minutes = Math.max(1, Math.min(req.minutes ?? 60, 7 * 24 * 60));
      const err = await ensureBlockTable(run);
      if (err) return { ok: false, error: err };
      const r = await run(
        'nft',
        ['add', 'element', ...NFT_TABLE, 'blocked4', `{ ${req.target} timeout ${minutes}m }`],
        { sudo: true },
      );
      if (!r.ok)
        return {
          ok: false,
          error: sudoHint(
            r.stderr,
            `nft add element inet nexus_sentry blocked4 '{ ${req.target} timeout ${minutes}m }'`,
          ),
        };
      // The kernel takes it down when the time is up; the record follows.
      return { ok: true, shield: { ...base, expires: now + minutes * 60_000, undo: {}, reversible: true } };
    }
    case 'quarantine-file': {
      const src = resolve(req.target);
      const st = statSync(src);
      const dest = join(env.dir, 'quarantine', id, basename(src));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      const hash = createHash('sha256').update(readFileSync(src)).digest('hex');
      try {
        renameSync(src, dest);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EXDEV') {
          // Another file system: copy, check the copy is whole, and only then take the original away.
          copyFileSync(src, dest);
          if (createHash('sha256').update(readFileSync(dest)).digest('hex') !== hash)
            return {
              ok: false,
              error: 'the copy into quarantine did not match; the file was left where it is',
            };
          rmSync(src);
        } else
          return {
            ok: false,
            error: `cannot move it (${code}); as root: sudo mv ${JSON.stringify(src)} ${JSON.stringify(dest)}`,
          };
      }
      chmodSync(dest, 0o000);
      return {
        ok: true,
        shield: {
          ...base,
          undo: { path: src, stored: dest, mode: (st.mode & 0o7777).toString(8), sha256: hash },
          reversible: true,
        },
        note: `moved to ${dest} (sha256 ${hash.slice(0, 16)}…), permissions removed`,
      };
    }
    case 'quarantine-key': {
      // Every authorized_keys file this user can write that holds the key.
      const [type, fp] = req.target.split(' ');
      const files = [join(process.env.HOME ?? '', '.ssh/authorized_keys')];
      const removed: string[] = [];
      for (const f of files) {
        if (!existsSync(f)) continue;
        const lines = readFileSync(f, 'utf8').split('\n');
        const keep = lines.filter((l) => {
          const m = /(?:^|\s)((?:ssh|ecdsa|sk)-[\w@.-]+)\s+([A-Za-z0-9+/=]+)/.exec(l);
          const hit =
            m && m[1] === type && createHash('sha256').update(m[2]!).digest('hex').slice(0, 16) === fp;
          if (hit) removed.push(`${f}\t${l}`);
          return !hit;
        });
        if (keep.length !== lines.length) writeFileSync(f, keep.join('\n'), { mode: 0o600 });
      }
      if (!removed.length)
        return {
          ok: false,
          error: "no authorized_keys file you can write holds that key (root's needs sudo: edit it yourself)",
        };
      const stored = join(env.dir, 'quarantine', id, 'keys');
      mkdirSync(dirname(stored), { recursive: true, mode: 0o700 });
      writeFileSync(stored, removed.join('\n') + '\n', { mode: 0o600 });
      return {
        ok: true,
        shield: { ...base, undo: { stored }, reversible: true },
        note: `removed from ${removed.length} file(s)`,
      };
    }
    case 'stop-service': {
      const enabled = (await run('systemctl', ['is-enabled', req.target])).stdout.trim();
      const active = (await run('systemctl', ['is-active', req.target])).stdout.trim();
      const r = await run('systemctl', ['disable', '--now', req.target], { sudo: true });
      if (!r.ok) return { ok: false, error: sudoHint(r.stderr, `systemctl disable --now ${req.target}`) };
      return { ok: true, shield: { ...base, undo: { enabled, active }, reversible: true } };
    }
    case 'kill-process': {
      let cmdline = '';
      try {
        cmdline = readFileSync(`/proc/${req.target}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch {
        return { ok: false, error: 'no such process' };
      }
      try {
        process.kill(Number(req.target), 'SIGTERM');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EPERM') return { ok: false, error: (e as Error).message };
        // Another user's process: as root.
        const r = await run('kill', ['-TERM', req.target], { sudo: true });
        if (!r.ok) return { ok: false, error: sudoHint(r.stderr, `kill -TERM ${req.target}`) };
      }
      return {
        ok: true,
        shield: { ...base, undo: { cmdline }, reversible: false },
        note: `stopped: ${cmdline.slice(0, 120)}`,
      };
    }
    case 'lock-account': {
      // -L locks the password, -e 1 expires the account, which also stops SSH key logins.
      const r = await run('usermod', ['-L', '-e', '1', req.target], { sudo: true });
      if (!r.ok) return { ok: false, error: sudoHint(r.stderr, `usermod -L -e 1 ${req.target}`) };
      return { ok: true, shield: { ...base, undo: {}, reversible: true } };
    }
  }
}

export async function lift(
  env: ShieldEnv,
  s: Shield,
): Promise<{ ok: true; note?: string } | { ok: false; error: string }> {
  const { run } = env;
  switch (s.kind) {
    case 'block-ip': {
      const r = await run('nft', ['delete', 'element', ...NFT_TABLE, 'blocked4', `{ ${s.target} }`], {
        sudo: true,
      });
      // Already gone (its time ran out) is fine.
      if (!r.ok && !/No such file|does not exist/i.test(r.stderr))
        return {
          ok: false,
          error: sudoHint(r.stderr, `nft delete element inet nexus_sentry blocked4 '{ ${s.target} }'`),
        };
      return { ok: true };
    }
    case 'quarantine-file': {
      const { path, stored, mode } = s.undo;
      if (!path || !stored) return { ok: false, error: 'the record is incomplete' };
      if (existsSync(path)) return { ok: false, error: `something is at ${path} again; move it aside first` };
      chmodSync(stored, parseInt(mode ?? '600', 8));
      renameSync(stored, path);
      return { ok: true, note: `put back at ${path}` };
    }
    case 'quarantine-key': {
      const stored = s.undo.stored;
      if (!stored || !existsSync(stored)) return { ok: false, error: 'the stored key is missing' };
      for (const l of readFileSync(stored, 'utf8').split('\n').filter(Boolean)) {
        const [file, line] = l.split('\t');
        if (file && line) appendFileSync(file, `${line}\n`, { mode: 0o600 });
      }
      return { ok: true, note: 'key put back' };
    }
    case 'stop-service': {
      if (s.undo.enabled === 'enabled') {
        const r = await run('systemctl', ['enable', s.target], { sudo: true });
        if (!r.ok) return { ok: false, error: sudoHint(r.stderr, `systemctl enable ${s.target}`) };
      }
      if (s.undo.active === 'active') {
        const r = await run('systemctl', ['start', s.target], { sudo: true });
        if (!r.ok) return { ok: false, error: sudoHint(r.stderr, `systemctl start ${s.target}`) };
      }
      return { ok: true };
    }
    case 'kill-process':
      return {
        ok: false,
        error: 'a stopped process cannot be brought back; start it again yourself if it was wanted',
      };
    case 'lock-account': {
      const r = await run('usermod', ['-U', '-e', '', s.target], { sudo: true });
      if (!r.ok) return { ok: false, error: sudoHint(r.stderr, `usermod -U -e '' ${s.target}`) };
      return { ok: true };
    }
  }
}

/** The shields on record, in sentry's folder. */
export class ShieldStore {
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'shields.json');
  }
  all(): Shield[] {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Shield[];
    } catch {
      return [];
    }
  }
  save(list: Shield[]): void {
    writeFileSync(this.file, JSON.stringify(list, null, 2), { mode: 0o600 });
  }
  put(s: Shield): void {
    this.save([...this.all().filter((x) => x.id !== s.id), s]);
  }
  get(id: string): Shield | undefined {
    return this.all().find((s) => s.id === id || s.id.startsWith(id));
  }
}
