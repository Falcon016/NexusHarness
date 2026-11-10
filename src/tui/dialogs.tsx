import { useDrawSize } from './size.js';
import { cleanText } from './clean.js';
import { Box, Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../agent/agent.js';
import { agentColor, useTheme } from './context.js';
import { diffColor } from './markdown.js';
import { GLYPH } from './theme.js';
import { Keys } from './views.js';

/** How a typed answer is asked for: masked (keys), pre-filled (an address to edit), with a line of help. */
export interface AskOptions {
  /** Show • for each character; spaces and line breaks in pasted text are dropped. */
  secret?: boolean;
  /** Text already in the box, to edit or accept with Enter. */
  initial?: string;
  help?: string;
  /** The dialog's title instead of "Question". */
  title?: string;
}

/** One-line text prompt used for feedback and free-form answers. */
function LineInput({
  label,
  onSubmit,
  onCancel,
  secret = false,
  initial = '',
}: {
  label: string;
  onSubmit(v: string): void;
  onCancel(): void;
  secret?: boolean;
  initial?: string;
}) {
  const t = useTheme();
  const [v, setV] = useState(initial);
  usePaste((s) => setV((x) => x + (secret ? s.replace(/\s+/g, '') : s.replace(/\s+/g, ' '))));
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit(v.trim());
    if (key.backspace || key.delete) return setV((x) => x.slice(0, -1));
    if (key.ctrl && input === 'u') return setV('');
    if (!key.ctrl && !key.meta && !key.tab && input) setV((x) => x + input);
  });
  return (
    <Box>
      <Text color={t.accent}>{label} </Text>
      <Text>{secret ? '•'.repeat(v.length) : v}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export function SelectList<T>({
  title,
  items,
  onSelect,
  onCancel,
  initial = 0,
}: {
  title: string;
  items: Choice<T>[];
  onSelect(v: T): void;
  onCancel(): void;
  initial?: number;
}) {
  const t = useTheme();
  const [i, setI] = useState(Math.min(initial, Math.max(0, items.length - 1)));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setI((x) => (x + items.length - 1) % items.length);
    if (key.downArrow) return setI((x) => (x + 1) % items.length);
    if (key.return && items[i]) return onSelect(items[i]!.value);
    if (/^[1-9]$/.test(input) && items[Number(input) - 1]) onSelect(items[Number(input) - 1]!.value);
  });
  const { rows } = useDrawSize();
  // As many items as the window has room for under the transcript (input, footer and borders take ~12 rows).
  const win = Math.max(3, Math.min(10, rows - 12));
  const start = Math.max(0, Math.min(i - Math.floor(win / 2), items.length - win));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.sky} paddingX={1}>
      <Text bold color={t.sky} wrap="truncate-end">
        {title}
        {items.length > win ? <Text color={t.faint}>{`  ${i + 1}/${items.length}`}</Text> : null}
      </Text>
      {items.length === 0 ? <Text color={t.dim}>Nothing to show.</Text> : null}
      {items.slice(start, start + win).map((it, k) => {
        const idx = start + k;
        const on = idx === i;
        return (
          <Text key={idx} color={on ? t.accent : t.text} wrap="truncate-end">
            {on ? '› ' : '  '}
            {cleanText(it.label)}
            {it.hint ? <Text color={t.faint}> {cleanText(it.hint)}</Text> : null}
          </Text>
        );
      })}
      <Keys
        items={[
          ['↑↓', 'move'],
          ['enter', 'select'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
}

export function ApprovalDialog({
  req,
  pending,
  onResolve,
  maxRows = 40,
}: {
  req: ApprovalRequest;
  pending: number;
  onResolve(r: ApprovalResponse): void;
  /** Rows the dialog may use; a long command or diff is shortened to fit. */
  maxRows?: number;
}) {
  const t = useTheme();
  const [i, setI] = useState(0);
  const [feedback, setFeedback] = useState(false);
  const options = [
    { label: 'Yes', hint: 'run it once', r: { allow: true } as ApprovalResponse },
    {
      label: `Yes, and don't ask again for ${req.grantLabel}`,
      hint: 'this session',
      r: { allow: true, always: true } as ApprovalResponse,
    },
    { label: 'No', hint: '', r: { allow: false } as ApprovalResponse },
    { label: 'No, and tell it what to do instead', hint: '', r: undefined },
  ];
  useInput(
    (input, key) => {
      if (key.escape) return onResolve({ allow: false });
      if (key.upArrow) return setI((x) => (x + options.length - 1) % options.length);
      if (key.downArrow || key.tab) return setI((x) => (x + 1) % options.length);
      const pick = (n: number) => {
        const o = options[n]!;
        if (o.r) onResolve(o.r);
        else setFeedback(true);
      };
      if (key.return) return pick(i);
      if (input === 'y') return pick(0);
      if (input === 'a') return pick(1);
      if (input === 'n') return pick(2);
      if (/^[1-4]$/.test(input)) pick(Number(input) - 1);
    },
    { isActive: !feedback },
  );

  const color = agentColor(t, req.agentId);
  const description = cleanText(req.description);
  const reason = cleanText(req.reason);
  // Sized to the window, so the whole dialog (its title above all) stays on screen. On a small window it goes
  // compact: no blank lines, key hints or reason, and the command shortened to a line.
  const compact = maxRows < 14;
  const fixed = 2 + 1 + 1 + 4 + (compact ? 0 : 3); // border, title, description, options; reason, keys, a gap
  let room = Math.max(2, maxRows - fixed);
  // The exact command gets the room first: it is what runs, whatever the description says.
  const cmdLines = req.command ? cleanText(req.command).replace(/\n+$/, '').split('\n') : [];
  const cmdBudget = compact ? Math.min(2, room) : Math.min(12, Math.max(2, Math.floor((room - 1) * 0.6)));
  const shownCmd = cmdLines.length <= cmdBudget ? cmdLines : cmdLines.slice(0, Math.max(1, cmdBudget - 1));
  const cmdHidden = cmdLines.length - shownCmd.length;
  if (cmdLines.length) room -= shownCmd.length + (cmdHidden ? 1 : 0) + (compact ? 0 : 1);
  const previewAll = req.preview ? cleanText(req.preview).split('\n') : [];
  const previewBudget = compact ? 0 : Math.min(18, room - 1);
  const previewLines =
    previewBudget < 2
      ? []
      : previewAll.length <= previewBudget
        ? previewAll
        : previewAll.slice(0, previewBudget - 1);
  const previewHidden = previewAll.length - previewLines.length;
  const gap = compact ? 0 : 1;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.gold} paddingX={1}>
      <Text>
        <Text bold color={t.gold}>
          {GLYPH.node} Approve this action?
        </Text>
        {req.agentId !== 'main' ? <Text color={color}> {req.agentId}</Text> : null}
        {pending > 1 ? <Text color={t.faint}> ({pending - 1} more waiting)</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        <Text bold>{req.toolName}</Text> <Text color={t.text}>{description.split('\n')[0]}</Text>
      </Text>
      {shownCmd.length ? (
        <Box flexDirection="column" marginTop={gap}>
          {shownCmd.map((l, k) => (
            <Text key={k} wrap="truncate-end">
              <Text color={t.faint}>{k === 0 ? '$ ' : '  '}</Text>
              <Text color={t.sky}>{l || ' '}</Text>
            </Text>
          ))}
          {cmdHidden ? <Text color={t.faint}>{`  … +${cmdHidden} more lines`}</Text> : null}
        </Box>
      ) : null}
      {compact ? null : (
        <Text color={t.dim} wrap="truncate-end">
          {reason}
        </Text>
      )}
      {previewLines.length ? (
        <Box flexDirection="column" marginTop={1}>
          {previewLines.map((l, k) => (
            <Text key={k} color={diffColor(l, t)} wrap="truncate-end">
              {l || ' '}
            </Text>
          ))}
          {previewHidden ? <Text color={t.faint}>… +{previewHidden} more lines</Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={gap}>
        {feedback ? (
          <LineInput
            label="Tell it what to do:"
            onSubmit={(v) => onResolve({ allow: false, ...(v ? { feedback: v } : {}) })}
            onCancel={() => setFeedback(false)}
          />
        ) : (
          options.map((o, k) => (
            <Text key={k} color={k === i ? t.accent : t.text} wrap="truncate-end">
              {k === i ? '› ' : '  '}
              {k + 1}. {o.label}
            </Text>
          ))
        )}
      </Box>
      {feedback || compact ? null : (
        <Keys
          items={[
            ['y', 'yes'],
            ['a', 'always'],
            ['n', 'no'],
            ['esc', 'deny'],
          ]}
        />
      )}
    </Box>
  );
}

export function QuestionDialog({
  agent,
  question,
  options,
  onAnswer,
  input,
}: {
  agent: string;
  question: string;
  options?: string[];
  onAnswer(a: string): void;
  input?: AskOptions;
}) {
  const t = useTheme();
  const [typing, setTyping] = useState(!options?.length);
  const color = agentColor(t, agent);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.teal} paddingX={1}>
      <Text>
        <Text bold color={t.teal}>
          {GLYPH.node} {input?.title ?? 'Question'}
        </Text>
        {agent !== 'main' ? <Text color={color}> from {agent}</Text> : null}
      </Text>
      <Text>{cleanText(question)}</Text>
      {input?.help ? <Text color={t.dim}>{input.help}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {typing ? (
          <LineInput
            label="❯"
            {...(input?.secret ? { secret: true } : {})}
            {...(input?.initial ? { initial: input.initial } : {})}
            onSubmit={(v) => onAnswer(v || '(no answer)')}
            onCancel={() => (options?.length ? setTyping(false) : onAnswer('(skipped)'))}
          />
        ) : (
          <SelectList<string | null>
            title="Choose"
            items={[
              ...(options ?? []).map((o) => ({ label: o, value: o as string | null })),
              { label: 'Type my own answer…', value: null },
            ]}
            onSelect={(v) => (v === null ? setTyping(true) : onAnswer(v))}
            onCancel={() => onAnswer('(skipped)')}
          />
        )}
      </Box>
    </Box>
  );
}
