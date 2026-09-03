/**
 * Run-scoped state produced by global setup and consumed by specs: the
 * provisioned e2e users and the ids of the seeded fixture memories.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { E2EUser } from './users.js';

const runtimeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.runtime'
);
const statePath = join(runtimeDir, 'seed-state.json');

export interface SeedState {
  userA: E2EUser;
  userB: E2EUser;
  /** memory id per fixture content, as returned (or deduplicated) by remember. */
  fixtureMemoryIds: Record<string, string>;
  /** id of the RLS-private memory owned by user A. */
  rlsPrivateMemoryId: string;
}

export const writeSeedState = async (state: SeedState): Promise<void> => {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
};

export const readSeedState = async (): Promise<SeedState> => {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as SeedState;
  } catch (error) {
    throw new Error(
      `Missing ${statePath} — global setup did not run or failed`,
      { cause: error }
    );
  }
};
