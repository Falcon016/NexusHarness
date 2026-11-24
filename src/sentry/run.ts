import { execFile } from 'node:child_process';

/**
 * How sentry runs a program: by path and arguments, never through a shell, with a time limit. Its checks and
 * shields only ever run fixed commands with values it has checked; nothing the model writes is run as a
 * command line. Tests replace this with a fake.
 */
export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** The program is not installed. */
  missing?: boolean;
}

export type Run = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; sudo?: boolean; input?: string },
) => Promise<RunResult>;

export const run: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    // `sudo -n`: never waits for a password. Without passwordless sudo for this command it fails, and the
    // shield says how to run it yourself.
    const [file, argv] = opts.sudo ? ['sudo', ['-n', cmd, ...args]] : [cmd, args];
    const child = execFile(
      file,
      argv,
      {
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolve({
          ok: !e,
          stdout: String(stdout),
          stderr: String(stderr),
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          ...(e?.code === 'ENOENT' ? { missing: true } : {}),
        });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
