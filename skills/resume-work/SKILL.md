---
name: resume-work
description: Pick up earlier work where it stopped, from saved conversations and the state of the project, and confirm what is done before continuing. Use when the user says "continue", "where were we", "pick up where we left off", refers to something done in an earlier session, or after a /clear or compaction lost detail you need.
---

Earlier conversations in this folder are saved, and the `sessions` tool reads them. Saved words are a record of
what was said, not proof of what is true now: check the project before you build on them.

## 1. Find the conversation

- `sessions` with `action: "list"` shows recent conversations with their first and last request. Pick the one
  that matches what the user means; if two could, ask which.
- If the user names a topic ("the login fix"), `action: "search"` with a few distinctive words (a file name, an
  error message, a function) finds it faster.
- Lost detail from this same conversation after a compaction: `id: "current"`.

## 2. Read the end first

`action: "read"` without an offset shows the last entries: that is where the plan, the open items and the last
results are. Read further back (`offset`) only for the parts you need: a decision, an error, the exact command
that worked. Look for:

- what the goal was, in the user's words;
- what was finished, and how it was checked;
- what was in progress or planned next (a task list, "next I will…");
- decisions and constraints the user gave ("don't touch the API", "use pnpm").

## 3. Check the project now

```sh
git status --short
git log --oneline -10
git stash list
```

- Confirm that work described as done is really there (files exist, the change is in the code, the commit
  happened). Run the tests if the last session left them failing or did not run them.
- Note anything that changed since (new commits by someone else, files edited by hand).

## Report, then continue

Give a short recap before doing anything that changes files:

- **Where it stopped:** one or two sentences.
- **Done and verified:** what the project confirms.
- **Next:** the remaining steps, as a task list (`todo_write`) when there are several.
- **Differences:** anything the record says that the project does not match.

If the next step is clear and the user asked you to continue, carry on with it. If the record and the project
disagree, or the plan depended on something that changed, ask first.
