import { describe, expect, it } from 'vitest';
import { describeActivity } from '../src/tui/activity.js';
import { UiStore, type LiveAgent, type UiSnapshot } from '../src/tui/store.js';

/** Feed the store an agent event and read the snapshot at once (it is normally published on a timer). */
function feeder(store: UiStore) {
  const s = store as unknown as { onAgentEvent(n: string, e: unknown): void; flush(): void };
  return {
    fire: (e: unknown) => s.onAgentEvent('main', e),
    now: () => {
      s.flush();
      return store.getSnapshot();
    },
  };
}

const NOW = 10_000_000;
function snap(main: Partial<LiveAgent>, extra: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    items: [],
    epoch: 0,
    live: [
      {
        name: 'main',
        text: '',
        thinking: 0,
        thought: '',
        tools: [],
        running: true,
        startedAt: NOW - 5_000,
        outChars: 0,
        ...main,
      },
    ],
    swarmActive: false,
    browser: { open: false, holder: 'agent' },
    contextTokens: 0,
    tokens: { input: 0, output: 0 },
    queued: 0,
    showThinking: false,
    ...extra,
  };
}

describe('the activity line', () => {
  it('says what the agent is doing, in words, with how long and how much', () => {
    expect(
      describeActivity(
        snap({ activity: { kind: 'reading', since: NOW - 3_000 } }, { contextTokens: 120_000 }),
        NOW,
      ),
    ).toEqual({
      label: 'Reading the conversation',
      details: ['3s', '120k tokens'],
    });
    expect(
      describeActivity(
        snap({ activity: { kind: 'thinking', since: NOW - 4_000 }, activeAt: NOW, outChars: 4_800 }),
        NOW,
      ),
    ).toEqual({ label: 'Thinking', details: ['4s', '↓ 1.2k tokens'] });
    expect(
      describeActivity(snap({ activity: { kind: 'writing', since: NOW - 1_000 }, activeAt: NOW }), NOW)
        ?.label,
    ).toBe('Writing the reply');
  });

  it('names the file a tool call is writing, or the kind of call', () => {
    const draft = (name: string, target?: string) =>
      describeActivity(
        snap({
          activity: { kind: 'drafting', since: NOW },
          activeAt: NOW,
          drafting: { id: 'x', name, chars: 10, ...(target ? { target } : {}) },
        }),
        NOW,
      )?.label;
    expect(draft('write', 'css/os.css')).toBe('Writing os.css');
    expect(draft('edit', 'src\\app.ts')).toBe('Editing app.ts');
    expect(draft('write')).toBe('Writing a file');
    expect(draft('bash', 'npm test')).toBe('Preparing a command');
    expect(draft('web_fetch')).toBe('Preparing web_fetch');
  });

  it('names what is running', () => {
    const tool = (name: string) => ({ id: name, name, description: '', startedAt: NOW, output: '' });
    const running = (...names: string[]) =>
      describeActivity(snap({ activity: { kind: 'tools', since: NOW }, tools: names.map(tool) }), NOW)?.label;
    expect(running('bash')).toBe('Running a command');
    expect(running('grep')).toBe('Running grep');
    expect(running('read', 'read', 'grep')).toBe('Running 3 tools');
  });

  it('calls out a long silence while generating, and shows the whole turn when it is long', () => {
    const d = describeActivity(
      snap({
        startedAt: NOW - 63 * 60_000,
        activity: { kind: 'drafting', since: NOW - 5 * 60_000 },
        activeAt: NOW - 45_000,
        drafting: { id: 'x', name: 'write', chars: 4000, target: 'os.css' },
        outChars: 4000,
      }),
      NOW,
    );
    expect(d).toEqual({
      label: 'Writing os.css',
      details: ['5m 00s', '↓ 1k tokens', 'turn 1h 03m'],
      warn: 'no output for 45s',
    });
    // Waiting for a long prompt to be read is expected, not a silence.
    expect(
      describeActivity(
        snap({ activity: { kind: 'reading', since: NOW - 90_000 }, activeAt: NOW - 90_000 }),
        NOW,
      )?.warn,
    ).toBeUndefined();
  });

  it('shows a compaction in progress, above everything else', () => {
    const c = { pct: 82, since: NOW - 75_000, chars: 0, thinking: false, part: 1, parts: 2, dropped: 0 };
    expect(describeActivity(snap({}, { compacting: c, queued: 1 }), NOW)).toEqual({
      label: 'Compacting the conversation',
      details: ['1m 15s', 'part 1 of 2', 'reading 82% of the context', '1 message waiting'],
    });
    expect(
      describeActivity(snap({}, { compacting: { ...c, chars: 2_000, thinking: true } }), NOW)?.details,
    ).toContain('reasoning 500 tokens');
    expect(describeActivity(snap({}, { compacting: { ...c, chars: 2_000 } }), NOW)?.details).toContain(
      'summary 500 tokens',
    );
  });

  it('is nothing when idle', () => {
    expect(describeActivity(snap({ running: false }), NOW)).toBeUndefined();
  });
});

