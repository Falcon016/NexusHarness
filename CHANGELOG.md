# Changelog

## 0.1.0 — unreleased

First release of the ground-up rewrite (replaces the earlier turtlebot harness).

- **Reasoning where it pays (`/reasoning`, `reasoning.mode`; [docs/reasoning.md](docs/reasoning.md)).**
  - **Adaptive mode:** key steps (planning, after an error or loop, after a steer or a compaction) get a large
    budget and routine steps a small one; a step past its budget is wrapped up with the model's own reasoning
    handed back to act on, at most once.
  - **Effort:** `/effort` now does something for models without effort levels (Qwen): it scales the key-step
    budget.
  - **Switching reasoning off:** done the way each model's template reads it (`enable_thinking`, `thinking`,
    `reasoning_effort`), found from llama.cpp's `/props`, with a check through `/apply-template` that switching
    keeps the cached conversation.
  - **Summaries:** compaction summaries are written without reasoning outside `always`.
  - **Sampling:** per-model `sampling` settings, and a warning when a reasoning model is sampled near-greedily.
  - **Unchanged by default:** `always` with no budget unless `/effort` is set.
- **Sentry mode (`/sentry`, off until you turn it on; [docs/sentry.md](docs/sentry.md)).** A defensive mode inspired
  by Shirudo's shields.
  - **Watch:** a baseline of this machine (accounts, admins, SSH keys and settings, setuid programs, listening ports,
    scheduled jobs, startup items, services, firewall, kernel modules, LAN devices) is compared on every sweep, and
    failed SSH logins are counted.
  - **Investigate:** a read-only sentry agent looks into medium and worse findings once the main agent is free.
  - **Shield:** six narrow, reversible protections. Blocking an attacking outside address (with a timeout, in
    sentry's own nftables table) and quarantining a file you can move go ahead on their own; everything else asks
    you every time, in every mode.
  - **Record:** every action goes on an HMAC-chained ledger.
  - **Alert:** alerts reach the terminal, the dashboard's Sentry card, and Telegram when the bot is set up.
  - Tools can now settle their own approval (`approval`): shields that must always ask offer no "don't ask
    again".
- **The mesh: several machines serving models, used as one** (`mesh`, off by default; [docs/mesh.md](docs/mesh.md)).
  - `task` runs self-contained work as helper agents in parallel on the best free machine, with fresh contexts; only their reports come back.
  - Work is matched to the size of model it needs (fast, standard, strong; set by the agent or guessed from the wording).
  - A stuck task moves up a size with a summary of what was tried, and a stuck main agent gets a stronger model until the work moves again.
  - If a machine stops answering, the conversation carries on on another one.
  - `nexus node` reports GPU, RAM and CPU load (read-only, signed with a per-machine key).
  - `nexus mesh add|list|remove` and `/nodes` manage and show the machines, and the dashboard has a Machines card.
  - Local only: cloud APIs are never added on their own.
- **Loop detection (`loopDetection`, on by default).** A model stuck in a loop is moved on without stopping the
  work or ending the turn. A reply, its reasoning or a file being written that starts repeating the same passage
  is stopped within a second or two: what came before the repeats is kept, the model is told what happened, and
  the request is sent again with a presence penalty (stronger each time in a row) and, after looping reasoning,
  with reasoning off for that one request. Repeating the same tool calls with the same results (back to back, or
  as a cycle of a few calls) gets a reminder in the tool result, naming the current task and saying not to skip
  it, and again, more firmly, every time round. Polling that sees the result change is not a loop. Rounds spent
  looping do not count toward `maxToolIterations`, so a loop never stops the work.
- **No tool-call limit by default.** `maxToolIterations` now defaults to `0` (no limit), so long tasks run to the
  end without stopping to ask you to continue. Set a number (or use `/limits`) to bring a limit back.

- **A model that can't see images no longer breaks the session.** When the agent read a screenshot on a
  llama.cpp model started without its vision projector (`--mmproj`), the server refused the request
  ("image input is not supported"), and since the image stayed in the conversation every later request failed
  the same way. Now the refusal is recognised (llama.cpp, LM Studio, vLLM, OpenAI-style), said once, and images
  are left out of what is sent from then on, with a note telling the model to check visual results another way.
  The request is not retried three times first, and llama.cpp's `/props` is read at startup so a text-only model
  is known before any image is sent. Sessions already stuck this way recover on the next message.
- **New skill `prompt-guard`:** signs of prompt injection, rules for acting on web pages (no secrets unless asked
  for that exact site, confirm anything that buys, posts, sends or deletes), and what to do when a page tries it.
- **You can see what the agent is doing while it works.** The line under the live area now says it in words, with
  a turning star and a shimmer: reading the conversation (with its size), thinking, writing the reply, writing
  `os.css`, running a command, compacting. It shows how long that step has taken, the tokens so far, the whole
  turn when it is long, and a warning when the model has gone quiet for 30 seconds. A file being written shows
  its name, its size so far and its latest lines as they stream in (before, a long write looked like the agent
  was stuck thinking).
- **Compaction is visible.** While it runs: how far along the summary is, whether the model is still reasoning,
  which part of how many. When it ends: one line with before and after, how many messages were summarised and
  how long it took. The context meter updates as each request goes out, after every tool result and right after
  a compaction, not only when a reply finishes.
- **Long task lists get finished.** When the agent stops with items still open after changing things, it is asked
  to update the list and carry on with the next item (once per run), instead of only to update the list.
- What the agent reports along the way ("using effort high", "asking the model to update its task list") is kept
  in the transcript; it used to sit in the status line until the turn ended.
- **No more repeated text or runs of blank lines on Windows consoles.** Lines were drawn as wide as the window,
  and the classic Windows console moves to the next line as soon as the last column is written, so each such line
  took two rows; every redraw then left a row of the previous frame behind. Nothing is drawn in the last column
  now. Command output and model text are also cleaned before they are drawn (escape codes removed, tabs to
  spaces, carriage returns resolved), since a tab or a cursor move from a progress bar threw Ink's line count off
  on any terminal.
- **Eleven new skills**: an IT admin toolkit (`it-admin`: read-only health snapshot scripts for Linux/macOS and
  Windows, and playbooks for slow systems, full disks, networks, services and logs, accounts, patching, a security
  check-up, backups, Docker and Proxmox), `debugging`, `pr-review`, `simplify`, `webapp-testing`,
  `frontend-design`, `documents` (PDF, Word, Excel, PowerPoint), `mcp-builder`, `init` (AGENTS.md),
  `resume-work` and `skill-creator`. Skills can now ship extra files that the agent reads only when a step needs
  them.
- **The agent can read earlier conversations**: the new `sessions` tool lists, searches and reads the saved
  sessions for this folder (or all of them), including the current one, so detail a compaction summary dropped is
  recoverable. `nexus -c` now shows the resumed conversation on screen, `/resume` lists conversations with their
  last request and takes an id, and listing them no longer reads every file in full.
- **No more repeated text, and no more slowdowns while a reply streams.** The live area under the transcript is
  capped below the window height (a taller frame left a copy of itself in scrollback on every redraw, many times a
  second: the repeated text, and a heavy load on the terminal). A long code block no longer makes streaming
  quadratic, the screen redraws at most 20 times a second, a resize or `/resume` reprints only the last 250
  entries, and Node warnings show as notices instead of tearing the screen. `/resume` and `/tree` after a long
  transcript no longer skip the start of the conversation they bring back.
- **Approvals show the exact command**, not only the description the model wrote for it (terminal, dashboard and
  Telegram), and fit small windows.
- The speed meter stays in the footer on narrow terminals: it now outlasts the effort, sandbox and browser labels
  when the line runs out of room (since the effort label was added it was dropped below about 80 columns).
- **`/login` and `/logout`**, after pi's: pick a provider, then give it an API key (masked) or an address
  (pre-filled, so swapping llama.cpp servers is one edit); add a server of your own; each is checked by listing its
  models before it is saved, then you pick one, and a model in use reconnects at once. `/logout` removes a saved key
  and, for a server you added, the server. `nexus setup` run again now lets you change a saved server that still
  answers instead of keeping it, and can re-point a server added earlier.
- **Reasoning effort**: `/effort` picks low, medium, high or xhigh (or the model's default) for every agent, and
  saves it; the footer shows it, the dashboard has a selector, and the Telegram bot has `/effort`. It is sent as
  `reasoning_effort` plus the chat template's `reasoning_effort` (llama.cpp, Ollama, vLLM, LM Studio; only the
  former to OpenAI) and as `output_config.effort` to Anthropic. A model that refuses `xhigh` is asked again at
  `high`, and one that takes no effort setting is asked without it, with a note instead of an error.
- **Renamed to NexusHarness** (it was Nacreframe), with the `nexus` command; `nacre` still works. Settings, API keys
  and sessions move to the new folders on first start; `NACRE_*` environment variables, `.nacreframe/` project
  folders and `NACREFRAME.md` are still read; the installer moves `~/.nacreframe` to `~/.nexusharness`, and an install
  updated with `/update` gets the `nexus` command added beside `nacre`. New black-and-blue look from the new logo
  across the terminal UI, dashboard, installer, setup wizard and terminal schemes; `◉` is the mark in text, and the
  welcome panel's mascot is Nex, a small agent robot.

- Agent loop with streaming, parallel read-only tools, steering, abort, session trees.
- **Compaction that cannot corrupt a conversation**: always on, at most 80% of the real context window, the chat is
  held while it runs, transactional and chunked, falls back to shorter tails, pauses instead of overflowing; dangling
  tool calls are repaired; tool results are capped.
- Providers: Anthropic and any OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio, Unsloth Studio, vLLM...).
  Context windows are detected from the server. No default model.
