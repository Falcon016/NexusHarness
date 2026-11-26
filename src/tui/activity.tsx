import { Text } from 'ink';
import { useTheme } from './context.js';
import { animationFrame, fmtDuration, type LiveAgent, type UiSnapshot } from './store.js';

/**
 * The line under the live area that says what the agent is doing right now, in plain words, and for how long:
 * reading the conversation, thinking, writing a file, running a command, compacting. A long silence from the
 * model is called out, so a slow local model looks slow rather than stuck, and a stuck one looks stuck.
 */

/** A spinning star, as the label shimmers. Text-presentation characters only: emoji widths vary by terminal. */
const STAR = ['·', '✢', '✣', '✶', '✻', '✽', '✻', '✶', '✣', '✢'];
/** No output for this long while generating is worth a word. */
const QUIET_MS = 30_000;

const CHARS_PER_TOKEN = 4;
export const fmtCount = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
      : String(Math.round(n));
const tokens = (chars: number) => fmtCount(chars / CHARS_PER_TOKEN);
const base = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

export interface ActivityDescription {
  /** What it is doing: "Writing os.css". */
  label: string;
  /** Plain details: how long, how much. */
  details: string[];
  /** A warning detail, shown in amber: a long silence. */
  warn?: string;
}

/** What a tool call being written will do, from its name and target. */
function draftLabel(d: NonNullable<LiveAgent['drafting']>): string {
  const t = d.target;
  switch (d.name) {
    case 'write':
      return t ? `Writing ${base(t)}` : 'Writing a file';
    case 'edit':
      return t ? `Editing ${base(t)}` : 'Editing a file';
    case 'bash':
      return 'Preparing a command';
    case 'todo_write':
      return 'Updating the task list';
    default:
      return `Preparing ${d.name}`;
  }
}

export function describeActivity(snap: UiSnapshot, now = Date.now()): ActivityDescription | undefined {
  const c = snap.compacting;
  if (c) {
    const details = [fmtDuration(now - c.since)];
    if (c.parts > 1) details.push(`part ${c.part} of ${c.parts}`);
    if (!c.chars) details.push(`reading ${c.pct}% of the context`);
    else details.push(`${c.thinking ? 'reasoning' : 'summary'} ${tokens(c.chars)} tokens`);
    if (snap.queued) details.push(`${snap.queued} message${snap.queued === 1 ? '' : 's'} waiting`);
    return { label: 'Compacting the conversation', details };
  }
  const running = snap.live.filter((a) => a.running);
  if (!running.length) return snap.status ? { label: snap.status, details: [] } : undefined;
  if (snap.swarmActive) {
    const started = Math.min(...running.map((a) => a.startedAt));
    return {
      label: snap.status ?? `${running.length} agent${running.length === 1 ? '' : 's'} working`,
      details: [fmtDuration(now - started)],
    };
  }
  const a = running.find((x) => x.name === 'main') ?? running[0]!;
  const act = a.activity ?? { kind: 'reading' as const, since: a.startedAt };
  const since = now - act.since;
  const details = [fmtDuration(since)];
  let label: string;
  switch (act.kind) {
    case 'reading':
      label = 'Reading the conversation';
      if (snap.contextTokens) details.push(`${fmtCount(snap.contextTokens)} tokens`);
      break;
    case 'thinking':
      label = 'Thinking';
      break;
    case 'writing':
      label = 'Writing the reply';
      break;
    case 'drafting':
      label = a.drafting ? draftLabel(a.drafting) : 'Preparing a tool call';
      break;
    case 'tools': {
      const names = a.tools.map((t) => t.name);
      label = !names.length
        ? 'Working'
        : names.length > 1
          ? `Running ${names.length} tools`
          : names[0] === 'bash'
            ? 'Running a command'
            : `Running ${names[0]}`;
      break;
    }
  }
  if (act.kind !== 'reading' && act.kind !== 'tools' && a.outChars)
    details.push(`↓ ${tokens(a.outChars)} tokens`);
  // The whole turn, when this step is only the latest part of a long one.
  if (now - a.startedAt - since > 60_000) details.push(`turn ${fmtDuration(now - a.startedAt)}`);
  const quiet = a.activeAt ? now - a.activeAt : 0;
  const warn =
    act.kind !== 'reading' && act.kind !== 'tools' && quiet >= QUIET_MS
      ? `no output for ${fmtDuration(quiet)}`
      : undefined;
  return { label: snap.status ?? label, details, ...(warn ? { warn } : {}) };
}

/** The label with a band of light passing over it, as the star turns. */
function Shimmer({ text, frame }: { text: string; frame: number }) {
  const t = useTheme();
  const span = text.length + 8;
  const at = (frame % span) - 4;
  return (
    <Text>
      {[...text].map((ch, i) => {
        const d = Math.abs(i - at);
        return (
          <Text key={i} color={d === 0 ? t.text : d === 1 ? t.sky : t.accent} bold={d === 0}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}

export function ActivityLine({ snap }: { snap: UiSnapshot }) {
  const t = useTheme();
  const busy = !!snap.compacting || snap.live.some((a) => a.running) || !!snap.status;
  // Moved by the store's heartbeat while busy (see UiStore.beat).
  const frame = busy ? animationFrame() : 0;
  const d = describeActivity(snap);
  if (!d) return null;
  return (
    <Text wrap="truncate-end">
      <Text color={snap.compacting ? t.gold : t.accent}>{STAR[frame % STAR.length]} </Text>
      <Shimmer text={`${d.label}…`} frame={frame} />
      <Text color={t.faint}> (</Text>
      <Text color={t.dim}>{d.details.join(' · ')}</Text>
      {d.warn ? <Text color={t.gold}>{` · ${d.warn}`}</Text> : null}
      <Text color={t.faint}>{') '}</Text>
      {snap.compacting || snap.live.some((a) => a.running) ? (
        <Text>
          <Text color={t.dim}>esc</Text>
          <Text color={t.faint}> interrupt</Text>
        </Text>
      ) : null}
    </Text>
  );
}
