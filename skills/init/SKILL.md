---
name: init
description: Write or refresh the project's AGENTS.md, the instructions every agent session reads (build and test commands, layout, conventions, gotchas). Use when asked to "init" a project, set up agent instructions, or when AGENTS.md is missing or out of date.
---

AGENTS.md is read at the start of every session in this folder (and its subfolders), so every line costs context
on every turn. Write what an agent cannot quickly work out by itself, and nothing else.

## 1. Learn the project

Read, don't guess. Look at, in this order:

- An existing `AGENTS.md`, `NEXUSHARNESS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md` or
  `CONTRIBUTING.md`. Keep what is still true; these are the best source.
- `README*`, then the build files: `package.json` (scripts), `pyproject.toml`, `Makefile`/`justfile`,
  `Cargo.toml`, `go.mod`, `docker-compose.yml`.
- CI under `.github/workflows` (or similar): it shows the exact commands that must pass.
- The top two levels of the tree (`ls`, `glob`), and a few central source files to see naming and style.
- `git log --oneline -15` for the commit style.

## 2. Check the commands

Run the build, test and lint commands you are about to document (quick ones; skip anything that deploys,
publishes or takes minutes). Write down only commands that work, with any setup they need (env vars, a running
database, `npm ci` first).

## 3. Write it

Aim for 30–80 lines. Suggested sections, each only if it has something real in it:

```markdown
# <Project>: notes for coding agents

<One or two sentences: what it is, language and main frameworks.>

## Commands

- Install: `...`
- Test (all / one file): `...` / `...`
- Lint, format, type check: `...`

## Layout

- `src/...`: what lives where, only the parts that are not obvious.

## Conventions

- Rules the code follows that a newcomer would break (import style, error handling, naming, where tests go).

## Gotchas

- Things that wasted time before: generated files not to edit, env vars, ports, platform quirks.
```

- Be specific: `npm test -- path/to/file.test.ts` beats "run the tests".
- No generic advice ("write clean code", "add tests"): the agent already knows it.
- No secrets, tokens or personal paths.

## 4. Updating an existing file

Edit it in place with `edit`; don't rewrite it from scratch. Fix what is wrong, add what is missing, and remove
lines that are stale. Keep the owner's wording and order where it still works.

## Report

Say what you created or changed, which commands you ran to check it, and anything you could not verify.
