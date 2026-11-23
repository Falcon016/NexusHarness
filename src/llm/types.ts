/** Provider-neutral conversation and streaming types. */

export interface ImageData {
  mediaType: string;
  /** base64 payload */
  data: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; images?: ImageData[] };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Levels for `/effort`, low to high. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface StreamRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Omitted = the server's own default (usually: until the context is full). */
  maxTokens?: number;
  temperature?: number;
  /** Extended-thinking token budget (Anthropic). 0 or undefined disables. */
  thinkingBudget?: number;
  /** Reasoning effort for models that take one. Undefined: the model's default. */
  reasoningEffort?: ReasoningEffort;
  /**
   * False: ask the model not to reason before answering (summaries), through the chat template's
   * `enable_thinking`, which Qwen-style templates read. Servers whose templates do not read it ignore it.
   */
  thinking?: false;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'signature'; signature: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; json: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'done'; stopReason: StopReason };

export interface ModelInfo {
  id: string;
  aliases?: string[];
  /** Context window in tokens, when the server reports it. */
  contextWindow?: number;
  /** llama.cpp router / LM Studio: whether the model is currently loaded in memory. */
  loaded?: boolean;
  /** False when the server says this model takes no images (llama.cpp started without a vision projector). */
  vision?: boolean;
}

export interface Provider {
  readonly id: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
}

/**
 * A server refusing a request because it holds an image the model cannot take: llama.cpp without `--mmproj`,
 * Ollama, LM Studio and vLLM text-only models, OpenAI-compatible APIs whose model has no vision.
 */
const NO_VISION =
  /image input is not supported|\bmmproj\b|(does not|doesn't|do not) support (images?|image input|vision|multimodal)|not a multimodal model|image_url is only supported|images? (are|is) not supported|vision is not (supported|enabled)|multimodal (input )?is not supported/i;
export const isNoVisionError = (message: string) => NO_VISION.test(message);

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
