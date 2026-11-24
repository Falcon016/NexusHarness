import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Run } from './run.js';

/**
 * What sentry looks at. Every check is read-only and needs no root; one that cannot run here (a missing tool,
 * no permission) says so and is left out of the comparison rather than reported as a change.
 *
 * A check returns items by a stable key (what identifies the thing: a port, a user, a key's fingerprint) with
 * a short detail. Sentry compares the keys with the baseline: a key that appears or disappears is a finding.
 */

export type CheckName =
  | 'ports'
  | 'users'
  | 'admins'
  | 'sshKeys'
  | 'sshd'
  | 'scheduled'
  | 'startup'
  | 'services'
  | 'setuid'
  | 'modules'
  | 'firewall'
  | 'devices';

export type Items = Record<string, string>;

export interface Snapshot {
  host: string;
  at: number;
  checks: Partial<Record<CheckName, Items>>;
  /** Checks that could not run here, with why. */
  unavailable: Partial<Record<CheckName, string>>;
}

/** Repeated failed logins from one address in the last sweep: not part of the baseline, judged each time. */
export interface LoginFailures {
  byIp: Record<string, number>;
  source: string;
}

export interface CheckEnv {
  run: Run;
  /** Networks to look for devices on, in CIDR form; checked to be private before anything is sent. */
  networks: string[];
  home?: string;
  /** Root of the file system, for tests. */
  root?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};
const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

type Check = (e: CheckEnv) => Promise<Items | string>;

/** Listening sockets: `tcp 0.0.0.0:22` → sshd. The process id is left out, so a restart is not a change. */
const ports: Check = async ({ run }) => {
  const r = await run('ss', ['-H', '-tulpn']);
  if (!r.ok) return r.missing ? 'ss is not installed' : `ss failed: ${r.stderr.trim().slice(0, 100)}`;
  return parsePorts(r.stdout);
};

export function parsePorts(out: string): Items {
  const items: Items = {};
  for (const l of out.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 5) continue;
    const proto = f[0]!;
    const local = f[4]!.replace(/%[^\]:]+(?=\]|:\d+$)/, ''); // drop the interface of a link-local address
    const proc = /users:\(\("([^"]+)"/.exec(l)?.[1] ?? '';
    items[`${proto} ${local}`] = proc;
  }
  return items;
}

/** Accounts that can log in, and every account with uid 0. */
const users: Check = async ({ root = '' }) => {
  const passwd = read(`${root}/etc/passwd`);
  if (!passwd) return 'cannot read /etc/passwd';
  const items: Items = {};
  for (const l of lines(passwd)) {
    const [name, , uid, , , , shell] = l.split(':');
    const n = Number(uid);
    const login = shell && !/(nologin|false|sync|halt|shutdown)$/.test(shell);
    if (name && (n === 0 || (n >= 1000 && n < 65534 && login))) items[name] = `uid ${uid}, ${shell}`;
  }
  return items;
};

/** Members of the groups that give admin rights. */
const admins: Check = async ({ root = '' }) => {
  const group = read(`${root}/etc/group`);
  if (!group) return 'cannot read /etc/group';
  const items: Items = {};
  for (const l of lines(group)) {
    const [name, , , members] = l.split(':');
    if (!name || !['sudo', 'wheel', 'admin', 'adm', 'docker', 'lxd', 'libvirt'].includes(name)) continue;
    for (const m of (members ?? '').split(',').filter(Boolean)) items[`${name}:${m}`] = `${m} in ${name}`;
  }
  return items;
};

/** Keys allowed to log in over SSH, by fingerprint, in every authorized_keys file this user can read. */
const sshKeys: Check = async ({ root = '', home = homedir() }) => {
  const files = new Set<string>([join(home, '.ssh/authorized_keys'), `${root}/root/.ssh/authorized_keys`]);
  try {
    for (const u of readdirSync(`${root}/home`)) files.add(`${root}/home/${u}/.ssh/authorized_keys`);
  } catch {
    /* no /home */
  }
  const items: Items = {};
  for (const f of files) {
    const text = read(f);
    if (!text) continue;
    for (const l of lines(text)) {
      const m = /(?:^|\s)((?:ssh|ecdsa|sk)-[\w@.-]+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(l);
      if (m) items[`${m[1]} ${sha(m[2]!)}`] = `${f}${m[3] ? ` (${m[3].slice(0, 60)})` : ''}`;
    }
  }
  return items;
};

/** The SSH server settings that matter most. */
const sshd: Check = async ({ root = '' }) => {
  const main = read(`${root}/etc/ssh/sshd_config`);
  if (main === undefined) return 'no SSH server configuration';
  let text = main;
  try {
    for (const f of readdirSync(`${root}/etc/ssh/sshd_config.d`).sort())
      if (f.endsWith('.conf')) text += `\n${read(`${root}/etc/ssh/sshd_config.d/${f}`) ?? ''}`;
  } catch {
    /* no drop-ins */
  }
  const items: Items = {};
  for (const l of lines(text)) {
    const m =
      /^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|Port|PermitEmptyPasswords|AuthorizedKeysFile|KbdInteractiveAuthentication)\s+(.+)$/i.exec(
        l,
      );
    // sshd takes the first value it reads for a setting.
    if (m && !Object.keys(items).some((k) => k.startsWith(`${m[1]!} `))) items[`${m[1]} ${m[2]}`] = m[2]!;
  }
  return items;
};

