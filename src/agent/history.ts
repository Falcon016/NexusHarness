import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ContentBlock, Message } from '../llm/types.js';
import { Session, type Entry } from './session.js';

/**
 * Reading saved conversations, for the `sessions` tool and `/resume`. Every conversation is kept as JSONL under
 * `<data>/sessions/<project key>/`; this turns them into something an agent (or a person) can list, search and
 * read, without loading every file in full just to show a list.
 */

/** Where saved conversations live and which one is in use now. */
export interface HistorySource {
  /** `<data>/sessions`: one folder per project. */
  root: string;
  /** This project's folder name under `root`. */
  project: string;
  /** The file of the conversation in use (undefined when it is not saved). */
  currentFile(): string | undefined;
}

export interface SessionInfo {
  id: string;
  file: string;
  cwd: string;
  started: number;
  updated: number;
  bytes: number;
  /** The first thing the user asked. */
  first: string;
  /** The last thing the user asked. */
  last: string;
  current: boolean;
}

export interface TranscriptEntry {
  /** Position in the conversation, from 1. */
  n: number;
  ts: number;
  role: 'user' | 'assistant' | 'tool' | 'summary';
  text: string;
}

const CHUNK = 64 * 1024;
const TODO_CHECK = '[Task list check]';

function readSlice(file: string, from: 'start' | 'end', bytes = CHUNK): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from === 'start' ? 0 : size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const userText = (m: Message): string | undefined => {
  if (m.role !== 'user') return undefined;
  const t = m.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return t && !t.startsWith(TODO_CHECK) && !t.startsWith('[Summary of the earlier conversation')
    ? t
    : undefined;
};

/** User prompts found in a piece of a session file (whole lines only; a cut line is skipped). */
function promptsIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const e = JSON.parse(line) as Entry;
      const t = e.type === 'message' ? userText(e.message) : undefined;
      if (t) out.push(t);
    } catch {
      /* a line cut at the edge of the slice */
    }
  }
  return out;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A session's summary from the start and end of its file: cheap even for very long conversations. */
export function sessionInfo(file: string, currentFile?: string): SessionInfo | undefined {
  try {
    const st = statSync(file);
    const head = readSlice(file, 'start');
    const header = JSON.parse(head.slice(0, head.indexOf('\n'))) as {
      type?: string;
      id?: string;
      cwd?: string;
      ts?: number;
    };
    if (header.type !== 'session') return undefined;
    let first = promptsIn(head)[0];
    let last = (st.size > CHUNK ? promptsIn(readSlice(file, 'end')) : promptsIn(head)).at(-1);
    if (!first || !last) {
      // A first message longer than the slice (a big paste): read the whole file once.
      const prompts = Session.load(file)
        .path()
        .flatMap((e) => (e.type === 'message' ? (userText(e.message) ?? []) : []));
      first ??= prompts[0];
      last ??= prompts.at(-1);
    }
    return {
      id: header.id ?? basename(file, '.jsonl'),
      file,
      cwd: header.cwd ?? '',
      started: header.ts ?? st.birthtimeMs,
      updated: st.mtimeMs,
      bytes: st.size,
      first: oneLine(first ?? '(no messages)', 100),
      last: oneLine(last ?? first ?? '(no messages)', 100),
      current: !!currentFile && file === currentFile,
    };
  } catch {
    return undefined;
  }
}

