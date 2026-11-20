import type { Config } from '../config/schema.js';
import { ContainerSandbox } from './container.js';
import { GuardSandbox, OffSandbox } from './guard.js';
import type { Sandbox } from './types.js';

export type { Sandbox } from './types.js';
export { SandboxError } from './types.js';

/** `readOnlyPaths`: folders the file tools may read but never write (where long tool outputs are saved). */
export function createSandbox(config: Config, cwd: string, readOnlyPaths: string[] = []): Sandbox {
  const { mode, allowPaths, denyPaths, container } = config.sandbox;
  if (mode === 'off') return new OffSandbox(cwd);
  if (mode === 'container') {
    const sb = new ContainerSandbox(cwd, container, { allowPaths, denyPaths, readOnlyPaths });
    sb.assertAvailable();
    return sb;
  }
  return new GuardSandbox({ cwd, allowPaths, denyPaths, readOnlyPaths });
}
