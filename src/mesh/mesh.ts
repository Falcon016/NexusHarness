import type { Config, MeshTier } from '../config/schema.js';
import type { ModelInfo, Provider, ServerStatus } from '../llm/types.js';
import { fetchTelemetry, type Telemetry } from './telemetry.js';
import { tierOf, tierRank } from './tiers.js';

/**
 * The mesh: every machine serving models, seen as one pool. It checks each node in the background (never on
 * the way to a request), keeps a list of which models run where, how busy and how fast they are, and picks
 * where a piece of work should run. Tools always run on this machine; only model requests go to a node.
 */

export interface MeshModel {
  /** `<provider>/<model>`. */
  spec: string;
  providerId: string;
  id: string;
  node: string;
  tier: MeshTier;
  contextWindow?: number;
  loaded?: boolean;
}

export interface NodeState {
  name: string;
  providers: string[];
  /** May be sent your conversation and code. */
  sensitive: boolean;
  agent?: string;
  up: boolean;
  checkedAt?: number;
  /** Round trip of the last check, ms. */
  latencyMs?: number;
  error?: string;
  models: MeshModel[];
  status: Record<string, ServerStatus>;
  telemetry?: Telemetry;
  /** Why there is no telemetry, when a service is configured. */
  telemetryNote?: string;
  /** Tasks this harness has running there now. */
  running: number;
}

export interface Placement {
  node: string;
  model: MeshModel;
  /** Why here, in a few words, for the task's report. */
  why: string;
}

export interface Want {
  tier: MeshTier;
  /** Tokens the work needs room for. */
  minContext?: number;
  /** Default true: only nodes allowed your conversation and code. */
  sensitive?: boolean;
  /** Nodes not to use (one that just failed). */
  avoidNodes?: string[];
  /** A model to keep using when it is a good fit: its server has the conversation cached. */
  prefer?: string;
  /** Only this model id (failover to the same model elsewhere). */
  sameModelAs?: string;
  /**
   * Models holding a conversation that is still going (the main agent's). A task on a one-slot server would push
   * that conversation out of its cache and make the agent read it all again, so those count as busy.
   */
  protect?: string[];
}

export interface MeshDeps {
  config: Config;
  provider: (id: string) => Provider;
  /** Stored keys: a node's pairing key is under `node:<name>`. */
  key: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const PROBE_TIMEOUT_MS = 2500;

/** A server on this machine or the local network (private addresses, Tailscale, `.local`/`.lan` names). */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || !host.includes('.')) return true;
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(host)) return true;
  const ip = host.split('.').map(Number);
  if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = ip as [number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 100 && b >= 64 && b < 128)
  );
}

/** Built-in defaults nobody pointed anywhere (Ollama, LM Studio, llama.cpp on their usual local ports). */
const DEFAULTS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  llamacpp: 'http://127.0.0.1:8080/v1',
};

export class Mesh {
  private states = new Map<string, NodeState>();
  private speeds = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private probing: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  readonly warnings: string[] = [];

  constructor(private d: MeshDeps) {
    const m = d.config.mesh;
    const declared = Object.entries(m.nodes);
    // With no machines listed, every model server on this machine or the local network is one (never a cloud
    // API: the mesh is local only unless you list a node yourself). Untouched built-in defaults count only when
    // they are the model in use.
    const inUse = d.config.model?.split('/')[0];
    const nodes = declared.length
      ? declared
      : Object.entries(d.config.providers)
          .filter(([, p]) => p.type === 'openai' && isLocalUrl(p.baseUrl))
          .filter(([id, p]) => id === inUse || DEFAULTS[id] !== p.baseUrl)
          .map(([id]) => [id, { providers: [id], sensitive: true }] as const);
    for (const [name, n] of nodes) {
      const providers = n.providers.filter((p) => {
        if (d.config.providers[p]) return true;
        this.warnings.push(`Mesh node "${name}" lists provider "${p}", which is not configured.`);
        return false;
      });
      this.states.set(name, {
        name,
        providers,
        sensitive: n.sensitive,
        ...('agent' in n && n.agent ? { agent: n.agent } : {}),
        up: false,
        models: [],
        status: {},
        running: 0,
      });
    }
  }