/** Cron jobs (this user's and the system's) and systemd timers. */
const scheduled: Check = async ({ run, root = '' }) => {
  const items: Items = {};
  const mine = await run('crontab', ['-l']);
  if (mine.ok) for (const l of lines(mine.stdout)) items[`crontab ${sha(l)}`] = l.slice(0, 120);
  for (const f of [`${root}/etc/crontab`])
    for (const l of lines(read(f) ?? '')) items[`${f} ${sha(l)}`] = l.slice(0, 120);
  for (const dir of ['cron.d', 'cron.hourly', 'cron.daily', 'cron.weekly', 'cron.monthly'])
    try {
      for (const f of readdirSync(`${root}/etc/${dir}`))
        if (!f.startsWith('.')) items[`/etc/${dir}/${f}`] = sha(read(`${root}/etc/${dir}/${f}`) ?? '');
    } catch {
      /* none */
    }
  const timers = await run('systemctl', ['list-unit-files', '--type=timer', '--no-legend', '--no-pager']);
  if (timers.ok)
    for (const l of lines(timers.stdout)) {
      const [unit, state] = l.split(/\s+/);
      if (unit && state !== 'masked') items[`timer ${unit}`] = state ?? '';
    }
  return items;
};

/** Things that start at login: desktop autostart entries and user services. */
const startup: Check = async ({ home = homedir() }) => {
  const items: Items = {};
  for (const dir of ['.config/autostart', '.config/systemd/user'])
    try {
      for (const f of readdirSync(join(home, dir)))
        if (/\.(desktop|service|timer)$/.test(f)) items[`${dir}/${f}`] = sha(read(join(home, dir, f)) ?? '');
    } catch {
      /* none */
    }
  const profile = join(home, '.bashrc');
  if (existsSync(profile)) items['~/.bashrc'] = sha(read(profile) ?? '');
  return items;
};

/** Services enabled to start at boot. */
const services: Check = async ({ run }) => {
  const r = await run('systemctl', [
    'list-unit-files',
    '--type=service',
    '--state=enabled',
    '--no-legend',
    '--no-pager',
  ]);
  if (!r.ok) return r.missing ? 'not a systemd machine' : 'systemctl failed';
  const items: Items = {};
  for (const l of lines(r.stdout)) {
    const unit = l.split(/\s+/)[0];
    if (unit) items[unit] = 'enabled';
  }
  return items;
};

/** Programs that run with their owner's rights (setuid/setgid) in the usual program folders. */
const setuid: Check = async ({ run, root = '' }) => {
  const dirs = ['/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin', '/bin', '/sbin', '/opt']
    .map((d) => `${root}${d}`)
    .filter((d) => existsSync(d));
  const r = await run(
    'find',
    [...dirs, '-xdev', '-type', 'f', '(', '-perm', '-4000', '-o', '-perm', '-2000', ')'],
    {
      timeoutMs: 30_000,
    },
  );
  if (r.missing) return 'find is not installed';
  const items: Items = {};
  for (const f of lines(r.stdout)) {
    let size = '';
    try {
      size = String(statSync(f).size);
    } catch {
      /* gone */
    }
    items[root ? f.slice(root.length) : f] = size;
  }
  return items;
};

/** Loaded kernel modules. */
const modules: Check = async ({ root = '' }) => {
  const text = read(`${root}/proc/modules`);
  if (text === undefined) return 'cannot read /proc/modules';
  const items: Items = {};
  for (const l of lines(text)) {
    const name = l.split(' ')[0];
    if (name) items[name] = '';
  }
  return items;
};

/** The firewall rules, as one fingerprint (sentry's own table left out). Needs passwordless `sudo nft`. */
const firewall: Check = async ({ run }) => {
  const r = await run('nft', ['-s', 'list', 'ruleset'], { sudo: true });
  if (!r.ok)
    return r.missing ? 'nft is not installed' : 'reading the firewall needs passwordless sudo for nft';
  const ours = /table inet nexus_sentry \{[\s\S]*?\n\}\n?/;
  return { rules: sha(r.stdout.replace(ours, '')) };
};

