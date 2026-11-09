---
name: debugging
description: Find the real cause of a bug, crash, failing test or wrong output by reproducing it, narrowing it down and proving the fix, instead of guessing. Use when something fails and the cause is not obvious, or after a first fix attempt did not work.
---

Guessing and patching symptoms is the most common way a fix goes wrong. Work in this order, and don't skip to a
fix before step 3 has a cause you can point at.

## 1. Reproduce it

- Get the exact failure: the command, the input, the full error and stack trace. Run it yourself.
- Make the smallest reliable reproduction you can: one test, one script, one request. Save it; you will run it
  after the fix.
- If it does not fail for you, find what differs from where it fails: versions (`node -v`, `python -V`, lock
  files), environment variables, data, OS, timing. Don't fix what you cannot reproduce; say so and ask for more.

## 2. Read the evidence

- Read the whole stack trace from the bottom frame in your own code, not just the message. Open each file it
  names at that line.
- Read the code path the failing input takes. Check what each value actually is; add a temporary print or log if
  you need to (and remove it afterwards).
- Check recent changes: `git log -p -5 -- <file>`, or `git bisect` when you know a commit where it worked.

## 3. Narrow it down

- Form one hypothesis at a time and state it: "the cache returns the old value because the key ignores the
  locale".
- Test it with the quickest experiment that could prove it wrong: a log line, a smaller input, an assert.
- Halve the search space each step: comment out half, feed half the data, check the midpoint of the pipeline.
- If a hypothesis is wrong, drop it completely. Don't stack a second fix on a first one that did nothing.

Common causes worth checking early: wrong working directory or path, stale build output or cache, a different
version installed than the one in the lock file, async work not awaited, state shared between tests, off-by-one
at boundaries, encoding or line endings, time zones.

## 4. Fix the cause

- Change the code that is wrong, not the place where the error surfaced, unless they are the same.
- Keep the fix as small as the cause. If a broader cleanup is tempting, mention it instead.
- Add or update a test that fails without the fix and passes with it, when the project has tests.

## 5. Prove it

- Run your reproduction: it must pass now. Run the related test suite: nothing else may break.
- Remove temporary logging.

## Report

- **Cause:** one or two sentences, with the file and line.
- **Fix:** what changed and why that addresses the cause.
- **Proof:** the commands you ran and their results.
- Anything still uncertain, and how to confirm it.