/** Session files to look at: this project's, or every project's. Newest first. */
export function sessionFiles(src: HistorySource, scope: 'project' | 'all' = 'project'): string[] {
  const dirs =
    scope === 'all'
      ? (existsSync(src.root) ? readdirSync(src.root) : []).map((d) => join(src.root, d))
      : [join(src.root, src.project)];
  const files: { file: string; mtime: number }[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = join(dir, n);
      try {
        files.push({ file, mtime: statSync(file).mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}

export function listSessions(
  src: HistorySource,
  scope: 'project' | 'all' = 'project',
  limit = 30,
): SessionInfo[] {
  const current = src.currentFile();
  return sessionFiles(src, scope)
    .slice(0, limit)
    .flatMap((f) => sessionInfo(f, current) ?? []);
}

/**
 * Find a session by id, unique id prefix, `latest` (the newest one that is not in use) or `current`. Only files
 * from the listing can match: the id is never turned into a path.
 */
export function findSession(
  src: HistorySource,
  id: string,
  scope: 'project' | 'all' = 'project',
): { file: string } | { error: string } {
  const current = src.currentFile();
  const files = sessionFiles(src, scope);
  const want = id.trim().replace(/\.jsonl$/, '');
  if (want === 'current') return current ? { file: current } : { error: 'This conversation is not saved.' };
  if (want === 'latest') {
    const f = files.find((x) => x !== current);
    return f ? { file: f } : { error: 'There is no earlier saved conversation here.' };
  }
  const hits = files.filter((f) => basename(f, '.jsonl').startsWith(want));
  if (hits.length === 1) return { file: hits[0]! };
  if (!hits.length) return { error: `No saved conversation "${id}". List them with action "list".` };
  return { error: `"${id}" matches ${hits.length} conversations; give more of the id.` };
}

const toolArg = (input: unknown): string => {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.path ?? o.url ?? o.pattern ?? o.query ?? o.name;
  return typeof v === 'string' ? v : JSON.stringify(input);
};

/** The conversation as it reads: prompts, replies, tool calls and results, and compaction summaries. */
export function transcript(from: string | Session): TranscriptEntry[] {
  const s = typeof from === 'string' ? Session.load(from) : from;
  const out: TranscriptEntry[] = [];
  const names = new Map<string, string>();
  const add = (ts: number, role: TranscriptEntry['role'], text: string) => {
    if (text.trim()) out.push({ n: out.length + 1, ts, role, text: text.trim() });
  };
  for (const e of s.path()) {
    if (e.type === 'compaction') {
      add(e.ts, 'summary', `Summary written when the conversation was compacted:\n${e.summary}`);
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m.role === 'user') {
      const t = userText(m);
      if (t) add(e.ts, 'user', t);
      for (const b of m.content)
        if (b.type === 'tool_result')
          add(
            e.ts,
            'tool',
            `${names.get(b.toolUseId) ?? 'tool'}${b.isError ? ' (error)' : ''}: ${b.content}`,
          );
    } else {
      const parts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) parts.push(b.text.trim());
        else if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          parts.push(`→ ${b.name}: ${oneLine(toolArg(b.input), 300)}`);
        }
      }
      add(e.ts, 'assistant', parts.join('\n'));
    }
  }
  return out;
}

export interface SearchHit {
  id: string;
  cwd: string;
  n: number;
  ts: number;
  role: TranscriptEntry['role'];
  snippet: string;
}

/**
 * Entries that contain every word of `query` (or the exact phrase, in quotes), newest conversations first.
 * Tool results are searched too, so an error message or a file name finds where it came up.
 */
export function searchSessions(
  src: HistorySource,
  query: string,
  scope: 'project' | 'all' = 'project',
  opts: { maxHits?: number; perSession?: number; maxFiles?: number; maxBytes?: number } = {},
): { hits: SearchHit[]; searched: number; skipped: number } {
  const phrase = /^".+"$/.test(query.trim()) ? [query.trim().slice(1, -1).toLowerCase()] : undefined;
  const terms = phrase ?? query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], searched: 0, skipped: 0 };
  const maxHits = opts.maxHits ?? 30;
  const files = sessionFiles(src, scope).slice(0, opts.maxFiles ?? 200);
  // Sessions with screenshots can be large: read at most this much in one search (newest conversations first).
  let budget = opts.maxBytes ?? 256 * 1024 * 1024;
  const hits: SearchHit[] = [];
  let searched = 0;
  let skipped = 0;
  for (const file of files) {
    if (hits.length >= maxHits) break;
    try {
      const size = statSync(file).size;
      if (size > budget) {
        skipped++;
        continue;
      }
      budget -= size;
    } catch {
      continue;
    }
    let entries: TranscriptEntry[];
    let header: { id: string; cwd: string };
    try {
      // Cheap filter first: skip files that do not contain every word at all (as JSON writes it).
      const raw = readSlice(file, 'start', Number.MAX_SAFE_INTEGER).toLowerCase();
      searched++;
      if (!terms.every((t) => raw.includes(JSON.stringify(t).slice(1, -1)))) continue;
      const s = Session.load(file);
      header = { id: s.id, cwd: s.cwd };
      entries = transcript(s);
    } catch {
      continue;
    }
    let inFile = 0;
    for (const e of entries) {
      const low = e.text.toLowerCase();
      if (!terms.every((t) => low.includes(t))) continue;
      const at = low.indexOf(terms[0]!);
      const start = Math.max(0, at - 90);
      const snippet =
        (start ? '…' : '') +
        e.text.slice(start, at + terms[0]!.length + 150).replace(/\s+/g, ' ') +
        (at + terms[0]!.length + 150 < e.text.length ? '…' : '');
      hits.push({ ...header, n: e.n, ts: e.ts, role: e.role, snippet });
      if (++inFile >= (opts.perSession ?? 5) || hits.length >= maxHits) break;
    }
  }
  return { hits, searched, skipped };
}
