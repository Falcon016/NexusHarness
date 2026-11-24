import { z } from 'zod';

export const approvalModeSchema = z.enum(['ask', 'edits', 'auto', 'plan']);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const sandboxModeSchema = z.enum(['off', 'guard', 'container']);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export const providerSchema = z.object({
  type: z.enum(['anthropic', 'openai']),
  baseUrl: z.string().url().optional(),
  /** Name of the environment variable holding the key. The key itself never lives in config. */
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Optional context window hint for models served by this provider. */
  contextWindow: z.number().int().positive().optional(),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

export const ruleSchema = z.object({
  /** Tool name glob, e.g. `bash`, `browser_*`, `mcp__github__*`. */
  tool: z.string(),
  /** Optional glob against the tool's primary argument (command, path or URL). */
  match: z.string().optional(),
  action: z.enum(['allow', 'ask', 'deny']),
});
export type Rule = z.infer<typeof ruleSchema>;

export const mcpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const swarmAgentSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/),
  role: z.string(),
  model: z.string().optional(),
  /** Restrict this agent to a subset of tool names/globs. */
  tools: z.array(z.string()).optional(),
  color: z.string().optional(),
});
export type SwarmAgentConfig = z.infer<typeof swarmAgentSchema>;

export const meshTierSchema = z.enum(['fast', 'standard', 'strong']);
export type MeshTier = z.infer<typeof meshTierSchema>;

export const meshNodeSchema = z.object({
  /** Providers (model servers) running on this machine. */
  providers: z.array(z.string()).default([]),
  /** Its `nexus node` service, for VRAM, RAM and CPU load: `http://host:7878`. The key is kept with your keys. */
  agent: z.string().url().optional(),
  /**
   * Whether this machine may be sent your conversation and code. False keeps it to tasks the main agent marks
   * as not sensitive. Tools always run on your own machine; only model requests go to a node.
   */
  sensitive: z.boolean().default(true),
});
export type MeshNodeConfig = z.infer<typeof meshNodeSchema>;

