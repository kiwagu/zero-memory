/**
 * Shared marker for the merge → durable-status sync loop.
 *
 * A merge/promote writes the marker; the session that syncs durable status
 * (planning/roadmap docs, the feature's decision-record status line, the
 * memory server) deletes it afterwards. While the marker exists, the
 * session-start check keeps re-surfacing it, so an ignored one-shot reminder
 * can no longer silently expire — the nag persists until someone confirms
 * the sync.
 *
 * The marker lives in the repo's COMMON git dir (worktree-safe: a promote
 * that fast-forwards a worktree flags the same file the main checkout sees).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MergeSyncMarker {
  detected_at: string;
  source: string;
}

/** Absolute marker path inside the repo's common git dir, or null outside a repo. */
export const markerPath = (): string | null => {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
    if (!commonDir) return null;
    return resolve(commonDir, 'zm-merge-sync-pending');
  } catch {
    return null;
  }
};

/** Flags a merge/promote as awaiting its durable-status sync. */
export const writeMarker = (source: string): string | null => {
  const path = markerPath();
  if (!path) return null;
  const marker: MergeSyncMarker = {
    detected_at: new Date().toISOString(),
    source,
  };
  try {
    writeFileSync(path, `${JSON.stringify(marker)}\n`);
    return path;
  } catch {
    return null;
  }
};

/** Returns the pending marker when one exists (tolerating a corrupt file). */
export const readMarker = (): {
  path: string;
  marker: MergeSyncMarker;
} | null => {
  const path = markerPath();
  if (!path || !existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as MergeSyncMarker;
    return { path, marker };
  } catch {
    return { path, marker: { detected_at: 'unknown', source: 'unknown' } };
  }
};