  /** Check every node now, then every `probeSeconds` in the background. */
  start(): void {
    void this.probe();
    this.timer ??= setInterval(() => void this.probe(), this.d.config.mesh.probeSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  nodes(): NodeState[] {
    return [...this.states.values()].map((s) => ({ ...s, models: [...s.models] }));
  }

  /** The node a provider runs on. */
  nodeOf(providerId: string): string | undefined {
    for (const s of this.states.values()) if (s.providers.includes(providerId)) return s.name;
    return undefined;
  }

  /** Every model the mesh can use right now. */
  models(): MeshModel[] {
    return [...this.states.values()].filter((s) => s.up).flatMap((s) => s.models);
  }

  /** Check all nodes at once; a check already running is shared rather than doubled. */
  probe(): Promise<void> {
    this.probing ??= (async () => {
      try {
        await Promise.all([...this.states.values()].map((s) => this.probeNode(s)));
      } finally {
        this.probing = undefined;
        for (const fn of this.listeners) fn();
      }
    })();
    return this.probing;
  }

  private async probeNode(s: NodeState): Promise<void> {
    const now = this.d.now ?? Date.now;
    const started = now();
    const models: MeshModel[] = [];
    const status: Record<string, ServerStatus> = {};
    let reached = false;
    let error: string | undefined;
    await Promise.all(
      s.providers.map(async (pid) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        try {
          const p = this.d.provider(pid);
          const [list, st] = await Promise.all([
            p.listModels ? p.listModels(ctrl.signal) : Promise.resolve([] as ModelInfo[]),
            p.status ? p.status(ctrl.signal).catch(() => ({})) : Promise.resolve({}),
          ]);
          reached = true;
          status[pid] = st;
          for (const m of list) {
            const spec = `${pid}/${m.id}`;
            models.push({
              spec,
              providerId: pid,
              id: m.id,
              node: s.name,
              tier: this.d.config.mesh.tiers[spec] ?? tierOf(m.id, m.params),
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
              ...(m.loaded !== undefined ? { loaded: m.loaded } : {}),
            });
          }
        } catch (e) {
          error = ctrl.signal.aborted ? 'no answer' : (e as Error).message;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    s.checkedAt = now();
    s.latencyMs = s.checkedAt - started;
    s.up = reached;
    s.models = models;
    s.status = status;
    if (reached) delete s.error;
    else s.error = error ?? 'no model servers';

    if (s.agent) {
      const key = this.d.key(`node:${s.name}`);
      if (!key) s.telemetryNote = 'not paired';
      else {
        const t = await fetchTelemetry(s.agent, key, {
          timeoutMs: PROBE_TIMEOUT_MS,
          ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}),
          ...(this.d.now ? { now: this.d.now } : {}),
        });
        if (t) {
          s.telemetry = t;
          delete s.telemetryNote;
        } else s.telemetryNote = 'no answer, or the key does not match';
      }
    }
  }

  /** Generation speed measured on a model, tokens per second (a running average). */
  record(spec: string, tokensPerSecond: number): void {
    if (!(tokensPerSecond > 0)) return;
    const old = this.speeds.get(spec);
    this.speeds.set(spec, old ? old * 0.7 + tokensPerSecond * 0.3 : tokensPerSecond);
  }

  speedOf(m: MeshModel): number | undefined {
    return this.speeds.get(m.spec) ?? this.states.get(m.node)?.status[m.providerId]?.tokensPerSecond;
  }

  /** Mark a task as running on a node until the returned function is called, so parallel tasks spread out. */
  claim(node: string): () => void {
    const s = this.states.get(node);
    if (s) s.running++;
    let done = false;
    return () => {
      if (done || !s) return;
      done = true;
      s.running = Math.max(0, s.running - 1);
    };
  }

  /**
   * Where work of a given tier should run: the right size of model first (or the nearest size up, then down),
   * then the node with a free slot, the fastest measured speed and the shortest round trip.
   */
  pick(want: Want): Placement | undefined {
    const pool = this.models().filter((m) => {
      const s = this.states.get(m.node)!;
      if (want.sensitive !== false && !s.sensitive) return false;
      if (want.avoidNodes?.includes(m.node)) return false;
      if (want.sameModelAs && m.id !== want.sameModelAs) return false;
      if (want.minContext && m.contextWindow && m.contextWindow < want.minContext) return false;
      return true;
    });
    if (!pool.length) return undefined;
    const r = tierRank(want.tier);
    const distance = (m: MeshModel) => {
      const d = tierRank(m.tier) - r;
      return d >= 0 ? d * 2 : -d * 2 + 1; // a size up before a size down
    };
    const best = Math.min(...pool.map(distance));
    const rank = (ms: MeshModel[]) =>
      ms
        .map((m) => ({ m, ...this.score(m, want) }))
        .sort((a, b) => b.score - a.score || a.m.spec.localeCompare(b.m.spec));
    let top = rank(pool.filter((m) => distance(m) === best))[0]!;
    // Every machine of the right size is busy: a bigger model on an idle machine beats waiting in line.
    if (this.busy(top.m, want)) {
      const idleBigger = rank(
        pool.filter(
          (m) => tierRank(m.tier) > tierRank(top.m.tier) && !this.busy(m, want) && m.loaded !== false,
        ),
      )[0];
      if (idleBigger) top = { ...idleBigger, why: `${idleBigger.why}, ${top.m.node} busy` };
    }
    return { node: top.m.node, model: top.m, why: top.why };
  }

  /** Free slots for one more request (when the server says), counting a slot holding a conversation as used. */
  private free(m: MeshModel, want: Want): number | undefined {
    const s = this.states.get(m.node)!;
    const st = s.status[m.providerId] ?? {};
    const held = want.protect?.includes(m.spec) ? 1 : 0;
    if (!st.slotsTotal) return held ? 0 : undefined;
    return st.slotsTotal - Math.max(st.slotsBusy ?? 0, s.running + held);
  }

  /** No room for one more request without waiting, or pushing a live conversation out of the cache. */
  private busy(m: MeshModel, want: Want): boolean {
    const f = this.free(m, want);
    return f === undefined ? this.states.get(m.node)!.running > 0 : f <= 0;
  }

  private score(m: MeshModel, want: Want): { score: number; why: string } {
    const s = this.states.get(m.node)!;
    const st = s.status[m.providerId] ?? {};
    const why: string[] = [];
    let score = 0;
    const free = this.free(m, want);
    if (free !== undefined) {
      score += free > 0 ? 10 * Math.min(free, 2) : -50;
      why.push(
        free > 0
          ? `${free} free slot${free === 1 ? '' : 's'}`
          : want.protect?.includes(m.spec) && !(st.slotsBusy ?? 0) && !s.running
            ? 'holding the main conversation'
            : 'busy',
      );
    } else if (s.running) {
      score -= 25 * s.running;
      why.push(`${s.running} task${s.running === 1 ? '' : 's'} running`);
    }
    const tps = this.speedOf(m);
    if (tps) {
      score += Math.min(tps, 120) / 2;
      why.push(`~${Math.round(tps)} tok/s`);
    }
    if (s.latencyMs !== undefined) score -= s.latencyMs / 20;
    if (m.loaded === false) {
      score -= 40;
      why.push('needs loading');
    }
    const gpuBusy = s.telemetry?.gpus.some((g) => (g.utilization ?? 0) > 90);
    if (gpuBusy) score -= 10;
    if ((s.telemetry?.cpuLoad ?? 0) > 0.9) score -= 5;
    if (want.prefer === m.spec) {
      score += 15;
      why.push('already has the conversation');
    }
    return { score, why: `${m.node} · ${m.tier} · ${why.join(', ') || 'ready'}` };
  }

  /**
   * Somewhere else to send a conversation whose model server stopped answering: the same model on another
   * node first, then the same size of model, then the nearest size, never a node that may not see your code.
   */
  failover(current: { providerId: string; model: string }, minContext: number): Placement | undefined {
    const here = this.nodeOf(current.providerId);
    const avoid = here ? [here] : [];
    const tier =
      this.models().find((m) => m.providerId === current.providerId && m.id === current.model)?.tier ??
      this.d.config.mesh.tiers[`${current.providerId}/${current.model}`] ??
      tierOf(current.model);
    return (
      this.pick({ tier, minContext, avoidNodes: avoid, sameModelAs: current.model }) ??
      this.pick({ tier, minContext, avoidNodes: avoid })
    );
  }

  /** A stronger model than this one, for work that has got stuck. Undefined when this is already the strongest. */
  stronger(current: { providerId: string; model: string }, minContext: number): Placement | undefined {
    const spec = `${current.providerId}/${current.model}`;
    const tier =
      this.models().find((m) => m.spec === spec)?.tier ??
      this.d.config.mesh.tiers[spec] ??
      tierOf(current.model);
    const up = this.models().filter((m) => tierRank(m.tier) > tierRank(tier));
    if (!up.length) return undefined;
    const target = up.reduce((a, b) => (tierRank(b.tier) < tierRank(a.tier) ? b : a)).tier;
    return this.pick({ tier: target, minContext });
  }
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mib = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

/** The mesh as a few lines per node, for `/nodes` and `nexus mesh list`. */
export function formatNodes(nodes: NodeState[], speedOf?: (m: MeshModel) => number | undefined): string {
  if (!nodes.length) return 'No nodes. Add machines under "mesh.nodes" in your config (see docs/mesh.md).';
  const out: string[] = [];
  for (const n of nodes) {
    const head =
      `${n.up ? '●' : '○'} ${n.name}` +
      (n.up ? `  ${n.latencyMs ?? '?'} ms` : `  down${n.error ? ` (${n.error})` : ''}`) +
      (n.sensitive ? '' : '  · not for sensitive work') +
      (n.running ? `  · ${n.running} task${n.running === 1 ? '' : 's'} running` : '');
    out.push(head);
    const t = n.telemetry;
    if (t) {
      const gpus = t.gpus.map(
        (g) =>
          `${g.name} ${mib(g.memoryUsed)}/${mib(g.memoryTotal)}` +
          (g.utilization !== undefined ? ` ${g.utilization}%` : '') +
          (g.temperature !== undefined ? ` ${g.temperature}°C` : ''),
      );
      out.push(
        `    ${gpus.length ? `${gpus.join(', ')} · ` : ''}RAM ${gb(t.memoryTotal - t.memoryFree)}/${gb(t.memoryTotal)}` +
          ` · CPU ${Math.round(t.cpuLoad * 100)}% of ${t.cpuCount} cores`,
      );
    } else if (n.telemetryNote) out.push(`    hardware: ${n.telemetryNote}`);
    for (const m of n.models) {
      const st = n.status[m.providerId] ?? {};
      const tps = speedOf?.(m);
      out.push(
        `    ${m.spec}  ${m.tier}` +
          (m.contextWindow ? ` · ${Math.round(m.contextWindow / 1024)}k ctx` : '') +
          (st.slotsTotal ? ` · slots ${st.slotsBusy ?? 0}/${st.slotsTotal} busy` : '') +
          (tps ? ` · ${Math.round(tps)} tok/s` : '') +
          (m.loaded === false ? ' · not loaded' : ''),
      );
    }
  }
  return out.join('\n');
}