export const configSchema = z.object({
  /** `<provider>/<model>`. Deliberately has no default: you pick one with `--model` or `/model`. */
  model: z.string().optional(),
  /** Model used for compaction summaries. Defaults to `model` (avoids swapping models on single-GPU servers). */
  smallModel: z.string().optional(),
  /** Override the detected context window (tokens) per `<provider>/<model>`. */
  contextWindows: z.record(z.string(), z.number().int().min(1024)).default({}),
  /** Output tokens per model call. 0 (the default) = all the room left in the context window after the prompt. */
  maxTokens: z.number().int().min(0).default(0),
  thinkingBudget: z.number().int().min(0).default(0),
  /**
   * How much reasoning models think, step by step (docs/reasoning.md). "always": every step, as the model likes
   * (a budget applies only when /effort is set); "adaptive": the steps that need it (planning, after an error,
   * when stuck) get a large budget, routine steps a small one; "never": no reasoning. A step that runs past its
   * budget is wrapped up: the model is given where its reasoning got to and asked to act on it.
   */
  reasoning: z
    .object({
      mode: z.enum(['always', 'adaptive', 'never']).default('always'),
      /** Reasoning tokens for a routine step (after successful tool calls). 0: none; -1: no limit. */
      routineBudget: z.number().int().min(-1).default(1024),
      /** Reasoning tokens for a step that needs thought (planning, after an error, when stuck). -1: no limit. */
      keyBudget: z.number().int().min(-1).default(8192),
    })
    .default({ mode: 'always', routineBudget: 1024, keyBudget: 8192 }),
  /**
   * Sampling per model, by `<provider>/<model>` pattern (`*` matches anything), as the model card recommends.
   * Sent with every request; top_k, min_p and repeat_penalty only to local servers.
   */
  sampling: z
    .record(
      z.string(),
      z.object({
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        top_k: z.number().int().min(0).optional(),
        min_p: z.number().min(0).max(1).optional(),
        presence_penalty: z.number().min(-2).max(2).optional(),
        repeat_penalty: z.number().min(0).max(2).optional(),
      }),
    )
    .default({}),
  /** How hard reasoning models think: `/effort`. Unset = the model's own default (nothing is sent). */
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  providers: z.record(z.string(), providerSchema).default({}),

  approval: z
    .object({
      mode: approvalModeSchema.default('ask'),
      rules: z.array(ruleSchema).default([]),
    })
    .default({ mode: 'ask', rules: [] }),

  sandbox: z
    .object({
      mode: sandboxModeSchema.default('guard'),
      /** Extra directories the agent may read/write besides the workspace. */
      allowPaths: z.array(z.string()).default([]),
      /** Paths never readable or writable, even inside the workspace. */
      denyPaths: z.array(z.string()).default(['.env', '.env.*', '**/.ssh/**', '**/*.pem', '**/id_rsa*']),
      container: z
        .object({
          runtime: z.enum(['docker', 'podman']).default('docker'),
          image: z.string().default('node:22-bookworm-slim'),
          network: z.boolean().default(false),
          memory: z.string().default('2g'),
          cpus: z.string().default('2'),
        })
        .default({
          runtime: 'docker',
          image: 'node:22-bookworm-slim',
          network: false,
          memory: '2g',
          cpus: '2',
        }),
    })
    .default({
      mode: 'guard',
      allowPaths: [],
      denyPaths: ['.env', '.env.*', '**/.ssh/**', '**/*.pem', '**/id_rsa*'],
      container: {
        runtime: 'docker',
        image: 'node:22-bookworm-slim',
        network: false,
        memory: '2g',
        cpus: '2',
      },
    }),

  /**
   * `nexus telegram`: talk to the agent from Telegram. Only read from the user config, never from a project's.
   * The bot token is a secret: it lives in auth.json (`nexus setup`) or $NEXUS_TELEGRAM_TOKEN.
   */
  telegram: z
    .object({
      /** Telegram user ids allowed to use the bot. Nobody else gets an answer. */
      allowedUsers: z.array(z.number().int().positive()).default([]),
      /** The folder the bot's agent works in (default: the folder `nexus telegram` is started from). */
      cwd: z.string().optional(),
    })
    .default({ allowedUsers: [] }),

  browser: z
    .object({
      enabled: z.boolean().default(true),
      /** `chrome`, `msedge` or `chromium`. Chrome/Edge use the browser already installed on the machine. */
      channel: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),
      headless: z.boolean().default(false),
      /** Navigation allow-list (host globs). Empty means any host, subject to approval rules. */
      allowedHosts: z.array(z.string()).default([]),
      blockedHosts: z.array(z.string()).default([]),
    })
    .default({ enabled: true, channel: 'chrome', headless: false, allowedHosts: [], blockedHosts: [] }),

  /**
   * Several machines serving models, used as one: parallel tasks placed on the best free node, small fast models
   * for easy work and strong ones for hard work, a stronger model when one gets stuck, and another node when
   * one goes down. See docs/mesh.md.
   */
  mesh: z
    .object({
      enabled: z.boolean().default(false),
      /** Machines by name. Empty: every configured provider counts as its own node. */
      nodes: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/), meshNodeSchema).default({}),
      /** How often to check the nodes, in seconds. */
      probeSeconds: z.number().int().min(5).max(600).default(15),
      /** Tier per `<provider>/<model>`, where the size-based guess is wrong. */
      tiers: z.record(z.string(), meshTierSchema).default({}),
      /** Tasks running at once across the mesh. */
      maxTasks: z.number().int().min(1).max(16).default(4),
    })
    .default({ enabled: false, nodes: {}, probeSeconds: 15, tiers: {}, maxTasks: 4 }),

  swarm: z
    .object({
      agents: z.array(swarmAgentSchema).default([]),
      maxAgents: z.number().int().min(1).max(12).default(6),
      /**
       * Messages agents may send each other between two of yours, a backstop against runaway chatter.
       * Anything you type resets it. 0 means no limit.
       */
      maxMessages: z.number().int().min(0).default(60),
      /** Let agents add teammates mid-run. Off by default: the team you start is the team you get. */
      allowSpawn: z.boolean().default(false),
    })
    .default({ agents: [], maxAgents: 6, maxMessages: 60, allowSpawn: false }),

  /**
   * Compaction is always on and cannot be disabled. The trigger can be lowered but never raised above
   * 80% of the context window, and the chat is held (nothing is sent) until compaction completes.
   */
  compaction: z
    .object({
      threshold: z.number().min(0.3).max(0.8).default(0.8),
      /** Newest messages kept verbatim; shrinks automatically when the context is still too large. */
      keepRecent: z.number().int().min(1).default(6),
    })
    .default({ threshold: 0.8, keepRecent: 6 }),

  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  /**
   * Tool calls an agent may make in one turn before it stops and waits for you. 0 (the default) means no limit:
   * long tasks run until they are done, with compaction keeping the context in bounds and loop detection keeping
   * the model moving.
   */
  maxToolIterations: z.number().int().min(0).default(0),
  /**
   * Notice the model going round in a loop and get it moving again without stopping the work: a reply that
   * starts repeating itself is cut off and resumed, and repeating the same calls gets a reminder each time.
   */
  loopDetection: z.boolean().default(true),
  // `nacre` is the theme's name from before the rename.
  theme: z.preprocess((v) => (v === 'nacre' ? 'nexus' : v), z.enum(['nexus', 'mono'])).default('nexus'),
  /** Show agents' reasoning in full in the terminal UI (toggle with ctrl+t or /thinking). */
  showThinking: z.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;
export type PartialConfig = Record<string, unknown>;
