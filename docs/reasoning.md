# Reasoning: thinking where it pays

Reasoning models think before every reply. In a tool loop, most replies are routine: read a file, run a command, look at the result, make the next small edit. A few need real thought: planning the work, recovering from an error, getting unstuck. Reasoning at full length on every step is where most of the wait goes on a local model.

`/reasoning` sets how much models reason, step by step:

| Mode       | What it does                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `always`   | The default: every step, as long as the model likes (unchanged from before). With `/effort` set, every step gets the key-step budget scaled by it. |
| `adaptive` | **Key steps** get a large budget (`keyBudget`, 8,192 tokens). **Routine steps** get a small one (`routineBudget`, 1,024 tokens).                   |
| `never`    | No reasoning at all: fastest, least careful.                                                                                                       |

These steps count as **key steps**: the first reply to your message, the step after a failed tool call, the step after a loop reminder, a message you steer in mid-turn, and the step after a compaction. A step after tool calls that all went fine is **routine**.

Run `/reasoning` with no argument to see the mode, the budgets, how this model's reasoning is switched off, and how the session has gone: requests, key steps, steps without reasoning, wrap-ups, and average reasoning per request. You can switch modes from the same menu. The footer shows `reasoning adaptive` or `reasoning never` when it isn't `always`, and the web dashboard has a **Reasoning** selector next to Effort.

## Wrap-up instead of a cut-off

When a step's reasoning runs past its budget, it isn't cut off blind:

1. The request stops, so the server stops generating.
2. The model is handed the end of its own reasoning (where it got to).
3. It's asked to act on that now, with reasoning off for that one request.

So it keeps its conclusions and skips the rest of the deliberation. This is the same idea as Qwen's own thinking budgets, and llama.cpp's reasoning-budget sampler, which forces the end of the thinking section. A step is wrapped up at most once: if a model ignores the switch and reasons again, it's left to finish.

Wrap-up notes are hidden from the transcript, like the harness's other notes to the model.

## Effort

`/effort` means "how hard to think on the hard parts". For models with real effort levels (gpt-oss, which reads `reasoning_effort`), it's passed to the model as before. For models without them, which includes Qwen, it scales the reasoning budget instead:

| Effort | Key-step budget in `adaptive` | Every step's budget in `always` |
| ------ | ----------------------------- | ------------------------------- |
| low    | × 0.5 (4,096)                 | 4,096                           |
| medium | × 1 (8,192)                   | 8,192                           |
| high   | × 2 (16,384)                  | 16,384                          |
| xhigh  | × 4 (32,768)                  | 32,768                          |

In `adaptive`, routine steps keep their budget at any effort, so they stay quick. Without `/effort`, `always` has no budget, as before.

## Switching reasoning off, for every model family

The harness reads each model's chat template from llama.cpp (`/props`) and switches reasoning off the way that template understands:

| Template reads     | Models                                    | Off is sent as                                               |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------ |
| `enable_thinking`  | Qwen 3 and later, GLM, most hybrid models | `chat_template_kwargs.enable_thinking: false`                |
| `thinking`         | DeepSeek V3.1 and later, Granite          | `chat_template_kwargs.thinking: false`                       |
| `reasoning_effort` | gpt-oss (cannot be switched off)          | `reasoning_effort: "low"`                                    |
| (nothing to read)  | other servers, routers                    | both of the first two; templates ignore what they do not use |

It also renders a short conversation through llama.cpp's `/apply-template` with reasoning on and off. If the two renderings differ only after the last message, switching keeps the cached conversation and nothing is re-read; `/reasoning` says so. If a template rewrites earlier turns when switched, `/reasoning` warns you, because every switch would then re-read the conversation.

The check runs once per model, and only when the mode isn't `always`, `/effort` is set, or a request needs reasoning off. With the defaults nothing is asked and nothing changes.

Compaction summaries are written without reasoning outside `always`.

## Sampling

Model cards give sampling settings for reasoning, and Qwen's warn that greedy or near-greedy decoding makes reasoning models repeat themselves and think endlessly. The harness doesn't send sampling unless you configure it, so the server's defaults apply. If the server's default temperature is near zero for a reasoning model, the harness warns once.

Set sampling per model by `<provider>/<model>` pattern (`*` matches anything; later matches win):

```json
{
  "sampling": {
    "*qwen*": { "temperature": 0.6, "top_p": 0.95, "top_k": 20, "min_p": 0 }
  }
}
```

Use the values from your model's card; the ones above are Qwen 3's published reasoning settings. `top_k`, `min_p` and `repeat_penalty` go only to local servers. OpenAI's API refuses fields it doesn't know.

## Server-side budget (llama.cpp)

llama.cpp can also cap reasoning itself: start `llama-server` with `--reasoning-budget N`. When the model reaches N reasoning tokens, the server forces the end of the thinking section. It works alongside the harness's budgets, as a backstop on the server. Some builds have defaulted to an effectively unlimited budget, and models then occasionally think until the KV cache overflows; a finite budget prevents that.

## Settings

| Setting                   | Default    | What it does                                                   |
| ------------------------- | ---------- | -------------------------------------------------------------- |
| `reasoning.mode`          | `"always"` | `always`, `adaptive` or `never`                                |
| `reasoning.routineBudget` | `1024`     | Reasoning tokens for a routine step. `0`: none; `-1`: no limit |
| `reasoning.keyBudget`     | `8192`     | Reasoning tokens for a key step. `-1`: no limit                |
| `sampling`                | `{}`       | Sampling per model pattern                                     |

Reasoning tokens are estimated at four characters each, the same way as the rest of the harness's counts.

**Tuning:** for more speed, lower `routineBudget` to 512, or to 0 to skip reasoning on routine steps entirely. For more care, raise it. `/reasoning` shows the averages, so you can compare on a real task.