- **Telegram bot**: `nexus telegram` relays your messages to an agent and its replies, progress, approvals (buttons)
  and questions back. Only allowed users in private chats; the token lives in auth.json. `nexus setup` connects a
  bot, checks the token and finds your account by asking you to message it.
- **Built-in skills**: `python-env`, `security-review` and `pre-commit-review` ship with the harness (user and
  project skills of the same name replace them); `/skills` lists what is installed. The swarm's reviewer and
  security advisor are pointed at theirs.
- **`/context`**: shows the context window, where it came from, how much is used and where compaction starts.
  `/context 128k` sets it for the model in use and saves it (it then wins over what the server reports, which is
  still asked at every start); `/context auto` goes back to the server's figure. Also in the Telegram bot.
- **Tokens per second** in the terminal footer and the dashboard: live while a reply streams, then the reply's
  measured speed. The footer now fits narrow windows by dropping its least useful parts instead of running together.
- **No repeated text in the terminal**: a reply taller than the window used to leave copies of itself in the
  scrollback on every redraw. Each finished line of a reply is now printed as it arrives, and the live area (the
  unfinished part, the task list, running tools) always fits in the window.
- **Compaction no longer restarts finished work**: the summary is marked as background rather than a new request,
  separates what is done from what remains, is written knowing what happened after the part it compresses, and
  carries the current task list.
