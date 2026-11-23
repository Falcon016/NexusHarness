# The mesh: several machines, used as one

The mesh turns every machine that serves models into one pool the harness works with:

- **Parallel tasks.** The agent can hand self-contained pieces of work to helper agents with the `task` tool. Each runs on the best free machine with a fresh, small context, several at once, and only its report comes back. This works like Claude Code's subagents, spread over your machines.
- **The right size of model for each piece.** Reading, searching and summarising go to small, fast models; ordinary changes go to mid-size ones; debugging, design and hard reasoning go to the largest. The agent can choose a tier, or let the harness guess from the task's wording.
- **A stronger model when stuck.** A task that keeps going round a loop moves up a tier, with a summary of what the smaller model tried. When the main agent gets stuck (its third loop reminder), a stronger model on the mesh takes over. Once the work has moved for six rounds without a loop, the main agent goes back to its own model.
- **Failover.** If the machine serving the main agent stops answering, the conversation carries on on another machine. It tries the same model first, then the same size, then the nearest size. The conversation lives in the harness, so nothing is lost; the new machine only has to read it once.
- **Placement by what each machine is doing.** The harness takes into account free slots, measured speed, round-trip time, which models are loaded, GPU load, and whether a machine may see your code.

Tools always run on the machine you run `nexus` on, with your usual approvals and sandbox. Only model requests go to the other machines. The mesh is **local only**: unless you list a machine yourself, it never sends anything to a cloud API.

When the mesh is off (the default), none of this exists. The agent gets no extra tool, its system prompt is unchanged, and no other machines are contacted.

## Setting it up

You need a model server on each machine. llama.cpp's `llama-server` gives the mesh the most to work with. For the slot and speed numbers, start it with `--metrics`; `/slots` is on by default. Any OpenAI-compatible server works; servers other than llama.cpp just report less.

**1. Add each model server as a provider** on the machine you work on, with `/login` or in `config.json`:

```json
{
  "providers": {
    "p40": { "type": "openai", "baseUrl": "http://192.168.1.20:8080/v1" },
    "rtx": { "type": "openai", "baseUrl": "http://192.168.1.21:8080/v1" },
    "mini": { "type": "openai", "baseUrl": "http://macmini.local:8080/v1" }
  }
}
```

**2. Optional, for GPU, RAM and CPU numbers: run `nexus node` on each machine.** llama.cpp cannot report VRAM, RAM or CPU load, so this small service does. It is read-only: it answers one signed request with hardware numbers and has no way to run anything. On each machine:

```sh
nexus node pair     # makes this machine's pairing key; shows how to read it once
nexus node          # starts the service on port 7878
```

To keep it running, run it under systemd or launchd. Here is an example systemd unit:

```ini
# /etc/systemd/system/nexus-node.service
[Unit]
Description=NexusHarness node service (read-only hardware numbers)
After=network-online.target

[Service]
User=youruser
ExecStart=/usr/bin/env nexus node
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**3. Add the machines** on the machine you work on. You'll be asked for each pairing key without it being shown:

```sh
nexus mesh add p40  http://192.168.1.20:7878 --providers p40
nexus mesh add rtx  http://192.168.1.21:7878 --providers rtx
nexus mesh add mini http://macmini.local:7878 --providers mini
nexus mesh list
```

Leave out the `http://…:7878` address for a machine that doesn't run `nexus node`. If you add `--not-sensitive`, that machine only gets tasks the agent marks as involving nothing private.

Without any `mesh.nodes`, `"mesh": { "enabled": true }` on its own treats every model server on this machine or your local network as its own node.

## Seeing it

- `/nodes` in the terminal lists each machine: up or down, round-trip time, GPUs (memory, load, temperature), RAM, CPU, and each model with its tier, context size, busy slots and measured speed.
- The web dashboard's side panel has a **Machines** card with the same information, refreshed every 10 seconds.
- `nexus mesh list` prints it from the command line.
- Each task shows where it is running while it works, and its report ends with where it ran and for how long: `[task "Map the auth module" ran on mini · mini/qwen3-4b · 38s]`.

## Tiers

| Tier       | Used for                                     | Models               |
| ---------- | -------------------------------------------- | -------------------- |
| `fast`     | reading, searching, listing, summarising     | under 10B parameters |
| `standard` | ordinary changes                             | 10B to 22B           |
| `strong`   | debugging, design, refactors, hard reasoning | 22B and up           |

Sizes come from the server (llama.cpp reports the parameter count) or the model's name (`qwen3-27b` is 27B). If a guess is wrong, set the tier yourself:

```json
{ "mesh": { "tiers": { "rtx/coder-7b": "standard" } } }
```

If no model of the wanted tier is up, the next size up is used, then the next size down.

## Why the main agent keeps its model

Switching the main agent's model on every step looks efficient, but it would make things slower. A model server keeps the conversation it has read in its cache. A different model, on another machine, has to read the whole conversation from scratch first, which on a long session takes minutes. So the main agent stays on one model. The speed comes from handing pieces of work to helper agents with short briefs, and from changing model only when it actually helps: when the machine goes down, or when the work is stuck.

## Settings

| Setting             | Default | What it does                                                                                        |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `mesh.enabled`      | `false` | Turns the mesh on                                                                                   |
| `mesh.nodes`        | `{}`    | Machines by name: `providers` on it, `agent` (its `nexus node` address), `sensitive` (default true) |
| `mesh.probeSeconds` | `15`    | How often the machines are checked, in the background                                               |
| `mesh.tiers`        | `{}`    | Tier per `<provider>/<model>`, where the size-based guess is wrong                                  |
| `mesh.maxTasks`     | `4`     | Tasks running at once across the mesh                                                               |

## Security

- **Only model requests leave this machine.** Tools, files, approvals and the sandbox stay here. A remote machine cannot run anything on yours, and machines cannot command each other.
- **The node service is read-only and signed.** Each request carries an HMAC-SHA256 signature made with the machine's pairing key and a timestamp; a request older than a minute is refused. The reply is signed too and checked, so nothing on the network can read the numbers or feed the harness false ones. The pairing key is stored with your other keys, with owner-only permissions on both ends.
- **Sensitive work stays on trusted machines.** Your conversation, and tasks by default, only go to nodes with `sensitive: true`. A node with `sensitive: false` only gets tasks the agent explicitly marks as involving nothing private.
- **Local only.** Without a `mesh.nodes` list, only servers on this machine or private network addresses count (localhost, 10/8, 172.16/12, 192.168/16, Tailscale's 100.64/10, `.local` and `.lan` names). A cloud API is never added on its own.
- Model servers themselves (llama.cpp) are not authenticated unless you give them an API key (`--api-key`, and `apiKeyEnv` in the provider). Keep them on your LAN or Tailscale.
