import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, unreachable } from '../src/agent/agent.js';
import { Session } from '../src/agent/session.js';
import type { ResolvedModel } from '../src/llm/registry.js';
import { ProviderError, type ModelInfo, type ServerStatus, type StreamRequest } from '../src/llm/types.js';
import { metric, OpenAICompatProvider } from '../src/llm/openai.js';
import { formatNodes, isLocalUrl, Mesh } from '../src/mesh/mesh.js';
import { TaskRunner, type MeshService } from '../src/mesh/tasks.js';
import {
  fetchTelemetry,
  newNodeKey,
  parseNvidiaSmi,
  sign,
  startNodeService,
  verify,
  type Telemetry,
} from '../src/mesh/telemetry.js';
import { billionsFromName, classifyTask, tierOf } from '../src/mesh/tiers.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import {
  AutoProvider,
  callTool,
  makeAgent,
  say,
  standardTools,
  testConfig,
  tmpWorkspace,
  type Turn,
} from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

/** A model server on one machine: scripted replies, plus what it says about its models and how busy it is. */
class FakeServer extends AutoProvider {
  down = false;
  constructor(
    readonly name: string,
    public models: ModelInfo[],
    public st: ServerStatus = {},
    turns: Turn[] = [],
  ) {
    super(turns);
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.down) throw new Error('fetch failed');
    return this.models;
  }
  async status(): Promise<ServerStatus> {
    return this.st;
  }
}

function meshOf(servers: FakeServer[], over: Record<string, unknown> = {}) {
  const providers = Object.fromEntries(
    servers.map((s) => [s.name, { type: 'openai', baseUrl: `http://${s.name}/v1` }]),
  );
  const config = testConfig({ providers, mesh: { enabled: true, ...over } });
  const byName = new Map(servers.map((s) => [s.name, s]));
  return new Mesh({ config, provider: (id) => byName.get(id)!, key: () => undefined });
}

const resolvedOn = (s: FakeServer, id: string): ResolvedModel => ({
  provider: s,
  providerId: s.name,
  model: id,
  contextWindow: 32_768,
  contextSource: 'detected',
});

describe('tiers', () => {
  it('reads model sizes from names and sorts them into tiers', () => {
    expect(billionsFromName('swift-1.5-qwen3.8-27b-iq3s')).toBe(27);
    expect(billionsFromName('qwen3-30b-a3b')).toBe(30);
    expect(billionsFromName('Llama-3.2-1B-Instruct')).toBe(1);
    expect(billionsFromName('phi-4')).toBeUndefined();
    expect(tierOf('qwen3-4b')).toBe('fast');
    expect(tierOf('qwen3-14b')).toBe('standard');
    expect(tierOf('qwen3-27b')).toBe('strong');
    expect(tierOf('mystery-model')).toBe('standard');
    expect(tierOf('mystery-model', 3e9)).toBe('fast'); // the server's own count wins
  });

  it('guesses how hard a task is from its wording', () => {
    expect(classifyTask('Find every TODO in src/ and list them with file paths')).toBe('fast');
    expect(classifyTask('Run the tests and summarise the failures')).toBe('fast');
    expect(classifyTask('Debug why the websocket drops after 30 seconds')).toBe('strong');
    expect(classifyTask('Add a dark mode toggle to the settings page')).toBe('standard');
  });
});