- **Task lists stay current**: the agent is reminded once if it finishes working while its list still shows open
  items, and the list survives compaction.
- **Replies can use the whole context**: by default each model call may write as much as fits in the context window
  after the prompt (`maxTokens: 0`), instead of a fixed 8192 tokens; long answers and long reasoning no longer get
  cut off early. Hosted APIs that cap output lower say so when they refuse, and the agent takes their figure and
  retries. Set `maxTokens` to a number to cap it.
- Approval modes `ask` / `edits` / `auto` / `plan` with rules; sandbox levels `off` / `guard` / `container`.
- Live browser control via Playwright with host policy and user take-over.
- Collaborative swarms in a shared channel with split-pane view; persistent, compacted, resumable like any session.
- Ink TUI with the Nexus theme; print / JSON / RPC modes.
- Self-hosted web dashboard (`nexus serve`): token auth, strict CSP, SSE streaming, approvals, context meter, swarm,
  live browser view; Docker and systemd deployment files.
- Extensions, skills, prompt templates, MCP client, `AGENTS.md`.
- `nexus models`, `nexus doctor`, `npm run live-check`.
- **One-command install** for Linux, macOS and WSL: `curl -fsSL .../install.sh | sh` checks Node/git/npm, builds into
  `~/.nexusharness`, links `nexus`, asks before touching your shell profile, updates by re-running, and `--uninstall`.
  It installs what is missing: a private, checksum-verified Node.js when none is usable, and git through your package
  manager if you agree. `nexus` is a launcher that picks that Node.js and repairs a damaged install on its own;
  `install.sh --repair` does the same by hand.
