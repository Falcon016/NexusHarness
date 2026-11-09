import { z } from 'zod';
import { findSession, listSessions, searchSessions, transcript } from '../agent/history.js';
import { redact } from '../util/redact.js';
import { wrapUntrusted } from '../util/untrusted.js';
import { defineTool } from './types.js';

const MAX_OUTPUT = 24_000;
const ENTRY_MAX = 1500;

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const kb = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;

export const sessionsTool = defineTool({
  name: 'sessions',
  description:
    'Look through the conversations saved for this folder, including this one. Every session is kept on disk, so ' +
    'use this when the user refers to earlier work ("what did we do yesterday", "pick up where we left off"), ' +
    'or to get back details that a compaction summary left out. ' +
    'action "list": recent sessions with their first and last request. ' +
    'action "search": entries containing every word of `query` ("quotes" for an exact phrase), tool output included. ' +
    'action "read": one session\'s transcript; `id` is an id or prefix from list/search, "latest" (the newest ' +
    'other than this one) or "current". Without `offset` it shows the last `limit` entries; `offset` (from 1) ' +
    'pages from the start. `scope: "all"` covers every folder.',
  risk: 'read',
  parallel: true,
  schema: z.object({
    action: z.enum(['list', 'search', 'read']),
    query: z.string().optional().describe('For search: words that must all appear'),
    id: z.string().optional().describe('For read: session id or prefix, "latest" or "current"'),
    offset: z.number().int().min(1).optional().describe('For read: first entry to show'),
    limit: z.number().int().min(1).max(200).optional().describe('For read: entries to show (default 40)'),
    scope: z.enum(['project', 'all']).optional().describe('"project" (default) or "all" folders'),
  }),
  describe: (i) =>
    i.action === 'search'
      ? `search "${i.query ?? ''}"`
      : i.action === 'read'
        ? `read ${i.id ?? 'latest'}`
        : 'list',
  async execute(input, ctx) {
    const src = ctx.history;
    if (!src) return { content: 'Saved sessions are not available here.', isError: true };
    const scope = input.scope ?? 'project';

    if (input.action === 'list') {
      const list = listSessions(src, scope);
      if (!list.length) return { content: 'No saved conversations yet.' };
      const lines = list.map(
        (s) =>
          `${s.id}${s.current ? ' (this conversation)' : ''}  started ${when(s.started)}, last active ${when(s.updated)}, ${kb(s.bytes)}` +
          (scope === 'all' ? `\n  folder: ${s.cwd}` : '') +
          `\n  first: ${s.first}` +
          (s.last !== s.first ? `\n  last:  ${s.last}` : ''),
      );
      return { content: wrapUntrusted('saved sessions', redact(lines.join('\n'))) };
    }

    if (input.action === 'search') {
      if (!input.query?.trim()) return { content: 'search needs a query.', isError: true };
      const { hits, searched, skipped } = searchSessions(src, input.query, scope);
      const note = skipped
        ? ` (${skipped} older, very large conversation${skipped === 1 ? ' was' : 's were'} not searched)`
        : '';
      if (!hits.length)
        return {
          content: `No matches in ${searched} saved conversation${searched === 1 ? '' : 's'}${note}.`,
        };
      const current = src.currentFile();
      const lines = hits.map(
        (h) =>
          `${h.id}${current?.includes(h.id) ? ' (this conversation)' : ''} #${h.n} ${h.role}, ${when(h.ts)}` +
          (scope === 'all' ? ` [${h.cwd}]` : '') +
          `\n  ${h.snippet}`,
      );
      return {
        content:
          wrapUntrusted('saved sessions', redact(lines.join('\n'))) +
          `\nRead around a match with action "read", its id and an offset a little before its #number.${note}`,
      };
    }

    const found = findSession(src, input.id ?? 'latest', scope);
    if ('error' in found) return { content: found.error, isError: true };
    const entries = transcript(found.file);
    if (!entries.length) return { content: 'That conversation has no messages.' };
    const limit = input.limit ?? 40;
    const start = input.offset
      ? Math.min(input.offset, entries.length) - 1
      : Math.max(0, entries.length - limit);
    const page = entries.slice(start, start + limit);
    let body = '';
    for (const e of page) {
      const text =
        e.text.length > ENTRY_MAX
          ? `${e.text.slice(0, ENTRY_MAX)}… (${e.text.length - ENTRY_MAX} more characters)`
          : e.text;
      const block = `#${e.n} ${e.role} · ${when(e.ts)}\n${text}\n\n`;
      if (body.length + block.length > MAX_OUTPUT) {
        body += `[stopped at #${e.n} to keep this short: read on with offset ${e.n}]\n`;
        break;
      }
      body += block;
    }
    const id = found.file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
    const head =
      `Conversation ${id}: entries ${page[0]!.n}–${page.at(-1)!.n} of ${entries.length}.` +
      (start > 0 ? ` Earlier entries: offset 1 to ${start}.` : '');
    return { content: `${head}\n${wrapUntrusted(`saved session ${id}`, redact(body.trimEnd()))}` };
  },
});
