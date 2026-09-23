import { spawnSync } from 'node:child_process';

/**
 * One git read for the hook commands: trimmed stdout, or null when git fails,
 * is missing, or prints nothing. Bounded, because a hook must never hang the
 * turn it runs in.
 */
export const runGit = (cwd: string, args: readonly string[]): string | null => {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};
