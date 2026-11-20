---
name: final-cleanup
description: Clean up after a finished task: remove scratch scripts, test output, debug code, temp files and background processes left behind, and keep everything that belongs to the work. Use only once the task is confirmed complete (checks pass, or the user says it is done), or when asked to tidy up leftovers.
---

Clean-up removes what _you_ left behind while working. It never touches the user's own files or the real work.
When in doubt, keep it and list it for the user: a leftover file costs nothing, a deleted one can cost a lot.

## 1. Only when the work is done

Run the project's checks first (tests, build, linter: see AGENTS.md or the CI config). If anything fails, or the
user hasn't confirmed the task, stop: clean-up comes after, not instead.

## 2. Find what changed

```sh
git status --short --untracked-files=all
git diff --stat
git stash list
```

- Untracked files are the main suspects. Modified files are mostly the real work; check them for debug code.
- Look back over this conversation (the `sessions` tool with `id: "current"` if it was compacted) for files you
  created and processes you started: dev servers, watchers, `nohup … &`, containers.
- Outside a git repository, list recently changed files instead: `find . -newer <a file from the start> -type f`
  (PowerShell: `Get-ChildItem -Recurse -File | Where-Object LastWriteTime -gt (Get-Date).AddHours(-3)`).

## 3. Sort everything into keep, remove or ask

| Remove (you created it, and it isn't part of the result)      | Keep                                           |
| ------------------------------------------------------------- | ---------------------------------------------- |
| Scratch and one-off scripts (`test.py`, `tmp.js`, `debug.sh`) | The files the task asked for                   |
| Test output, logs, coverage reports not in `.gitignore`       | New tests that belong in the test suite        |
| Screenshots and downloads made to check something             | Config and docs changes that are part of it    |
| `*.bak`, `*.orig`, copies you made before an edit             | Lock files changed by installs the task needed |
| Debug prints and temporary logging you added                  | Anything the user created or changed           |
| Temp folders you made                                         |                                                |

**Ask** about anything else: files you can't account for, large generated folders, anything outside the project.

## 4. Clean up, carefully

- Stop processes you started, by the PID you noted or found (`kill <pid>`; Windows: `Stop-Process -Id <pid>`).
  Never by name (`pkill node` would stop the user's own programs).
- Remove debug code with `edit`, one change at a time.
- Delete files by exact path, listing each one: `rm path/to/scratch.py tmp/out.log`. No wildcards over the
  project, no `rm -rf` built from variables, no `git clean -fdx`, no `git reset --hard`, no `git checkout .`. If
  you want git's view, use the dry run only: `git clean -n`.
- Never delete `.env` files, data, databases, `node_modules` or virtual environments unless the user asks.
- Deletions go through approval like any other change: explain what goes and why.

## 5. Check nothing broke

Run the checks again. `git status` should now show only the intended changes.

## Report

- **Removed:** each file or process, with one word on what it was.
- **Kept:** anything you considered and kept on purpose.
- **For you to decide:** what you weren't sure about, with its path.
