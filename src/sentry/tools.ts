import { z } from 'zod';
import { defineTool, type AnyTool } from '../tools/types.js';
import { wrapUntrusted } from '../util/untrusted.js';
import type { Finding } from './findings.js';
import type { Sentry } from './sentry.js';
import { automatic, refusal, SHIELD_KINDS, type ShieldKind } from './shields.js';

/**
 * The tools sentry mode gives an agent: `sentry` to look (read-only) and `sentry_shield` to protect. A shield
 * other than the automatic kinds always waits for the user, whatever the approval mode.
 */

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function formatFindings(list: Finding[]): string {
  return list
    .map(
      (f) =>
        `${f.id} [${f.severity}] ${f.title}  (${f.check}, ${when(f.at)}${f.status !== 'open' ? `, ${f.status}` : ''})`,
    )
    .join('\n');
}

export function sentryTools(sentry: Sentry, autoShields: ShieldKind[], protect: () => string[]): AnyTool[] {
  const look = defineTool({
    name: 'sentry',
    description:
      'Sentry mode: what has changed on this machine and the LAN since the baseline, and the shields that are up. ' +
      'action "sweep" checks now; "findings" lists open changes; "shields" lists active shields; "ledger" shows ' +
      'the latest entries of the signed record and whether it is intact. Read-only.',
    risk: 'read',
    schema: z.object({ action: z.enum(['sweep', 'findings', 'shields', 'ledger']) }),
    describe: (i) => `sentry ${i.action}`,
    async execute(input) {
      if (input.action === 'sweep') {
        const fresh = await sentry.sweep();
        const open = sentry.findings().filter((f) => f.status === 'open');
        return {
          content: wrapUntrusted(
            'sentry findings',
            `${fresh.length} new change${fresh.length === 1 ? '' : 's'}. Open:\n${formatFindings(open) || 'none'}`,
          ),
        };
      }
      if (input.action === 'findings') {
        const open = sentry.findings().filter((f) => f.status === 'open');
        return {
          content: open.length ? wrapUntrusted('sentry findings', formatFindings(open)) : 'No open findings.',
        };
      }
      if (input.action === 'shields') {
        const s = sentry.store.all().filter((x) => x.status === 'active');
        return {
          content: s.length
            ? s
                .map(
                  (x) =>
                    `${x.id} ${x.kind} ${x.target} (by ${x.by}, ${when(x.at)}${x.expires ? `, until ${when(x.expires)}` : ''}): ${x.reason}`,
                )
                .join('\n')
            : 'No shields up.',
        };
      }
      const v = sentry.ledger.verify();
      const recent = sentry.ledger
        .recent(15)
        .map((e) => `#${e.seq} ${when(e.at)} ${e.event} ${JSON.stringify(e.data).slice(0, 160)}`);
      return {
        content: `${v.ok ? `Ledger intact (${v.count} entries).` : `LEDGER BROKEN at entry ${v.at}: ${v.why}.`}\n${recent.join('\n')}`,
      };
    },
  });

  const shield = defineTool({
    name: 'sentry_shield',
    description:
      'Put up or lift a sentry shield: a narrow, reversible protection that is recorded on the signed ledger. ' +
      'kinds: "block-ip" (an IPv4 address, for `minutes`, default 60), "quarantine-file" (full path; moved aside, ' +
      'never deleted), "quarantine-key" (an SSH key as sentry lists it: "<type> <fingerprint>"), "stop-service" ' +
      '("name.service"), "kill-process" (a pid; cannot be undone), "lock-account" (a user name). Blocking an ' +
      'outside address and quarantining a file you can move happen at once; every other shield, and lifting one, ' +
      'waits for the user. Always give the reason, with the evidence.',
    risk: 'exec',
    schema: z.object({
      action: z.enum(['raise', 'lift']),
      kind: z.enum(SHIELD_KINDS as [ShieldKind, ...ShieldKind[]]).optional(),
      target: z.string().optional(),
      reason: z.string().describe('Why, with the evidence'),
      minutes: z.number().int().min(1).max(10080).optional(),
      id: z.string().optional().describe('For lift: the shield id'),
    }),
    describe: (i) =>
      i.action === 'lift' ? `lift shield ${i.id ?? '?'}` : `${i.kind ?? '?'} ${i.target ?? '?'}`,
    primaryArg: (i) => (i.action === 'lift' ? `lift ${i.id ?? ''}` : `${i.kind ?? ''} ${i.target ?? ''}`),
    approval(i) {
      if (i.action === 'raise' && i.kind && i.target && automatic(i.kind, i.target, autoShields))
        return { action: 'allow', reason: `Automatic sentry shield (${i.kind})` };
      return {
        action: 'ask',
        reason:
          i.action === 'lift'
            ? 'Lifting a shield removes a protection'
            : 'A sentry shield that changes the system needs your approval',
      };
    },
    async preview(i) {
      if (i.action === 'lift') {
        const s = i.id ? sentry.store.get(i.id) : undefined;
        return s ? `Lift ${s.kind} ${s.target} (put up ${when(s.at)} by ${s.by}: ${s.reason})` : undefined;
      }
      if (!i.kind || !i.target) return undefined;
      const no = refusal(i.kind, i.target, { protect: protect() });
      return no ? `This will be refused: ${no}` : `${i.kind} ${i.target}\nReason: ${i.reason}`;
    },
    async execute(i, ctx) {
      if (i.action === 'lift') {
        if (!i.id) return { content: 'lift needs the shield id.', isError: true };
        const r = await sentry.lift(i.id, ctx.agentId === 'main' ? 'user' : 'agent');
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      }
      if (!i.kind || !i.target) return { content: 'raise needs a kind and a target.', isError: true };
      const by = automatic(i.kind, i.target, autoShields) ? 'sentry' : 'agent';
      const out = await sentry.raise({
        kind: i.kind,
        target: i.target.trim(),
        reason: i.reason,
        by,
        ...(i.minutes ? { minutes: i.minutes } : {}),
      });
      return out.ok
        ? {
            content:
              `Shield ${out.shield.id} up: ${out.shield.kind} ${out.shield.target}` +
              (out.shield.expires ? ` until ${when(out.shield.expires)}` : '') +
              (out.note ? `; ${out.note}` : '') +
              (out.shield.reversible ? '' : ' (cannot be undone)'),
          }
        : { content: `Not done: ${out.error}`, isError: true };
    },
  });

  return [look as unknown as AnyTool, shield as unknown as AnyTool];
}
