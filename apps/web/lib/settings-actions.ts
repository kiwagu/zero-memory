'use server';

import { createHash } from 'node:crypto';

import { importMemoryViaServer, type ImportTarget } from './mcp';
import { parseMemoryFile } from './markdown-memory';
import { MEMORY_KINDS } from './memory';
import { createServerSupabaseClient } from './supabase/server';

/** A dropped file to re-import: its name and full Markdown text. */
export interface DroppedFile {
  path: string;
  content: string;
}

/** Per-file outcome, aggregated into the summary the UI renders. */
export interface ImportSummary {
  ok: boolean;
  /** Newly written memories. */
  imported: number;
  /** No-ops: the same `source_hash` (or content) already present. */
  unchanged: number;
  /** Files that could not be imported, with a human reason. */
  failed: { path: string; error: string }[];
  total: number;
  /** A whole-run failure (e.g. not signed in) that stopped everything. */
  error?: string;
}

/**
 * Maps an exported memory's scope back to the `import_memory` target the server
 * resolves against. Deliberately strict: an unrecognized scope is a per-file
 * error rather than a silent personal-scope dump, so a malformed drop is
 * visible instead of quietly landing memories in the wrong place.
 */
function scopeToTarget(
  scope: string
): { target: ImportTarget; projectHint?: string } | null {
  if (scope.startsWith('user.') && scope.endsWith('.core')) {
    return { target: 'core' };
  }
  if (scope.startsWith('user.')) {
    return { target: 'personal' };
  }
  if (scope.startsWith('proj.')) {
    return { target: 'project', projectHint: scope.slice('proj.'.length) };
  }
  return null;
}

const KNOWN_KINDS = new Set<string>(MEMORY_KINDS);

/**
 * Re-imports dropped Markdown memory files through the server's deterministic
 * `import_memory` path. Runs as the signed-in user (their JWT is the bearer),
 * so RLS gates every write; idempotent per content hash, so re-dropping the
 * same export is a no-op. Round-trips the dashboard's own export format.
 */
export async function importMemories(
  files: DroppedFile[]
): Promise<ImportSummary> {
  const base: ImportSummary = {
    ok: false,
    imported: 0,
    unchanged: 0,
    failed: [],
    total: files.length,
  };

  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return { ...base, error: 'Not signed in.' };
  }

  let imported = 0;
  let unchanged = 0;
  const failed: { path: string; error: string }[] = [];

  for (const file of files) {
    const { frontmatter, content } = parseMemoryFile(file.content);
    const kind = frontmatter.kind;
    const scope = frontmatter.scope;

    if (!content) {
      failed.push({ path: file.path, error: 'Empty memory content.' });
      continue;
    }
    if (!kind || !KNOWN_KINDS.has(kind)) {
      failed.push({ path: file.path, error: `Unknown kind: ${kind ?? '—'}.` });
      continue;
    }
    if (!scope) {
      failed.push({ path: file.path, error: 'Missing scope.' });
      continue;
    }
    const routed = scopeToTarget(scope);
    if (!routed) {
      failed.push({ path: file.path, error: `Unroutable scope: ${scope}.` });
      continue;
    }

    // Idempotency key: the content hash, so a re-drop of an unchanged export
    // is a server-side no-op.
    const sourceHash = createHash('sha256').update(content).digest('hex');

    try {
      const result = await importMemoryViaServer(accessToken, {
        content,
        kind,
        target: routed.target,
        projectHint: routed.projectHint,
        sourcePath: file.path,
        sourceHash,
      });
      // A brand-new write is the only "imported"; an already-present hash
      // (skipped) or an equivalent existing memory (deduplicated) is unchanged.
      if (!result.skipped && !result.deduplicated) {
        imported += 1;
      } else {
        unchanged += 1;
      }
    } catch (error) {
      failed.push({
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: failed.length === 0,
    imported,
    unchanged,
    failed,
    total: files.length,
  };
}