/** Devices on the watched networks, by hardware address: the neighbour table, plus a ping sweep with nmap. */
const devices: Check = async ({ run, networks }) => {
  const safe = networks.filter((n) => privateCidr(n) && cidrSize(n) <= 1024);
  if (!safe.length) return 'no private network to watch';
  const items: Items = {};
  const neigh = await run('ip', ['-j', 'neigh']);
  if (neigh.ok)
    try {
      for (const n of JSON.parse(neigh.stdout) as { dst: string; lladdr?: string; state?: string[] }[])
        if (n.lladdr && safe.some((c) => inCidr(n.dst, c))) items[n.lladdr.toLowerCase()] = n.dst;
    } catch {
      /* not JSON */
    }
  // Discovery only (-sn): which addresses answer. No port scan, nothing outside the watched networks.
  const scan = await run('nmap', ['-sn', '-n', '--max-retries', '1', ...safe], { timeoutMs: 120_000 });
  if (scan.ok) {
    let ip = '';
    for (const l of scan.stdout.split('\n')) {
      const a = /^Nmap scan report for (\S+)/.exec(l);
      if (a) ip = a[1]!;
      const m = /^MAC Address: ([0-9A-Fa-f:]{17})(?: \((.+)\))?/.exec(l);
      if (m && ip) items[m[1]!.toLowerCase()] = `${ip}${m[2] ? ` ${m[2]}` : ''}`;
    }
  }
  if (!neigh.ok && !scan.ok) return 'neither ip nor nmap could list devices';
  return items;
};

export const CHECKS: Record<CheckName, Check> = {
  ports,
  users,
  admins,
  sshKeys,
  sshd,
  scheduled,
  startup,
  services,
  setuid,
  modules,
  firewall,
  devices,
};

export async function snapshot(env: CheckEnv, only?: CheckName[]): Promise<Snapshot> {
  const snap: Snapshot = { host: hostname(), at: Date.now(), checks: {}, unavailable: {} };
  const names = only ?? (Object.keys(CHECKS) as CheckName[]);
  await Promise.all(
    names.map(async (n) => {
      try {
        const r = await CHECKS[n](env);
        if (typeof r === 'string') snap.unavailable[n] = r;
        else snap.checks[n] = r;
      } catch (e) {
        snap.unavailable[n] = (e as Error).message;
      }
    }),
  );
  return snap;
}

/** Failed SSH logins in the last `minutes`, by address, from the journal (or auth.log when that is readable). */
export async function loginFailures(env: CheckEnv, minutes: number): Promise<LoginFailures | string> {
  const j = await env.run('journalctl', [
    '--no-pager',
    '-o',
    'cat',
    `--since=-${Math.max(1, Math.round(minutes))}min`,
    '_COMM=sshd',
    '_COMM=sshd-session',
  ]);
  let text: string | undefined;
  let source = 'journal';
  if (j.ok && j.stdout.trim()) text = j.stdout;
  else {
    const log = read(`${env.root ?? ''}/var/log/auth.log`);
    if (log) {
      // The tail is enough: older lines were counted by earlier sweeps.
      text = log.slice(-200_000);
      source = '/var/log/auth.log';
    }
  }
  if (text === undefined) return 'cannot read the login log (join the adm or systemd-journal group)';
  const byIp: Record<string, number> = {};
  for (const l of text.split('\n')) {
    const m =
      /(?:Failed (?:password|publickey) for (?:invalid user )?\S+|Invalid user \S* ?|authentication failure;.*rhost=)\s*(?:from )?(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{3,})/i.exec(
        l,
      );
    if (m) byIp[m[1]!] = (byIp[m[1]!] ?? 0) + 1;
  }
  return { byIp, source };
}

// ---- addresses ----------------------------------------------------------------------------------------

const v4 = (ip: string) => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!
    : undefined;
};

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const a = v4(ip);
  const b = v4(base ?? '');
  const n = Number(bits ?? 32);
  if (a === undefined || b === undefined || !(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

export const cidrSize = (cidr: string) => 2 ** (32 - Number(cidr.split('/')[1] ?? 32));

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'];

/** A private IPv4 network: the only kind sentry ever looks for devices on. */
export const privateCidr = (cidr: string) =>
  /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr) &&
  PRIVATE.some(
    (p) => inCidr(cidr.split('/')[0]!, p) && Number(cidr.split('/')[1]) >= Number(p.split('/')[1]),
  );

/** An address on the public internet (not private, loopback, link-local, CGNAT or multicast). */
export function publicIp(ip: string): boolean {
  if (v4(ip) === undefined) return false;
  return ![...PRIVATE, '127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/3'].some((c) => inCidr(ip, c));
}

/** The private IPv4 networks this machine is on, to watch when none are configured. */
export function localNetworks(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && a.cidr && privateCidr(networkOf(a.cidr)))
        out.add(networkOf(a.cidr));
  return [...out];
}

/** `192.168.1.40/24` → `192.168.1.0/24`. */
export function networkOf(cidr: string): string {
  const [ip, bits] = cidr.split('/');
  const a = v4(ip ?? '');
  const n = Number(bits);
  if (a === undefined) return cidr;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  const b = (a & mask) >>> 0;
  return `${b >>> 24}.${(b >>> 16) & 255}.${(b >>> 8) & 255}.${b & 255}/${n}`;
}

/** This machine's own addresses, which are never blocked. */
export function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((l) => l ?? [])
    .map((a) => a.address);
}
