# Learning: getting better at tool calls without training

Local models make the same tool-call mistakes again and again: a command that hangs in this project, an argument they keep leaving out, an edit that never matches. With learning on, NexusHarness remembers what fixed each mistake and hands it back next time. It doesn't train or change the model. It learns by writing short notes and loading them again later.

It's on by default. To turn it off (saved), run:

```
/lessons off
```

The dashboard has a **Learning** selector too. The footer shows `learning` while it's on.

## Lessons

When a tool call fails and the model gets the same thing working a few calls later, the harness keeps both versions. That means the same tool, and for `bash` the same program. At the end of the turn, it asks the model for one line about what to do instead, for example:

> Run tests with `npx vitest run`; `npm test` starts watch mode and hangs.

The model answers `NONE` for one-offs like a typo. This request has reasoning off and isn't saved in the conversation. It sends the same conversation the server just processed with one question added, so llama.cpp reuses its cache and answers in seconds.

Lessons are kept in two places:

- **Per project**, for how things work here: commands, files and tooling.
- **Per model family**, for how a model calls tools: arguments it leaves out, edits that don't match. A family is `qwen3.8`, `gemma3`, `gpt-oss` and so on, so a lesson outlives a requantization or a fine-tune.

## Keeping context small

Everything learned that goes into the prompt shares one budget: `learning.budget`, 600 tokens by default. That's under half a percent of a 128k context.

- **Up front:** the best lessons go in a short block of the system prompt, up to 60% of the budget. Learned skills' one-line descriptions use what's left. Anything that doesn't fit is left out.
- **Just in time:** every lesson, in the prompt or not, is added to a failed tool result when that failure comes back, marked `[Lesson]`. A lesson costs nothing until the moment it's useful, and it's handed over at most once a turn.
- **Fixed per conversation:** the up-front block is worked out when a conversation starts and doesn't change during it. A llama.cpp server keeps the start of the prompt it has already processed, so learning something new never makes it re-read the conversation. New lessons join the prompt from the next conversation (`/new`).
- **Short by design:** a lesson is one line of at most 200 characters. A skill is listed by name and one-line description; its steps load only when the model opens it.
- **Pruned:**
  - at most `learning.maxLessons` (30) per project and per model family, dropping the weakest;
  - a new lesson about the same failure replaces the old one;
  - lessons not seen for 90 days are dropped.

`/context` shows how many tokens learned lessons and skills take in the current prompt.

## The harness checks whether a lesson works

The model doesn't grade its own lessons. The harness counts, for each lesson:

- **helped:** it was handed over at a failure, and the model's next call of that tool worked;
- **came back:** its failure happened again in a later conversation (counted once per conversation);
- **handed over:** how often it was shown.

A lesson whose failure keeps coming back without it helping is dropped. That happens after three times, as long as it has helped less than half as often. Lessons that help rise to the top of the up-front block.

## Skills from long tasks

After a task that took at least `learning.skillAfterCalls` tool calls (8) and ended with calls that worked, the harness offers to keep how it was done:

> That took 14 tool calls. Run /lessons save to keep how it was done as a skill for next time.

`/lessons save` asks the model to write the skill from the calls it made: a name, a one-line description, the steps, and the pitfalls. You see the draft and choose **Save** or **Discard**. Nothing is saved without you.

Saved skills are kept per project, in NexusHarness's data folder, not in your repository. They work like any other skill: listed in the prompt within the learning budget, with their steps loaded when the model opens one. When a saved skill was used and something still went wrong, the offer is to update that skill with what worked.

## /lessons

`/lessons` shows:

- whether learning is on, the budget, and what the current prompt uses;
- each lesson, with its counts (helped · came back · handed over) and its size in tokens;
- each saved skill, with how often it was used. A skill not used for 45 days or more is marked for you to consider deleting.

From its menu you can turn learning on or off, delete a lesson or a skill, or save the last long task as a skill.

| Command          | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `/lessons`       | Show what has been learned; menu to delete or switch               |
| `/lessons on`    | Turn learning back on (saved)                                      |
| `/lessons off`   | Turn it off (saved). What was learned is kept                      |
| `/lessons save`  | Draft a skill from the last long task, then save or discard it     |
| `/lessons clear` | Delete every lesson for this project and model family (asks first) |

## Safety

- **Local tools only:** lessons are learned from `bash`, the file tools and `skill`, plus mistakes in how any tool was called. Web, browser and MCP output is untrusted, so the harness never learns from it.
- **Inputs are data:** the failed call, its error and the call that fixed it are passed to the model as data inside `<untrusted_content>`, and cut to a few hundred characters.
- **No secrets:** a lesson or skill draft that looks like it contains a secret (the same patterns used to redact tool output) is thrown away.
- **No steering:** lines that read like an attempt to steer the agent are thrown away. That includes "ignore previous instructions", URLs, piping downloads into a shell, and anything about approval modes or the sandbox.
- **Visible:** everything learned is listed by `/lessons`, where you can delete it.

## Files

- **Lessons:** `<data>/learning/projects/<project>.json` and `<data>/learning/models/<family>.json`.
- **Saved skills:** `<data>/learning/skills/<project>/<name>/SKILL.md`.

`<data>` is `~/.local/share/nexusharness` on Linux, `~/Library/Application Support/nexusharness/data` on macOS, and `%LOCALAPPDATA%\nexusharness\data` on Windows.

## Settings

| Setting                    | Default | What it does                                                         |
| -------------------------- | ------- | -------------------------------------------------------------------- |
| `learning.enabled`         | `true`  | Learn from tool calls (`/lessons off` turns it off)                  |
| `learning.budget`          | `600`   | Prompt tokens learned lessons and skills may take, together          |
| `learning.maxLessons`      | `30`    | Lessons kept per project and per model family                        |
| `learning.skillAfterCalls` | `8`     | Offer to save a task as a skill after this many tool calls; 0: never |
