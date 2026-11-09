---
name: skill-creator
description: Write a new NexusHarness skill (or improve one): a SKILL.md with a description that triggers at the right time, step-by-step instructions, and optional extra files such as playbooks or scripts. Use when asked to make, add, improve or package a skill, or to turn a workflow into one.
---

A skill is a folder with a `SKILL.md`. Only its `name` and `description` sit in every system prompt; the body is
loaded when a task matches. So the description decides _when_ it is used, and the body decides _how well_.

## 1. Pin down the job

Ask (or work out from the conversation): what task should this handle, what does a good result look like, and
what does the agent get wrong without it? Collect one or two real examples of the task. A skill that captures
the steps of something that just worked in this conversation is the easiest to write well; the `sessions` tool
finds earlier ones.

## 2. Where it goes

- Just for this user: `<config>/skills/<name>/SKILL.md` (`nexus doctor` prints the settings directory).
- For a project, shared through git: `.nexusharness/skills/<name>/SKILL.md` (loaded once the project is trusted
  with `nexus trust`).
- A user or project skill with the same name as a built-in one replaces it.

`name` is lowercase with hyphens and matches the folder.

## 3. Write the description

One or two sentences, under about 300 characters: what it does, then "Use when …" with the situations and words
a user would actually say. Specific beats broad: "Use when a Python import fails or pip reports conflicts" will
trigger correctly; "Helps with Python" will not.

## 4. Write the body

- Imperative steps in the order they are done, with the exact commands, file names and checks.
- Say how to verify the result, and what to report at the end.
- Explain the why behind a rule in a few words when it is not obvious; the model follows reasons better than
  bare orders.
- Cover the common failure and what to do about it.
- Keep it under about 500 lines. Skip what any capable agent already knows.

```markdown
---
name: release-notes
description: Write release notes from the commits since the last tag, grouped for users. Use when asked for release notes, a changelog entry, or "what changed since vX".
---

1. Find the last tag: `git describe --tags --abbrev=0`.
2. ...

## Report

...
```

## 5. Extra files (optional)

Put long reference material or scripts next to `SKILL.md`, for example `playbooks/network.md` or
`scripts/check.sh`. They are listed when the skill loads and read on demand with the skill tool's `file`
argument, so they cost nothing until needed. Mention in the body when to read or run each one. Scripts should be
safe to run as they are, print plain text, and not need interaction.

## 6. Try it

Run `/skills` to check it loads (a missing description skips it with a warning). Then try a request that should
trigger it and one that should not, and read what the agent does. Tighten the description if it misfires and the
steps where the agent went wrong.

## Report

Where the skill is, its description, and how you tested it.