describe('the store follows what the agent does', () => {
  it('moves from reading to thinking to writing a file, ending the reasoning when the call starts', () => {
    const store = new UiStore();
    const { fire, now } = feeder(store);
    fire({ type: 'turn_start' });
    fire({ type: 'request' });
    const kind = () => now().live.find((a) => a.name === 'main')!.activity?.kind;
    expect(kind()).toBe('reading');
    fire({ type: 'thinking', delta: 'Next is the CSS file.' });
    expect(kind()).toBe('thinking');
    fire({
      type: 'tool_call',
      id: 'w1',
      name: 'write',
      chars: 120,
      target: 'css/os.css',
      tail: 'body {\n\tmargin: 0;',
    });
    const main = now().live.find((a) => a.name === 'main')!;
    expect(main.activity?.kind).toBe('drafting');
    expect(main.thinkingUntil).toBeDefined(); // the thinking box gives way to the file being written
    expect(main.drafting).toMatchObject({
      name: 'write',
      target: 'css/os.css',
      tail: 'body {\n    margin: 0;',
    });
    fire({ type: 'tool_call', id: 'w1', name: 'write', chars: 400 });
    expect(now().live[0]!.outChars).toBe('Next is the CSS file.'.length + 400);
    fire({ type: 'turn_end', stopReason: 'end_turn' });
    expect(now().live[0]!.activity).toBeUndefined();
  });

  it('keeps the context meter current and reports a compaction once', () => {
    const store = new UiStore();
    const { fire, now } = feeder(store);
    fire({ type: 'context', tokens: 50_000 });
    expect(now().contextTokens).toBe(50_000);
    fire({ type: 'compaction', phase: 'start', pct: 85, usedTokens: 170_000, windowTokens: 200_000 });
    fire({ type: 'compaction', phase: 'progress', chars: 800, thinking: true, part: 1, parts: 1 });
    expect(now().compacting).toMatchObject({ pct: 85, chars: 800, thinking: true });
    fire({ type: 'compacted', droppedMessages: 140 });
    fire({ type: 'compaction', phase: 'end', ok: true, beforePct: 85, afterPct: 9, usedTokens: 18_000 });
    const s = now();
    expect(s.compacting).toBeUndefined();
    expect(s.contextTokens).toBe(18_000);
    const notices = s.items.filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Context compacted: 85% → 9%, 140 earlier messages summarised in \d+s\./);
  });

  it('keeps what the agent reports in the transcript instead of as a label that goes stale', () => {
    const store = new UiStore();
    const { fire, now } = feeder(store);
    fire({ type: 'status', text: 'Asking the model to bring its task list up to date' });
    const s = now();
    expect(s.status).toBeUndefined();
    expect(s.items.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Asking the model to bring its task list up to date',
    });
  });
});

describe('drawing the UI on one schedule', () => {
  it('spaces updates further apart when frames are slow to draw, and back when they are quick', () => {
    const store = new UiStore();
    expect(store.frameInterval()).toBe(50);
    for (let i = 0; i < 30; i++) store.frameDrawn(40);
    expect(store.frameInterval()).toBe(160); // drawing takes about a quarter of the time
    for (let i = 0; i < 30; i++) store.frameDrawn(500);
    expect(store.frameInterval()).toBe(250); // never slower than 4 a second
    for (let i = 0; i < 40; i++) store.frameDrawn(2);
    expect(store.frameInterval()).toBe(50);
  });

  it('keeps animations moving while the agent works, and stops when it is idle', async () => {
    const store = new UiStore();
    const { fire } = feeder(store);
    let published = 0;
    store.subscribe(() => published++);
    fire({ type: 'turn_start' });
    (store as unknown as { flush(): void }).flush();
    const before = published;
    await new Promise((r) => setTimeout(r, 350));
    expect(published - before).toBeGreaterThanOrEqual(2); // the heartbeat, with no events coming in
    fire({ type: 'turn_end', stopReason: 'end_turn' });
    (store as unknown as { flush(): void }).flush();
    const idle = published;
    await new Promise((r) => setTimeout(r, 300));
    expect(published).toBe(idle);
    store.dispose();
  });
});
