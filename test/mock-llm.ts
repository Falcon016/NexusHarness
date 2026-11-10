import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny OpenAI-compatible server for end-to-end tests and demos (`npm run mock`).
 * Behaviour is keyed off the latest user message so it needs no configuration:
 *   "read <file>"  → calls the read tool, then summarises
 *   "write <file>" → calls the write tool (exercises approvals), then confirms
 *   "run <cmd>"    → calls bash
 *   "think ..."    → streams reasoning (reasoning_content) before the reply
 *   "ponder ..."   → the same, written inline as <think>...</think> like some local models do
 *   "deliberate"   → long reasoning streamed slowly (one word every 30 ms), to watch it arrive live
 *   "essay"        → a long reply (numbered paragraphs, then a 40-line code block) streamed a line at a time
 *   "wide"         → rich markdown with lines wider than a small terminal (wrapping list items, a table, a long
 *                    code block of 120-character lines), streamed a line at a time
 *   "sneaky"       → calls bash with a description that does not say what the command does
 *   "longcmd"      → calls bash with a 30-line script
 *   "messy"        → calls bash for output with tabs, colours and carriage returns
 *   "tabby"        → a reply with tabs, colour codes and carriage returns of its own
 *   anything else  → plain text reply
 * Each tool result is answered with a short wrap-up so the loop terminates.
 */
