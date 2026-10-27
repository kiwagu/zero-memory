import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

/** Sets or clears an environment variable. */
export const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

/** Runs `body` with `name=value` in the environment, restored afterwards. */
export const withEnv = async <T>(
  name: string,
  value: string,
  body: () => Promise<T>
): Promise<T> => {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    restoreEnv(name, previous);
  }
};

/**
 * A fresh state home (XDG_STATE_HOME, where every hook keeps its state) and a
 * fresh working directory for each test of the enclosing suite, both removed
 * afterwards. The directories are named `<prefix>-state-*` / `<prefix>-work-*`,
 * so a test whose output quotes the work directory's name sees the same length
 * on every machine.
 */
export const useStateDirs = (
  prefix: string
): { readonly state: string; readonly work: string } => {
  const dirs = { state: '', work: '' };
  let previous: string | undefined;
  beforeEach(() => {
    dirs.state = mkdtempSync(join(tmpdir(), `${prefix}-state-`));
    dirs.work = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
    previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dirs.state;
  });
  afterEach(() => {
    restoreEnv('XDG_STATE_HOME', previous);
    rmSync(dirs.state, { recursive: true, force: true });
    rmSync(dirs.work, { recursive: true, force: true });
  });
  return dirs;
};
