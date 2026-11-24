import { createHash } from 'node:crypto';
import type { CheckName, Items, LoginFailures, Snapshot } from './checks.js';

/**
 * What changed since the baseline, and how much it matters. Severity follows what an intruder does first:
 * a new account with uid 0, a new SSH key, a new setuid program or admin are the classic ways in and ways to
 * stay; a new listening port or scheduled job is how they come back; a new device on the LAN may be nothing.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface Finding {
  /** Stable for the same change, so a sweep that sees it again does not report it twice. */
  id: string;
  check: CheckName | 'logins';
  kind: 'added' | 'removed' | 'attack';
  key: string;
  detail: string;
  severity: Severity;
  /** What it is, in a sentence. */
  title: string;
  at: number;
  status: 'open' | 'accepted' | 'shielded' | 'dismissed';
  /** The sentry agent's read of it, once it has looked. */
  report?: string;
}

const LABEL: Record<CheckName, string> = {
  ports: 'listening port',
  users: 'login account',
  admins: 'admin group member',
  sshKeys: 'SSH login key',
  sshd: 'SSH server setting',
  scheduled: 'scheduled job',
  startup: 'login startup item',
  services: 'service enabled at boot',
  setuid: 'setuid/setgid program',
  modules: 'kernel module',
  firewall: 'firewall rule set',
  devices: 'device on the network',
};

/** Changes nobody needs to hear about: the ones an ordinary day produces. */
const QUIET: Partial<Record<CheckName, 'added' | 'removed' | 'both'>> = {
  devices: 'removed', // phones and laptops come and go
  modules: 'removed',
  ports: 'removed',
};

function severity(check: CheckName, kind: 'added' | 'removed', key: string, detail: string): Severity {
  if (kind === 'removed')
    return check === 'firewall' || check === 'sshd'
      ? 'medium'
      : check === 'users' || check === 'admins'
        ? 'medium'
        : 'low';
  switch (check) {
    case 'users':
      return detail.startsWith('uid 0,') ? 'critical' : 'high';
    case 'admins':
    case 'sshKeys':
    case 'setuid':
      return 'high';
    case 'sshd':
      return /^(PermitRootLogin yes|PasswordAuthentication yes|PermitEmptyPasswords yes)/i.test(key)
        ? 'high'
        : 'medium';
    case 'ports': {
      const local = key.split(' ')[1] ?? '';
      return /^(127\.|\[::1\]|::1)/.test(local) ? 'low' : 'medium';
    }
    case 'scheduled':
    case 'startup':
    case 'services':
    case 'firewall':
      return 'medium';
    case 'modules':
    case 'devices':
      return 'low';
  }
}

const idOf = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 10);

/** Changes between the baseline and a new snapshot, for the checks that ran both times. */
export function diff(base: Snapshot, now: Snapshot, at = now.at): Finding[] {
  const out: Finding[] = [];
  for (const check of Object.keys(now.checks) as CheckName[]) {
    const before: Items | undefined = base.checks[check];
    const after = now.checks[check]!;
    if (!before) continue; // not in the baseline: nothing to compare with
    const quiet = QUIET[check];
    const report = (kind: 'added' | 'removed', key: string, detail: string) => {
      if (quiet === kind || quiet === 'both') return;
      const sev = severity(check, kind, key, detail);
      const what =
        check === 'firewall'
          ? 'The firewall rules changed'
          : `${kind === 'added' ? 'New' : 'Gone'} ${LABEL[check]}: ${key}`;
      out.push({
        id: idOf(check, kind, key, check === 'firewall' ? (after.rules ?? '') : ''),
        check,
        kind,
        key,
        detail,
        severity: sev,
        title: `${what}${detail && check !== 'firewall' ? ` (${detail})` : ''}`,
        at,
        status: 'open',
      });
    };
    if (check === 'firewall') {
      if (before.rules !== after.rules) report('added', 'rules', '');
      continue;
    }
    for (const [k, v] of Object.entries(after)) if (!(k in before)) report('added', k, v);
    for (const [k, v] of Object.entries(before)) if (!(k in after)) report('removed', k, v);
    // Content changes of a scheduled job file, startup item or ~/.bashrc count as new.
    if (check === 'scheduled' || check === 'startup')
      for (const [k, v] of Object.entries(after))
        if (k in before && before[k] !== v && /^[0-9a-f]{16}$/.test(v)) report('added', k, `changed`);
  }
  return out;
}

/** Many failed logins from one address in one sweep: someone trying passwords. */
export function attacks(f: LoginFailures, threshold: number, at = Date.now()): Finding[] {
  return Object.entries(f.byIp)
    .filter(([, n]) => n >= threshold)
    .map(([ip, n]) => ({
      id: idOf('logins', ip, String(Math.floor(at / 3_600_000))), // one finding per address per hour
      check: 'logins' as const,
      kind: 'attack' as const,
      key: ip,
      detail: `${n} failed SSH logins (${f.source})`,
      severity: 'high' as const,
      title: `${n} failed SSH logins from ${ip}`,
      at,
      status: 'open' as const,
    }));
}

/** Fold accepted changes into the baseline, so they are the new normal. */
export function accept(base: Snapshot, f: Finding, now: Snapshot): Snapshot {
  if (f.check === 'logins') return base;
  const items = { ...(base.checks[f.check] ?? {}) };
  if (f.check === 'firewall') items.rules = now.checks.firewall?.rules ?? items.rules ?? '';
  else if (f.kind === 'added') items[f.key] = now.checks[f.check]?.[f.key] ?? f.detail;
  else delete items[f.key];
  return { ...base, checks: { ...base.checks, [f.check]: items } };
}
