---
name: webapp-testing
description: Test a web app running locally by driving the browser like a user (navigate, click, type, check what the page shows, read console errors), or with Playwright scripts for repeatable checks. Use when asked to test, check or debug a web UI, verify a frontend change, or reproduce a bug in the browser.
---

Check what a user would see, not what the code says should happen. Every result you report should come from a
page you actually loaded.

## 1. Get the app running

- Find how it starts: `package.json` scripts (`dev`, `start`, `preview`), `Makefile`, `docker-compose.yml`,
  README. Note the port.
- If it is not running, start it in the background so the command returns, and log to a file:

  ```sh
  nohup npm run dev > /tmp/devserver.log 2>&1 &
  ```

  On Windows PowerShell: `Start-Process -NoNewWindow npm -ArgumentList 'run','dev' -RedirectStandardOutput devserver.log`.

- Wait until it answers before testing: `curl -s -o /dev/null -w '%{http_code}' http://localhost:<port>` in a
  short loop, or read the log for "ready".
- Note that you started it; stop it when you are done (kill that process, not every node process).

## 2. Drive it with the browser tools

When the `browser_*` tools are available:

1. `browser_navigate` to the page.
2. `browser_snapshot` to read the page: it lists the elements you can act on, with references. Prefer it to
   screenshots; use `browser_screenshot` only when the look matters (layout, colours) and the model can see images.
3. Act with `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`, then snapshot again
   to see the result. Use `browser_wait` for something that loads, not fixed sleeps.
4. Check each expectation explicitly: the text appears, the URL changed, the error message shows, the list has
   the new item.

Cover the path the user asked about, then the obvious edge cases: empty input, wrong input, a reload in the middle,
going back, a narrow window if layout is involved.

## 3. Repeatable checks with Playwright

When the project uses Playwright (or the user wants a test they can rerun), write a test instead of clicking by
hand. Follow the project's existing test folder and style; a minimal one:

```ts
import { test, expect } from '@playwright/test';

test('adds a todo', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  await page.getByPlaceholder('What needs doing?').fill('Buy milk');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listitem')).toHaveText(['Buy milk']);
});
```

Prefer role, label and text locators to CSS selectors. Run with `npx playwright test <file>`.

## 4. When something fails

- Read the dev server log and the browser console (errors there often explain a blank page).
- Find the network request that failed and its response.
- Reproduce with the fewest steps, then load the `debugging` skill if the cause is not obvious.

## Report

For each thing you checked: what you did, what you expected, what happened. Then the failures with the steps
to reproduce them, and anything you could not test.
