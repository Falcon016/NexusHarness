import { z } from 'zod';
import type { Agent, AgentEvent } from '../agent/agent.js';
import type { MeshTier } from '../config/schema.js';
import type { ResolvedModel } from '../llm/registry.js';
import { defineTool, type ToolResult } from '../tools/types.js';
import type { Mesh, MeshModel, Placement } from './mesh.js';
import { classifyTask, nextTier, tierRank } from './tiers.js';

/**
 * Parallel tasks across the mesh. The main agent hands off a self-contained piece of work with a brief; it runs
 * as a short-lived agent with a fresh, small context on the node and size of model that suits it, and only its
 * report comes back. Several run at once on different machines. A task that gets stuck moves up to a stronger
 * model with a summary of what was tried; one whose node goes down moves to another node.
 */

export interface TaskInput {
  description: string;
  prompt: string;
  tier?: MeshTier | 'auto' | undefined;
  sensitive?: boolean | undefined;
}

/** What agents get from the mesh. */
export interface MeshService {
  runTask(
    input: TaskInput,
    ctx: { signal: AbortSignal; progress: (text: string) => void },
  ): Promise<ToolResult>;
  /** Another node for a conversation whose model server stopped answering. */
  failover(
    current: ResolvedModel,
    minContext: number,
  ): Promise<{ model: ResolvedModel; why: string } | undefined>;
  /** A stronger model for work that has got stuck. */
  stronger(
    current: ResolvedModel,
    minContext: number,
  ): Promise<{ model: ResolvedModel; why: string } | undefined>;
  /** Whether a model is still up, to go back to it. */
  isUp(m: ResolvedModel): boolean;
  /** An agent's model changed (the UI shows the model in use). */
  switched?(agentId: string, m: ResolvedModel): void;
}

export const TASK_RULES =
  'You are a helper agent doing one task for the main agent, which planned the work and will carry on with ' +
  'your result. Work only on this task, and finish it. Your final reply is all the main agent sees, so make it ' +
  'a short, factual report: what you found or did, with file paths, names, numbers and results. Do not ask ' +
  'questions: decide sensibly and say what you assumed.';

const describeTier = (t: TaskInput) => (t.tier && t.tier !== 'auto' ? t.tier : classifyTask(t.prompt));

export const taskTool = defineTool({
  name: 'task',
  description:
    'Hand a self-contained piece of work to a helper agent on the mesh of machines serving models. It starts ' +
    'with a fresh context, so `prompt` must say everything it needs (goal, files, what to report). Several ' +
    'task calls in one reply run at the same time on different machines: use this for independent pieces, ' +
    'like exploring different parts of a codebase, running and summarising tests, or researching while you ' +
    'work. Only its final report comes back, which also keeps your own context small. `tier` picks the size ' +
    'of model: "fast" for reading, searching, listing and summarising; "standard" for ordinary changes; ' +
    '"strong" for debugging, design and hard reasoning; "auto" (default) guesses from the prompt. A task that ' +
    'gets stuck moves up to a stronger model by itself. Tasks run tools on this machine, with the same ' +
    'approvals and sandbox as you; give tasks that edit files different files. Set `sensitive: false` only ' +
    'for work that involves nothing private, so it may also run on machines not trusted with your code.',
  risk: 'read',
  parallel: true,
  schema: z.object({
    description: z.string().describe('A few words for the screen: "Map the auth module"'),
    prompt: z.string().describe('The full brief: goal, where to look, what to report back'),
    tier: z.enum(['auto', 'fast', 'standard', 'strong']).optional(),
    sensitive: z.boolean().optional().describe('Default true: only machines trusted with your code'),
  }),
  describe: (i) => `${i.description} (${describeTier(i)})`,
  async execute(input, ctx) {
    if (!ctx.mesh)
      return { content: 'The mesh is not enabled, so there is nowhere to run a task.', isError: true };
    return ctx.mesh.runTask(input, { signal: ctx.signal, progress: ctx.progress });
  },
});

export interface TaskRunnerDeps {
  mesh: Mesh;
  /** A model by spec, with its real context window (cached by the caller). */
  resolve: (spec: string) => Promise<ResolvedModel>;
  /** A fresh helper agent on a model, with its own throwaway session. */
  makeAgent: (id: string, model: ResolvedModel) => Agent;
  /** Models of the conversations still going (the main agent, swarm members), whose caches tasks should leave alone. */
  protect?: () => string[];
  maxTasks: number;
  now?: () => number;
}

/** Room a task needs at least: its brief, a few files, and a reply. */
const TASK_MIN_CONTEXT = 8192;
/** Loop reminders after which a task moves up to a stronger model (when there is one). */
const STUCK_AFTER = 3;
/** Failed attempts (a node down, a server error) before a task gives up. */
const MAX_FAILURES = 3;

export class TaskRunner {
  private running = 0;
  private waiting: (() => void)[] = [];
  private seq = 0;

  constructor(private d: TaskRunnerDeps) {}

