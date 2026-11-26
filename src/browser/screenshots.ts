import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageData } from '../llm/types.js';

/**
 * Where browser_screenshot saves its pictures: one fixed folder, named in the tool's result and in the system
 * prompt, so the model never has to search for a screenshot. It is inside the temporary folder the sandbox
 * already lets the file tools use, so the model can read or copy one; only the newest KEEP are kept.
 */
export const SCREENSHOT_DIR = join(tmpdir(), 'nexusharness', 'screenshots');
const KEEP = 50;

let counter = 0;

/** Save a screenshot and return its path. */
export function saveScreenshot(image: ImageData, dir = SCREENSHOT_DIR, now = new Date()): string {
  // Only this user can read it: on a shared machine the temporary folder is shared.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
  const path = join(dir, `screenshot-${stamp}-${String(++counter % 1000).padStart(3, '0')}.${ext}`);
  writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600 });
  prune(dir);
  return path;
}

/** Keep the newest KEEP screenshots. */
function prune(dir: string): void {
  try {
    const shots = readdirSync(dir)
      .filter((f) => /^screenshot-.*\.(jpg|png)$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const s of shots.slice(KEEP)) rmSync(join(dir, s.f), { force: true });
  } catch {
    /* best effort */
  }
}
