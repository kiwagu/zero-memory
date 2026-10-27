import { spawnSync } from 'node:child_process';

/** How long one git read may take unless its caller has less time left. */
export const GIT_TIMEOUT_MS = 2000;

/**
 * One git read for the hook commands: trimmed stdout, or null when git fails,
 * is missing, or prints nothing. Bounded, because a hook must never hang the
 * turn it runs in; with no time left it does not run at all.
 */
export const runGit = (
  cwd: string,
  args: readonly string[],
  timeoutMs: number = GIT_TIMEOUT_MS
): string | null => {
  // `timeout: 0` would mean no deadline at all.
  if (timeoutMs <= 0) return null;
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};
