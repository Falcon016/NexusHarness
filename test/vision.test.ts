import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasImages, IMAGE_LEFT_OUT, withoutImages } from '../src/agent/context.js';
import { postJsonStream } from '../src/llm/http.js';
import { OpenAICompatProvider } from '../src/llm/openai.js';
import { isNoVisionError, ProviderError, type Message, type StreamRequest } from '../src/llm/types.js';
import { AutoProvider, callTool, makeAgent, say, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

/** What llama.cpp answers when a model loaded without a vision projector is sent an image. */
const LLAMA_REFUSAL =
  'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj';

/** A server that refuses any request holding an image, the way llama.cpp does without --mmproj. */
const textOnly = (reply: string) => (req: StreamRequest) => {
  if (hasImages(req.messages)) throw new ProviderError(`HTTP 500: ${LLAMA_REFUSAL}`, 500);
  return say(reply);
};

describe('a model that cannot see images', () => {
  it('recognises the refusal from the servers people run, and nothing else', () => {
    expect(isNoVisionError(LLAMA_REFUSAL)).toBe(true);
    expect(isNoVisionError('Model does not support images. Please use a model that does.')).toBe(true);
    expect(isNoVisionError('Qwen/Qwen3-8B is not a multimodal model')).toBe(true);
    expect(isNoVisionError('Invalid content type. image_url is only supported by certain models.')).toBe(
      true,
    );
    expect(isNoVisionError('the request exceeds the available context size')).toBe(false);
    expect(isNoVisionError('Invalid image data')).toBe(false);
  });

  it('replaces images with a note, and leaves a conversation without any untouched', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 't',
            content: 'Image shot.png',
            images: [{ mediaType: 'image/png', data: 'AAAA' }],
          },
        ],
      },
    ];
    const out = withoutImages(msgs);
    expect(hasImages(out)).toBe(false);
    expect(out[0]!.content[1]).toEqual({ type: 'text', text: IMAGE_LEFT_OUT });
    expect(out[1]!.content[0]).toMatchObject({ content: `Image shot.png\n${IMAGE_LEFT_OUT}` });
    expect(hasImages(msgs)).toBe(true); // the input is not changed
    const plain: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    expect(withoutImages(plain)).toBe(plain);
  });

  it('carries on after the server refuses a screenshot, and every later turn works', async () => {
    writeFileSync(join(ws.dir, 'shot.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
    const p = new AutoProvider([
      callTool('r1', 'read', { path: 'shot.png' }),
      textOnly('never sent: it held the image'),
      textOnly('The page did not load, so I checked the console instead.'),
      callTool('r2', 'read', { path: 'shot.png' }),
      textOnly('Still fine.'),
    ]);
    const { agent, events, session } = makeAgent(ws.dir, p);
    await agent.run('take a screenshot and check it');
    await agent.run('look again');

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    const notices = events.filter((e) => e.type === 'status').map((e) => (e as { text: string }).text);
    expect(notices.filter((t) => /can't see images/.test(t))).toHaveLength(1);
    expect(notices.join('\n')).toContain('--mmproj');
    expect(agent.model.vision).toBe(false);

    // Every request after the refusal went without images, and told the model where one was.
    const after = p.calls.slice(2);
    expect(after.every((r) => !hasImages(r.messages))).toBe(true);
    expect(JSON.stringify(after[0]!.messages)).toContain("this model can't see images");

    // The first screenshot is still saved (for a model that can see it); the second was never kept.
    const results = session
      .messages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result');
    expect(results.map((b) => !!b.images?.length)).toEqual([true, false]);
    expect(results[1]!.content).toContain(IMAGE_LEFT_OUT);
  });

  it('does not hold back errors that only look similar', async () => {
    const p = new AutoProvider([
      () => {
        throw new ProviderError(`HTTP 500: ${LLAMA_REFUSAL}`, 500);
      },
    ]);
    const { agent, events } = makeAgent(ws.dir, p);
    await agent.run('hello'); // no image anywhere: leaving images out would change nothing
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(agent.model.vision).toBeUndefined();
  });

  it('is not retried by the HTTP client, since it fails the same way every time', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { code: 500, message: LLAMA_REFUSAL } }), {
        status: 500,
      });
    }) as unknown as typeof fetch;
    await expect(
      postJsonStream({ url: 'http://x', headers: {}, body: {}, fetchImpl, sleep: async () => {} }),
    ).rejects.toMatchObject({ status: 500, retryable: false });
    expect(n).toBe(1);
  });

  it('is known before any image is sent when llama.cpp says it has no vision projector', async () => {
    const server = (vision: boolean) =>
      new OpenAICompatProvider({
        id: 'llamacpp',
        baseUrl: 'http://x/v1',
        fetchImpl: (async (url: string | URL) => {
          const path = new URL(String(url)).pathname;
          const body =
            path === '/v1/models'
              ? { data: [{ id: 'qwen', owned_by: 'llamacpp', meta: { n_ctx: 32768 } }] }
              : path === '/props'
                ? { default_generation_settings: { n_ctx: 32768 }, modalities: { vision } }
                : undefined;
          return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
        }) as unknown as typeof fetch,
      });
    expect((await server(false).listModels())[0]).toMatchObject({ id: 'qwen', vision: false });
    expect((await server(true).listModels())[0]!.vision).toBeUndefined();
  });
});
