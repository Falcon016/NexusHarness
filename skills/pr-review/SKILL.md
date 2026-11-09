---
name: pr-review
description: Review a pull request or a branch against its base, the way a careful senior reviewer would, and report findings by severity with file and line. Use when asked to review a PR (by number or URL), a branch, or "what changed since main".
---

Review; do not edit files or push unless asked. Every finding must point at code you have read. A short review
with three real problems beats a long one with fifteen guesses.

## 1. Get the change

With a PR number or URL and the GitHub CLI available:

```sh
gh pr view <n> --json title,body,baseRefName,headRefName,files,additions,deletions
gh pr diff <n>
gh pr checks <n>          # CI status
```

Without `gh`, or for a local branch:

```sh
git fetch origin
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
git diff origin/<base>...HEAD
```

Read the PR description first: review the change against what it says it does.

## 2. Understand before judging

- For each changed file, read enough of the surrounding code (callers, the types it uses, tests) to know what
  the change affects. The diff alone hides most bugs.
- If the project has checks, run them on the branch (see AGENTS.md or the CI config). Failures are findings.

## 3. What to look for, in order

1. **Correctness:** wrong logic, missed cases (empty, null, very large, concurrent), off-by-one, missing `await`,
   errors swallowed or thrown where callers don't expect them, behaviour changed for existing callers.
2. **Security:** user input reaching a shell, SQL, file path or HTML; secrets in code; auth checks missing or
   bypassable. Load the `security-review` skill for anything security-sensitive.
3. **Tests:** new behaviour without a test, tests that can't fail, deleted or weakened assertions.
4. **Design:** duplicated logic that exists elsewhere, an abstraction that doesn't fit, a public API change
   without a migration path.
5. **Clarity:** misleading names, comments that describe the old behaviour, docs the change makes wrong.

Skip formatting nits a formatter would fix, and personal taste.

## Report

Start with a one-paragraph summary: what the PR does and whether it is ready to merge.

Then findings, most serious first:

```
[blocking] src/auth/session.ts:84: the token is compared with ===, which leaks timing; use timingSafeEqual.
[should-fix] src/api/users.ts:120: a missing user now returns 500 instead of 404 (getUser throws).
[nit] README.md:40: the example still uses the old flag name.
```

- `blocking`: must change before merge. `should-fix`: worth fixing now. `nit`: optional.
- Say why it matters and what to do instead. Quote the line when it helps.
- End with what you checked and did not check (for example "did not run the e2e tests").

Post the review on GitHub (`gh pr review`) only if the user asks.
