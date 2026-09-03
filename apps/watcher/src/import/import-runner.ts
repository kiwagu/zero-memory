import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import type { ImportMemoryInput } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';

import { E2E_SERVER_URL } from '@workspace/client-runtime';
import { SOURCE_ADAPTERS } from './adapter-registry.js';
import { ImportClient } from '@workspace/client-runtime';
import type { ImportItem, MemorySourceAdapter } from './source-adapter.js';

const logger = createLogger('import-runner');

export interface ImportOptions {
  /** Discover + print only, never write. */
  dryRun: boolean;
  /**
   * Trigger the server-side hygiene scan after an import that landed new
   * memories (default true; `--no-scan` opts out). The scan judges
   * import↔existing near-duplicate pairs into the review queue.
   */
  scan?: boolean;
  homeDir: string;
  cwd: string;
  /** Forces the project hint for every project-scoped item. */
  projectHintOverride?: string;
  /** MCP endpoint override (else ZM_SERVER_URL / default). */
  serverUrl?: string;
  /** Adapter set override — tests inject a stub; defaults to the registry. */
  adapters?: readonly MemorySourceAdapter[];
  /** Import client override — tests inject a fake; defaults to a real one. */
  client?: ImportClientLike;
}

/** The slice of ImportClient the runner needs (so tests can fake it). */
export interface ImportClientLike {
  importMemory(
    input: ImportMemoryInput
  ): Promise<{ skipped: boolean; deduplicated?: boolean; memory_id?: string }>;
  scanHygiene(): Promise<{ started: boolean; reason?: string }>;
  close(): Promise<void>;
}

export interface ImportTally {
  discovered: number;
  imported: number;
  deduplicated: number;
  skipped: number;
  failed: number;
  /** True when the run stopped early on a consecutive-failure streak. */
  aborted: boolean;
}

/**
 * Circuit breaker: a streak of consecutive failures (an unreachable or
 * unauthenticated server fails every item the same way) aborts the run instead
 * of grinding through the whole discovery list. Isolated bad items don't trip
 * it — any success/skip resets the streak.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Idempotency key: stable across runs for the same (tool, source, content).
 * Content is included so an edited source re-imports as a fresh fact and two
 * distinct sections of one file never collide.
 */
const sourceHash = (
  tool: string,
  sourcePath: string,
  content: string
): string =>
  createHash('sha256')
    .update(`${tool}\0${sourcePath}\0${content}`)
    .digest('hex');

const toInput = (
  adapter: MemorySourceAdapter,
  item: ImportItem
): ImportMemoryInput => ({
  content: item.content,
  kind: item.kind,
  target: item.target,
  ...(item.projectHint ? { project_hint: item.projectHint } : {}),
  source_tool: adapter.tool,
  source_path: item.sourcePath,
  source_hash: sourceHash(adapter.tool, item.sourcePath, item.content),
  ...(item.verbatim ? { verbatim: item.verbatim } : {}),
});

/** Parses `import` subcommand flags from `process.argv.slice(3)`. */
export const parseImportArgs = (argv: string[]): ImportOptions => {
  const options: ImportOptions = {
    dryRun: false,
    homeDir: homedir(),
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--home':
        options.homeDir = requireValue(argv, (i += 1), arg);
        break;
      case '--cwd':
        options.cwd = requireValue(argv, (i += 1), arg);
        break;
      case '--project':
        options.projectHintOverride = requireValue(argv, (i += 1), arg);
        break;
      case '--server':
        options.serverUrl = requireValue(argv, (i += 1), arg);
        break;
      case '--e2e':
        // Sandbox mode: target the local e2e stack (disposable DB) instead of
        // the real server. Equivalent to --server with the e2e endpoint; the
        // last of --e2e/--server wins.
        options.serverUrl = E2E_SERVER_URL;
        break;
      case '--no-scan':
        options.scan = false;
        break;
      default:
        throw new Error(`Unknown import flag: ${arg}`);
    }
  }
  return options;
};

const requireValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
};

/**
 * Discovers native memories from every registered adapter and imports each via
 * the server's idempotent `import_memory` tool. Returns a tally; a per-item
 * failure is counted and logged, never fatal (one bad file must not abort the
 * whole import).
 */
export const runImport = async (
  options: ImportOptions
): Promise<ImportTally> => {
  const tally: ImportTally = {
    discovered: 0,
    imported: 0,
    deduplicated: 0,
    skipped: 0,
    failed: 0,
    aborted: false,
  };
  const adapters = options.adapters ?? SOURCE_ADAPTERS;
  const client: ImportClientLike | null = options.dryRun
    ? null
    : (options.client ?? new ImportClient(options.serverUrl));
  let consecutiveFailures = 0;

  try {
    for (const adapter of adapters) {
      if (tally.aborted) {
        break;
      }
      const items = await adapter.discover({
        homeDir: options.homeDir,
        cwd: options.cwd,
        ...(options.projectHintOverride
          ? { projectHintOverride: options.projectHintOverride }
          : {}),
      });
      tally.discovered += items.length;
      process.stdout.write(`${adapter.label}: ${items.length} item(s)\n`);

      for (const item of items) {
        const input = toInput(adapter, item);
        if (options.dryRun || !client) {
          process.stdout.write(
            `  [dry-run] ${input.target} ${input.kind} <- ${item.sourcePath}\n`
          );
          continue;
        }
        try {
          const output = await client.importMemory(input);
          if (output.skipped) {
            tally.skipped += 1;
          } else if (output.deduplicated) {
            tally.deduplicated += 1;
          } else {
            tally.imported += 1;
          }
          consecutiveFailures = 0;
        } catch (error) {
          tally.failed += 1;
          consecutiveFailures += 1;
          logger.error('import failed', {
            sourcePath: item.sourcePath,
            error: String(error),
          });
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            tally.aborted = true;
            process.stdout.write(
              `Aborting: ${consecutiveFailures} consecutive failures — ` +
                `the server looks unreachable or unauthenticated. Fix the ` +
                `cause and re-run (already-imported items are no-ops).\n`
            );
            break;
          }
        }
      }
    }
    // Imports are authoritative writes: the cosine gate deliberately does NOT
    // swallow near-duplicates of existing memories, so a post-import hygiene
    // scan is what queues those pairs for review. Fire it automatically when
    // the run landed anything new; failure is non-fatal (scan is re-runnable).
    const shouldScan =
      (options.scan ?? true) &&
      client !== null &&
      !tally.aborted &&
      tally.imported > 0;
    if (shouldScan) {
      try {
        const scan = await client.scanHygiene();
        process.stdout.write(
          scan.started
            ? 'Hygiene scan started (review pairs at /review or via list_conflicts).\n'
            : `Hygiene scan not started: ${scan.reason ?? 'already running'}.\n`
        );
      } catch (error) {
        logger.warn('post-import hygiene scan failed', {
          error: String(error),
        });
      }
    }
  } finally {
    await client?.close();
  }

  process.stdout.write(
    `\nImport ${options.dryRun ? '(dry-run) ' : ''}` +
      `${tally.aborted ? 'ABORTED' : 'complete'}: ` +
      `${tally.discovered} discovered, ${tally.imported} imported, ` +
      `${tally.deduplicated} deduplicated, ${tally.skipped} already-imported, ` +
      `${tally.failed} failed\n`
  );
  return tally;
};
