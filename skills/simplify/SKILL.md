---
name: simplify
description: Go back over code that was just written or changed and make it simpler, reuse what the codebase already has, and remove waste, without changing behaviour. Use after finishing a feature or fix, or when asked to clean up, simplify or tidy recent changes.
---

The goal is less code that does the same thing, and code that fits the codebase. Behaviour must not change: the
tests that passed before must pass after.

## 1. Find the change

```sh
git status --short
git diff            # and git diff --cached
```

If the work is already committed, compare against where it started (`git diff <base>...HEAD`). Only touch code
in this change, plus code it duplicates.

## 2. Run the checks first

Run the project's tests, linter and type checker now, so you know the starting point. If something already fails,
note it; don't fix unrelated failures silently.

## 3. Look for, in this order

1. **Reuse.** Does the codebase already have a helper, utility, component or library function for what the new
   code does by hand? Search for it (`grep` for similar names and patterns). Replace hand-rolled code with it.
2. **Duplication inside the change.** The same few lines in two places: one function, or a loop.
3. **Dead weight.** Unused variables, imports, parameters, branches that cannot run, commented-out code, debug
   output, defensive checks for things the types already rule out.
4. **Over-engineering.** An interface with one implementation, a config option nothing sets, a wrapper that only
   forwards, layers added "for later". Inline them.
5. **Clarity.** Deep nesting that early returns would flatten, a long function that is really two, names that
   say what but not why, a comment that restates the code.
6. **Efficiency.** Work repeated in a loop that could happen once, a lookup in a list that should be a map, a
   file or network call made twice, loading everything when only a part is needed.

Leave alone: style the formatter handles, working code outside the change, and anything where "simpler" is just
taste.

## 4. Change, then prove nothing broke

- One kind of change at a time; run the tests after each step that touches logic.
- Keep each edit small and use `edit`, not rewrites, so the diff stays reviewable.
- Run the full checks at the end.

## Report

List what you simplified (file and what changed, in a line each), what you looked at and left alone on purpose,
and the check results before and after.