  private async slot(signal: AbortSignal): Promise<() => void> {
    while (this.running >= this.d.maxTasks) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (signal.aborted) throw new Error('aborted');
    }
    this.running++;
    return () => {
      this.running--;
      this.waiting.shift()?.();
    };
  }

  async run(
    input: TaskInput,
    ctx: { signal: AbortSignal; progress: (text: string) => void },
  ): Promise<ToolResult> {
    const now = this.d.now ?? Date.now;
    const started = now();
    let tier: MeshTier = input.tier && input.tier !== 'auto' ? input.tier : classifyTask(input.prompt);
    const avoid: string[] = [];
    const history: string[] = [];
    let failures = 0;
    let brief = input.prompt;
    let release: (() => void) | undefined;
    try {
      if (this.running >= this.d.maxTasks) ctx.progress('waiting for a free task slot');
      release = await this.slot(ctx.signal);
      for (;;) {
        if (ctx.signal.aborted) return { content: 'Task cancelled.', isError: true };
        const place: Placement | undefined = this.d.mesh.pick({
          tier,
          minContext: TASK_MIN_CONTEXT,
          protect: this.d.protect?.() ?? [],
          ...(input.sensitive === false ? { sensitive: false } : {}),
          avoidNodes: avoid,
        });
        if (!place)
          return {
            content:
              `No node can run this task right now${avoid.length ? ` (${avoid.join(', ')} failed)` : ''}. ` +
              'Do it yourself instead.' +
              (history.length ? `\nEarlier attempts:\n${history.join('\n')}` : ''),
            isError: true,
          };
        // Claimed the moment it is placed, so a task placed a moment later sees this machine as taken.
        const unclaim = this.d.mesh.claim(place.node);
        const attempt = await this.attempt(place, brief, input, ctx).finally(unclaim);
        if (attempt.kind === 'done') {
          const footer =
            `[task "${input.description}" ran on ${place.node} · ${place.model.spec} · ` +
            `${Math.round((now() - started) / 1000)}s` +
            (history.length ? ` · after: ${history.map((h) => h.split(':')[0]).join('; ')}` : '') +
            ']';
          return { content: `${attempt.report}\n\n${footer}` };
        }
        if (attempt.kind === 'cancelled') return { content: 'Task cancelled.', isError: true };
        if (attempt.kind === 'failed') {
          failures++;
          avoid.push(place.node);
          history.push(`${place.model.spec} on ${place.node}: failed (${attempt.reason})`);
          ctx.progress(`${place.node} failed (${attempt.reason}); trying another node`);
          if (failures >= MAX_FAILURES)
            return {
              content: `The task failed ${failures} times:\n${history.join('\n')}\nDo it yourself instead.`,
              isError: true,
            };
          continue;
        }
        // Stuck: one size up, told what the smaller model tried.
        const up = nextTier(place.model.tier);
        history.push(`${place.model.spec}: got stuck`);
        tier = up ?? tier;
        ctx.progress(`stuck on ${place.model.spec}; moving up to a stronger model`);
        brief =
          `${input.prompt}\n\n[Earlier attempt] A smaller model (${place.model.spec}) worked on this first and ` +
          `got stuck going round in a loop. Do not repeat what did not work. What it did:\n${attempt.summary}`;
      }
    } catch (e) {
      if (ctx.signal.aborted) return { content: 'Task cancelled.', isError: true };
      throw e;
    } finally {
      release?.();
    }
  }

  private async attempt(
    place: Placement,
    brief: string,
    input: TaskInput,
    ctx: { signal: AbortSignal; progress: (text: string) => void },
  ): Promise<
    | { kind: 'done'; report: string }
    | { kind: 'failed'; reason: string }
    | { kind: 'stuck'; summary: string }
    | { kind: 'cancelled' }
  > {
    const model = await this.d.resolve(place.model.spec);
    const id = `task-${++this.seq}`;
    const agent = this.d.makeAgent(id, model);
    const canGoUp = this.hasStronger(place.model);
    let loops = 0;
    let stuck = false;
    let error: string | undefined;
    const steps: string[] = [];
    ctx.progress(`${input.description}: ${place.model.spec} (${place.why})`);
    const off = agent.events.on('event', (e: AgentEvent) => {
      if (e.type === 'tool_start') {
        steps.push(e.description);
        ctx.progress(`  ${e.name} ${e.description}`);
      } else if (e.type === 'usage' && e.tokensPerSecond)
        this.d.mesh.record(place.model.spec, e.tokensPerSecond);
      else if (e.type === 'status' && e.text.startsWith('Loop')) {
        loops++;
        // At the top size there is nowhere to go: the loop reminders keep it moving instead.
        if (loops >= STUCK_AFTER && canGoUp && !stuck) {
          stuck = true;
          agent.abort();
        }
      } else if (e.type === 'error') error = e.message;
    });
    const onAbort = () => agent.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await agent.run(brief);
    } finally {
      off();
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (ctx.signal.aborted) return { kind: 'cancelled' };
    if (stuck) {
      const said = lastText(agent);
      return {
        kind: 'stuck',
        summary:
          steps
            .slice(-15)
            .map((s) => `- ${s}`)
            .join('\n') + (said ? `\nIts last notes: ${said.slice(0, 1500)}` : ''),
      };
    }
    if (error) return { kind: 'failed', reason: error.split('\n')[0]!.slice(0, 200) };
    const report = lastText(agent);
    if (!report) return { kind: 'failed', reason: 'no report' };
    return { kind: 'done', report };
  }

  private hasStronger(m: MeshModel): boolean {
    return this.d.mesh.models().some((x) => tierRank(x.tier) > tierRank(m.tier));
  }
}

function lastText(agent: Agent): string {
  const msg = agent.session
    .messages()
    .filter((m) => m.role === 'assistant')
    .at(-1);
  return (msg?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}