describe('the node service', () => {
  const sample: Telemetry = {
    hostname: 'p40',
    platform: 'linux',
    cpuCount: 8,
    cpuLoad: 0.25,
    memoryTotal: 32 * 1024 ** 3,
    memoryFree: 20 * 1024 ** 3,
    uptime: 100,
    gpus: [{ name: 'Tesla P40', memoryTotal: 24576, memoryUsed: 20000, utilization: 97, temperature: 61 }],
    at: 1,
  };
  let server: Server | undefined;
  afterEach(() => server?.close());
  const start = async (key: string) => {
    server = await startNodeService({ key, port: 0, host: '127.0.0.1', collect: async () => sample });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('reads nvidia-smi', () => {
    expect(
      parseNvidiaSmi(
        'Tesla P40, 24576, 20000, 97, 61\nNVIDIA GeForce RTX 4070 SUPER, 12282, 900, [N/A], 40\n',
      ),
    ).toEqual([
      { name: 'Tesla P40', memoryTotal: 24576, memoryUsed: 20000, utilization: 97, temperature: 61 },
      { name: 'NVIDIA GeForce RTX 4070 SUPER', memoryTotal: 12282, memoryUsed: 900, temperature: 40 },
    ]);
  });

  it('answers a signed request with signed numbers, and nothing else', async () => {
    const key = newNodeKey();
    const url = await start(key);
    expect(await fetchTelemetry(url, key)).toEqual(sample);
    // Another key, a stale timestamp, another path or method: refused.
    expect(await fetchTelemetry(url, newNodeKey())).toBeUndefined();
    expect(await fetchTelemetry(url, key, { now: () => Date.now() - 5 * 60_000 })).toBeUndefined();
    expect((await fetch(`${url}/run`, { method: 'POST', body: 'rm -rf /' })).status).toBe(404);
    expect((await fetch(`${url}/telemetry`)).status).toBe(401);
  });

  it('notices a reply changed on the way back', async () => {
    const key = newNodeKey();
    const url = await start(key);
    const tampered = (async (u: string, init: RequestInit) => {
      const r = await fetch(u, init);
      const body = (await r.text()).replace('"cpuLoad":0.25', '"cpuLoad":0.01');
      return new Response(body, { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    expect(await fetchTelemetry(url, key, { fetchImpl: tampered })).toBeUndefined();
    expect(verify(key, sign(key, 'a', 'b'), 'a', 'b')).toBe(true);
    expect(verify(key, sign(key, 'a', 'b'), 'a', 'c')).toBe(false);
  });
});

describe('what a llama.cpp server reports', () => {
  it('reads slots and speed from /slots and /metrics', async () => {
    const fetchImpl = (async (u: string) => {
      const path = new URL(u).pathname;
      if (path === '/slots') return Response.json([{ is_processing: true }, { is_processing: false }]);
      if (path === '/metrics')
        return new Response(
          '# HELP llamacpp:predicted_tokens_seconds Average generation speed\n' +
            'llamacpp:predicted_tokens_seconds 19.4\nllamacpp:kv_cache_usage_ratio 0.61\nllamacpp:requests_deferred 2\n',
        );
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ id: 'p40', baseUrl: 'http://x/v1', fetchImpl });
    expect(await p.status()).toEqual({
      slotsTotal: 2,
      slotsBusy: 1,
      tokensPerSecond: 19.4,
      kvCacheUsage: 0.61,
      requestsWaiting: 2,
    });
    expect(metric('llamacpp:requests_processing{slot="0"} 3', 'llamacpp:requests_processing')).toBe(3);
  });
});

describe('which machines count', () => {
  it('takes model servers on this machine and the local network, never a cloud API', () => {
    for (const u of [
      'http://127.0.0.1:8080/v1',
      'http://localhost:1234/v1',
      'http://192.168.1.40:8080/v1',
      'http://10.0.0.5/v1',
      'http://172.20.1.2/v1',
      'http://100.101.102.103/v1', // Tailscale
      'http://p40.lan:8080/v1',
      'http://macmini.local:8080/v1',
      'http://server2:8080/v1',
    ])
      expect(isLocalUrl(u), u).toBe(true);
    for (const u of [
      'https://api.openai.com/v1',
      'https://openrouter.ai/api/v1',
      'http://8.8.8.8/v1',
      'nonsense',
    ])
      expect(isLocalUrl(u), u).toBe(false);
  });

  it('leaves out cloud providers and untouched built-in defaults unless one is the model in use', async () => {
    const config = testConfig({
      model: 'ollama/qwen3-4b',
      providers: {
        openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1' },
        ollama: { type: 'openai', baseUrl: 'http://localhost:11434/v1' },
        lmstudio: { type: 'openai', baseUrl: 'http://localhost:1234/v1' },
        llamacpp: { type: 'openai', baseUrl: 'http://192.168.1.50:8080/v1' },
      },
      mesh: { enabled: true },
    });
    const mesh = new Mesh({ config, provider: () => new FakeServer('x', []), key: () => undefined });
    expect(
      mesh
        .nodes()
        .map((n) => n.name)
        .sort(),
    ).toEqual(['llamacpp', 'ollama']);
  });
});

describe('placing work', () => {
  const mac = () =>
    new FakeServer('mac', [{ id: 'qwen3-4b', contextWindow: 32768 }], { slotsTotal: 2, slotsBusy: 0 });
  const rtx = () =>
    new FakeServer('rtx', [{ id: 'qwen3-14b', contextWindow: 65536 }], { slotsTotal: 1, slotsBusy: 0 });
  const p40 = () =>
    new FakeServer('p40', [{ id: 'qwen3.8-27b', contextWindow: 131072 }], {
      slotsTotal: 1,
      slotsBusy: 0,
      tokensPerSecond: 19,
    });

  it('puts each tier on the right size of model, and the nearest size up when there is none', async () => {
    const mesh = meshOf([mac(), rtx(), p40()]);
    await mesh.probe();
    expect(mesh.pick({ tier: 'fast' })?.model.spec).toBe('mac/qwen3-4b');
    expect(mesh.pick({ tier: 'standard' })?.model.spec).toBe('rtx/qwen3-14b');
    expect(mesh.pick({ tier: 'strong' })?.model.spec).toBe('p40/qwen3.8-27b');
    const noSmall = meshOf([rtx(), p40()]);
    await noSmall.probe();
    expect(noSmall.pick({ tier: 'fast' })?.model.spec).toBe('rtx/qwen3-14b');
    // Not enough room for the work: a bigger window instead.
    expect(mesh.pick({ tier: 'fast', minContext: 100_000 })?.model.spec).toBe('p40/qwen3.8-27b');
  });

  it('spreads tasks over free machines and keeps sensitive work on trusted ones', async () => {
    const a = new FakeServer('a', [{ id: 'qwen3-4b' }], { slotsTotal: 1 });
    const b = new FakeServer('b', [{ id: 'qwen3-4b' }], { slotsTotal: 1 });
    const mesh = meshOf([a, b], {
      nodes: { a: { providers: ['a'] }, b: { providers: ['b'], sensitive: false } },
    });
    await mesh.probe();
    expect(mesh.pick({ tier: 'fast' })?.node).toBe('a');
    const release = mesh.claim('a');
    expect(mesh.pick({ tier: 'fast', sensitive: false })?.node).toBe('b'); // a is busy now
    expect(mesh.pick({ tier: 'fast' })?.node).toBe('a'); // sensitive work waits for a
    release();
  });

  it('sends work to an idle bigger model rather than queue behind a busy small one', async () => {
    const mesh = meshOf([mac(), p40()]);
    await mesh.probe();
    const r1 = mesh.claim('mac');
    const r2 = mesh.claim('mac');
    const p = mesh.pick({ tier: 'fast' });
    expect(p?.model.spec).toBe('p40/qwen3.8-27b');
    expect(p?.why).toMatch(/mac busy$/);
    r1();
    r2();
    expect(mesh.pick({ tier: 'fast' })?.model.spec).toBe('mac/qwen3-4b');
  });

  it("keeps tasks off a one-slot server holding the main agent's conversation", async () => {
    const mesh = meshOf([mac(), rtx(), p40()]);
    await mesh.probe();
    const busyMac = [mesh.claim('mac'), mesh.claim('mac')]; // both of its slots
    // The P40 is the fastest bigger machine, but it holds the conversation: the RTX takes the overflow.
    const p = mesh.pick({ tier: 'fast', protect: ['p40/qwen3.8-27b'] });
    expect(p?.model.spec).toBe('rtx/qwen3-14b');
    expect(mesh.pick({ tier: 'strong', protect: ['p40/qwen3.8-27b'] })?.why).toMatch(
      /holding the main conversation/,
    );
    busyMac.forEach((release) => release());
  });

  it('fails over to the same model on another machine, and finds a stronger one when stuck', async () => {
    const one = new FakeServer('one', [{ id: 'qwen3-14b' }]);
    const two = new FakeServer('two', [{ id: 'qwen3-14b' }]);
    const big = new FakeServer('big', [{ id: 'qwen3-27b' }]);
    const mesh = meshOf([one, two, big]);
    await mesh.probe();
    expect(mesh.failover({ providerId: 'one', model: 'qwen3-14b' }, 1000)?.model.spec).toBe('two/qwen3-14b');
    expect(mesh.stronger({ providerId: 'one', model: 'qwen3-14b' }, 1000)?.model.spec).toBe('big/qwen3-27b');
    expect(mesh.stronger({ providerId: 'big', model: 'qwen3-27b' }, 1000)).toBeUndefined();
    two.down = true;
    await mesh.probe();
    expect(mesh.nodes().find((n) => n.name === 'two')).toMatchObject({ up: false, error: 'fetch failed' });
    expect(mesh.failover({ providerId: 'one', model: 'qwen3-14b' }, 1000)?.model.spec).toBe('big/qwen3-27b');
    expect(formatNodes(mesh.nodes())).toMatch(/○ two {2}down \(fetch failed\)/);
  });

  it('uses the tier you set over the size-based guess', async () => {
    const mesh = meshOf([new FakeServer('m', [{ id: 'coder-7b' }])], { tiers: { 'm/coder-7b': 'strong' } });
    await mesh.probe();
    expect(mesh.models()[0]!.tier).toBe('strong');
  });
});

describe('parallel tasks', () => {
  /** A runner whose helper agents are real agents on the fake servers. */
  function runnerOf(mesh: Mesh, servers: FakeServer[]) {
    const byName = new Map(servers.map((s) => [s.name, s]));
    return new TaskRunner({
      mesh,
      maxTasks: 4,
      resolve: async (spec) => {
        const [p, ...rest] = spec.split('/');
        return resolvedOn(byName.get(p!)!, rest.join('/'));
      },
      makeAgent: (id, model) =>
        new Agent({
          id,
          cwd: ws.dir,
          config: testConfig(),
          model,
          tools: standardTools(),
          policy: new PolicyEngine({ mode: 'auto', rules: [] }),
          sandbox: new GuardSandbox({ cwd: ws.dir }),
          session: Session.create(ws.dir),
          approver: async () => ({ allow: true }),
          system: () => 'helper',
          retryDelaysMs: [0, 0],
        }),
    });
  }
  const ctx = () => ({ signal: new AbortController().signal, progress: (_: string) => {} });
  const slow =
    (text: string, log: string[], name: string): Turn =>
    async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, 50));
      log.push(`${name} end`);
      return say(text);
    };

  it('runs tasks at the same time on different machines and returns their reports', async () => {
    const log: string[] = [];
    const a = new FakeServer('a', [{ id: 'qwen3-4b' }], { slotsTotal: 1 }, [
      slow('Found 3 TODOs in src/app.ts.', log, 'a'),
    ]);
    const b = new FakeServer('b', [{ id: 'qwen3-4b' }], { slotsTotal: 1 }, [
      slow('Tests: 41 passed, 2 failed.', log, 'b'),
    ]);
    const mesh = meshOf([a, b]);
    await mesh.probe();
    const runner = runnerOf(mesh, [a, b]);
    const [r1, r2] = await Promise.all([
      runner.run({ description: 'TODOs', prompt: 'Find every TODO in src/' }, ctx()),
      runner.run({ description: 'tests', prompt: 'Run the tests and summarise them' }, ctx()),
    ]);
    // Both started before either finished: they really ran side by side, one per machine.
    expect(log.slice(0, 2).sort()).toEqual(['a start', 'b start']);
    expect([r1.content, r2.content].map((c) => /ran on (\w+)/.exec(c)![1]).sort()).toEqual(['a', 'b']);
    expect([r1.content, r2.content].join('\n')).toContain('Found 3 TODOs in src/app.ts.');
    expect([r1.content, r2.content].join('\n')).toContain('Tests: 41 passed, 2 failed.');
    expect(r1.content).toMatch(/\[task "TODOs" ran on (a|b) · (a|b)\/qwen3-4b · \d+s\]/);
  });

  it('moves a stuck task up to a stronger model, telling it what the smaller one tried', async () => {
    const small = new FakeServer(
      'small',
      [{ id: 'qwen3-4b' }],
      {},
      Array.from({ length: 6 }, (_, i) => callTool(`l${i}`, 'ls', {})),
    );
    let brief = '';
    const big = new FakeServer('big', [{ id: 'qwen3-27b' }], {}, [
      (req: StreamRequest) => {
        brief = JSON.stringify(req.messages[0]);
        return say('The config loader reads the wrong env var; fixed in src/config.ts.');
      },
    ]);
    const mesh = meshOf([small, big]);
    await mesh.probe();
    const steps: string[] = [];
    const r = await runnerOf(mesh, [small, big]).run(
      { description: 'config', prompt: 'Find where the config is loaded', tier: 'fast' },
      { signal: new AbortController().signal, progress: (t) => steps.push(t) },
    );
    expect(brief).toContain('[Earlier attempt]');
    expect(brief).toContain('small/qwen3-4b');
    expect(r.content).toContain('fixed in src/config.ts');
    expect(r.content).toMatch(/ran on big · big\/qwen3-27b .* after: small\/qwen3-4b/);
    expect(steps.join('\n')).toMatch(/stuck on small\/qwen3-4b; moving up to a stronger model/);
  });

  it('moves a task to another machine when its server goes down', async () => {
    const a = new FakeServer('a', [{ id: 'qwen3-4b' }], { slotsTotal: 2 }, [
      () => {
        throw new ProviderError('Network error: fetch failed', undefined, true);
      },
    ]);
    const b = new FakeServer('b', [{ id: 'qwen3-4b' }], { slotsTotal: 1 }, [say('Done on b.')]);
    const mesh = meshOf([a, b]);
    await mesh.probe();
    const r = await runnerOf(mesh, [a, b]).run({ description: 'x', prompt: 'list the files' }, ctx());
    expect(r.content).toContain('Done on b.');
    expect(r.content).toContain('after: a/qwen3-4b on a');
  });

  it('says so plainly when no machine can take it', async () => {
    const mesh = meshOf([new FakeServer('n', [{ id: 'qwen3-4b' }])], {
      nodes: { n: { providers: ['n'], sensitive: false } },
    });
    await mesh.probe();
    const r = await runnerOf(mesh, []).run({ description: 'x', prompt: 'read the secrets file' }, ctx());
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/No node can run this task right now/);
  });
});

describe('the main agent on the mesh', () => {
  function service(over: Partial<MeshService>): MeshService & { switches: string[] } {
    const switches: string[] = [];
    return {
      runTask: async () => ({ content: '' }),
      failover: async () => undefined,
      stronger: async () => undefined,
      isUp: () => true,
      switched: (_id, m) => switches.push(`${m.providerId}/${m.model}`),
      switches,
      ...over,
    };
  }

  it('carries on with another machine when its model server goes away', async () => {
    const dead = new AutoProvider([
      () => {
        throw new ProviderError('Network error: fetch failed', undefined, true);
      },
    ]);
    const spare = new FakeServer('spare', [{ id: 'qwen3-27b' }], {}, [say('Picked up where it left off.')]);
    const svc = service({
      failover: async () => ({ model: resolvedOn(spare, 'qwen3-27b'), why: 'spare · strong' }),
    });
    const { agent, events, session } = makeAgent(ws.dir, dead);
    agent.setServices({ mesh: svc });
    await agent.run('keep going');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(svc.switches).toEqual(['spare/qwen3-27b']);
    expect(JSON.stringify(events)).toMatch(/stopped answering; carrying on with spare\/qwen3-27b/);
    expect(session.messages().at(-1)!.content[0]).toMatchObject({ text: 'Picked up where it left off.' });
    expect(unreachable(new ProviderError('HTTP 400: bad request', 400))).toBe(false);
  });

  it('hands over to a stronger model when stuck, and goes back once the work is moving', async () => {
    // Six different calls on the strong model: the work is moving, so it goes back.
    const strong = new FakeServer(
      'strong',
      [{ id: 'qwen3-27b' }],
      {},
      Array.from({ length: 6 }, (_, i) => callTool(`g${i}`, 'glob', { pattern: `step-${i}-*` })),
    );
    // The same call five times: reminded at the third, fourth and fifth; the third reminder brings help.
    const small = new AutoProvider([
      ...Array.from({ length: 5 }, (_, i) => callTool(`s${i}`, 'ls', {})),
      say('Fixed, back on the small model.'),
    ]);
    const svc = service({
      stronger: async () => ({ model: resolvedOn(strong, 'qwen3-27b'), why: 'strong · ready' }),
    });
    const { agent, events, session } = makeAgent(ws.dir, small);
    agent.setServices({ mesh: svc });
    await agent.run('fix it');
    const text = JSON.stringify(events);
    expect(text).toMatch(/so qwen3-27b \(strong · ready\) is taking over/);
    expect(text).toMatch(/The work is moving again; back to test-model/);
    expect(svc.switches).toEqual(['strong/qwen3-27b', 'scripted/test-model']);
    expect(strong.requests).toHaveLength(6);
    expect(session.messages().at(-1)!.content[0]).toMatchObject({ text: 'Fixed, back on the small model.' });
  });
});

describe('the mesh in the harness', () => {
  /** Two llama.cpp-like servers answering the probes: models with their sizes, slots and props. */
  const servers = (seen: string[]) =>
    (async (u: string) => {
      const url = new URL(u);
      seen.push(`${url.host}${url.pathname}`);
      const id = url.host === 'big.lan' ? 'qwen3.8-27b' : 'qwen3-4b';
      if (url.pathname === '/v1/models')
        return Response.json({ data: [{ id, owned_by: 'llamacpp', meta: { n_ctx: 65536 } }] });
      if (url.pathname === '/slots') return Response.json([{ is_processing: false }]);
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

  const boot = async (mesh: Record<string, unknown> | undefined, seen: string[]) => {
    const { Runtime } = await import('../src/runtime.js');
    return Runtime.create({
      cwd: ws.dir,
      ephemeral: true,
      env: { ...process.env, NEXUS_HOME: `${ws.dir}/home` },
      fetchImpl: servers(seen),
      overrides: {
        model: 'big/qwen3.8-27b',
        providers: {
          big: { type: 'openai', baseUrl: 'http://big.lan/v1' },
          mini: { type: 'openai', baseUrl: 'http://mini.lan/v1' },
        },
        ...(mesh ? { mesh } : {}),
      },
    });
  };

  it('costs nothing when it is off: no task tool, no checks of other machines, the same system prompt', async () => {
    const seen: string[] = [];
    const rt = await boot(undefined, seen);
    expect(rt.mesh).toBeUndefined();
    expect(rt.tools.get('task')).toBeUndefined();
    expect(rt.systemPrompt('main')).not.toContain('Parallel tasks on the mesh');
    expect(seen.some((s) => s.startsWith('mini.lan'))).toBe(false);
    await rt.dispose();
  });

  it('when on, checks every machine, offers the task tool and explains it to the model', async () => {
    const seen: string[] = [];
    const rt = await boot({ enabled: true }, seen);
    await rt.mesh!.probe();
    expect(rt.tools.get('task')).toBeDefined();
    expect(rt.systemPrompt('main')).toContain('Parallel tasks on the mesh');
    expect(
      rt
        .mesh!.models()
        .map((m) => `${m.spec} ${m.tier}`)
        .sort(),
    ).toEqual(['big/qwen3.8-27b strong', 'mini/qwen3-4b fast']);
    expect(seen).toContain('mini.lan/slots');
    // The prompt does not change as machines come and go, so servers keep it cached.
    const before = rt.systemPrompt('main');
    await rt.mesh!.probe();
    expect(rt.systemPrompt('main')).toBe(before);
    await rt.dispose();
  });
});