- **Fixes from a bug pass**: live reasoning is word-wrapped and grows line by line instead of sliding sideways in a
  single cut-off line (it looked like it was buffering); the dashboard streams it too, and the server sends only
  its tail. A teammate whose turns keep failing (model server down) pauses the team after three failures in a row
  instead of being re-woken forever when there is no message limit; failed turns and turns stopped at the
  tool-call limit are reported to the lead as such. Custom agents cannot be named `you`, `system` or `all`.
- **Swarm limits**: `/swarm custom` asks how many messages the agents may send each other before checking in with
  you, and how many tool calls one agent may make per turn, and saves both to your config (0 / "No limit" allowed).
  `/swarm limit [n|off]` changes them any time, also for a running team. The footer shows `messages 12/60` beside
  the context meter, amber near the limit and red when the team is waiting; the dashboard shows the same.
- **`/update`** and `nexus update [--check]`: check the installed branch for a newer version, show what changed, ask,
  update through the installer, and offer to restart straight into it, continuing the conversation. `--version` now
  reads `package.json`, so it always shows the installed version.
- **Thinking**: each agent's reasoning is kept. Hidden, it is one quiet line ("✻ planner thought for 8s"); ctrl+t or
  `/thinking` shows it in full, set off by a rule in the agent's colour, both in the transcript and live in the swarm
  panes. The dashboard shows it as a line that opens. Reasoning that local models write inline as `<think>...</think>`
  is separated from the answer. `showThinking: true` shows it by default.
- **Teams**: `/swarm quad` (architect, builder, reviewer, security advisor) joins `duo` and `trio`; `/swarm custom`
  builds a team of any size from a list of roles or roles you write, and can save it as `/swarm config`. Agents no
  longer add teammates unless `swarm.allowSpawn` is on, so `trio` stays three. Reviewers and the security advisor
  cannot edit files.
- **`/flush`** deletes old saved conversations and swarms: older than N days or everything, for this folder or every
  folder. It shows what it would delete and asks first; the current conversation and running swarm are always kept.
- **Swarm reporting lines**: only the lead talks to you; teammates report to the lead. Teammates lose `ask_user`,
  their messages to you are rerouted to the lead, a turn that ends without a message is delivered as a report (so
  small models no longer stall the team), plain-text `@mentions` from the lead are delivered, and every wake-up
  restates the agent's role.
- **Terminal UI**: a framed welcome panel with the mascot (a pearl in its shell) at launch; the screen is cleared and
  reprinted after a resize, which fixes ghost copies of the swarm panes when going fullscreen; swarm panes stay short
  enough to fit the window and give way to a one-line roster in small windows or while a dialog is open.
- **New look**: a black and deep-purple palette shared by the dashboard, terminal UI, installer, setup wizard and the
  bundled terminal schemes; a new logo (a pearl between two brackets, `[●]` in the terminal) replaces the diamond.
  The dashboard drops glows, gradient washes and floating cards for hairlines and surface steps, groups mode, sandbox
  and model into one control, shows keycaps on approvals, and opens on a list of your allowed folders. Newsreader is
  no longer bundled.
- **`nexus doctor --fix`** repairs broken or invalid settings, a missing API key, key-file permissions, missing folders, a
  missing or off-`PATH` launcher, a too-old Node.js and (after asking) a missing browser; plain `nexus doctor` offers it.
  The Node.js check now compares the minor version (22.18), not just the major.
- **`nexus setup`**: guided wizard (arrow-key menus; provider, API key checked before saving, local-server detection,
  model, approval mode, sandbox, browser) that saves nothing until confirmed and keeps unrelated settings. `--yes`
  mode with flags for scripts and CI. `nexus doctor` and `setup` share their system checks.