export function startMockLlm(
  port = 0,
  opts: { models?: object[] } = {},
): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ data: opts.models ?? [{ id: 'mock-1' }, { id: 'mock-2' }] }));
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.statusCode = 404;
      return void res.end('{"error":{"message":"not found"}}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}') as {
        messages: { role: string; content: unknown }[];
        tools?: unknown[];
      };
      requests.push(j);
      const last = j.messages.at(-1)!;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const reason = (t: string) => {
        for (const w of t.match(/\S+\s*/g) ?? []) send({ choices: [{ delta: { reasoning_content: w } }] });
      };
      const text = (t: string) => {
        for (const w of t.match(/\S+\s*/g) ?? []) send({ choices: [{ delta: { content: w } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      };
      const call = (name: string, args: object) => {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_' + Math.random().toString(36).slice(2, 8),
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      };
      if (last.role === 'tool')
        text(`All done. Tool said: ${String(last.content).split('\n')[0]!.slice(0, 80)}`);
      else {
        const u = String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
        // Only offer tool calls when the request carries tools (summary requests do not).
        const m = j.tools?.length ? /\b(read|write|run)\s+(\S+)/i.exec(u) : null;
        if (m?.[1]!.toLowerCase() === 'read') call('read', { path: m[2] });
        else if (m?.[1]!.toLowerCase() === 'write')
          call('write', { path: m[2], content: 'hello from the mock\n' });
        else if (m?.[1]!.toLowerCase() === 'run') call('bash', { command: u.replace(/^.*\brun\s+/i, '') });
        else if (/\bsneaky\b/i.test(u) && j.tools?.length)
          call('bash', { command: 'mkdir sneaky-command-runs', description: 'List the files' });
        else if (/\bmessy\b/i.test(u) && j.tools?.length)
          call('bash', {
            command:
              "for i in $(seq 1 25); do printf 'col\\tcol\\tcol %s\\t\\033[31mred\\033[0m \\033[1mbold\\033[0m\\n' $i; printf 'progress 10%%\\rprogress 100%%\\n'; sleep 0.05; done",
          });
        else if (/\btabby\b/i.test(u)) {
          const lines = [
            'Here is the output, with tabs:\n\n',
            ...Array.from({ length: 30 }, (_, i) => `\tfield ${i}\t\tvalue ${i}\t\x1b[32mok\x1b[0m\r\n`),
            '\n```make\n',
            ...Array.from({ length: 20 }, (_, i) => `target${i}:\n\t$(CC) -o out${i} src${i}.c\n`),
            '```\n\nMessy done.',
          ];
          void (async () => {
            for (const l of lines) {
              send({ choices: [{ delta: { content: l } }] });
              await new Promise((r) => setTimeout(r, 15));
            }
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 900 } });
            res.end('data: [DONE]\n\n');
          })();
          return;
        } else if (/\blongcmd\b/i.test(u) && j.tools?.length)
          call('bash', {
            command: Array.from({ length: 30 }, (_, i) => `mkdir -p step-${i + 1}`).join('\n'),
            description: 'Make thirty folders',
          });
        else if (/\bwide\b/i.test(u)) {
          const long =
            'a list item that keeps going well past the width of a small terminal window, so it wraps';
          const lines = [
            '# A wide reply\n\n',
            ...Array.from({ length: 12 }, (_, i) => `- ${i + 1}: ${long}\n`),
            '\n| name | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n',
            '```python\n',
            ...Array.from({ length: 40 }, (_, i) => `print("row ${i}: ${'x'.repeat(100)}")\n`),
            '```\n\nThat is all.',
          ];
          void (async () => {
            for (const l of lines) {
              send({ choices: [{ delta: { content: l } }] });
              await new Promise((r) => setTimeout(r, 12));
            }
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 900 } });
            res.end('data: [DONE]\n\n');
          })();
          return;
        } else if (/\bessay\b/i.test(u)) {
          const lines = [
            ...Array.from(
              { length: 30 },
              (_, i) => `Paragraph ${String(i + 1).padStart(2, '0')}: a line of the reply.\n`,
            ),
            '\n```ts\n',
            ...Array.from(
              { length: 40 },
              (_, i) => `const line${String(i + 1).padStart(2, '0')} = ${i + 1};\n`,
            ),
            '```\n\nThat is the whole essay.',
          ];
          void (async () => {
            for (const l of lines) {
              send({ choices: [{ delta: { content: l } }] });
              await new Promise((r) => setTimeout(r, 15));
            }
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 900 } });
            res.end('data: [DONE]\n\n');
          })();
          return;
        } else if (/\bdeliberate\b/i.test(u)) {
          // Streams slowly, then finishes the response itself.
          const words = (
            'Let me work through this carefully before answering. First I will look at what the request asks for ' +
            'and which files it touches, then I will consider the edge cases one at a time so nothing is missed. ' +
            'The second paragraph keeps going without a line break for quite a while, the way real reasoning does ' +
            'when a model talks itself through a problem, so the display has to wrap it rather than wait for one.\n\n' +
            'Finally I will summarise the plan in one line.'
          ).match(/\S+\s*/g)!;
          void (async () => {
            for (const w of words) {
              send({ choices: [{ delta: { reasoning_content: w } }] });
              await new Promise((r) => setTimeout(r, 30));
            }
            text('Deliberated: the plan is ready.');
            send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 24 } });
            res.end('data: [DONE]\n\n');
          })();
          return;
        } else if (/\bthink\b/i.test(u)) {
          reason('The user wants me to think first.\nStep one: read the request.\nStep two: answer briefly.');
          text('Thought it through: the answer is 42.');
        } else if (/\bponder\b/i.test(u))
          text(
            '<think>Pondering inline, the way small local models do.</think>\n\nPondered: the answer is 42.',
          );
        else
          text(
            `Hello! This is the **mock** model. You said: ${u.slice(0, 60)}\n\n- It streams tokens\n- It supports \`inline code\`\n\n\`\`\`ts\nconst x = 1;\n\`\`\``,
          );
      }
      send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 24 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }),
    ),
  );
}

// `npx tsx test/mock-llm.ts` starts it on a fixed port for manual TUI testing.
if (process.argv[1]?.replaceAll('\\', '/').endsWith('test/mock-llm.ts')) {
  startMockLlm(11499).then(({ url }) => console.log(`mock LLM listening at ${url}`));
}
