import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

import {
  BOOTSTRAP_CLIENT,
  type IngestConversationInput,
  type IngestConversationOutput,
} from '@workspace/contracts';
import { createLogger } from '@workspace/logger';

import { E2E_SERVER_URL, IngestClient } from '@workspace/client-runtime';
import {
  DEFAULT_HISTORY_DEPTH,
  collectDocChunks,
  collectHistoryChunks,
  type BootstrapChunk,
} from './repo-source.js';

const logger = createLogger('bootstrap-runner');

export interface BootstrapOptions {
  /** Repository to bootstrap from (default: cwd). */
  repoDir: string;
  /** Discover + print only, never send. */
  dryRun: boolean;
  /** `git log` depth for the history source. */
  depth: number;
  /** Restrict to one source; default runs both. */
  only?: 'docs' | 'history';
  /** Globs (`*` = any chars) matched against a chunk's source path AND its
   * basename; a match drops the chunk before any tokens are spent. */
  exclude?: string[];
  /** Print usage and do nothing else. */
  help?: boolean;
  /** Forces the project hint (default: the repo dir). */
  projectHintOverride?: string;
  /** MCP endpoint override (else ZM_SERVER_URL / default). */
  serverUrl?: string;
  /** Ingest client override — tests inject a fake; defaults to a real one. */
  client?: BootstrapClientLike;
}

/** The slice of IngestClient the runner needs (so tests can fake it). */
export interface BootstrapClientLike {
  sendChunk(input: IngestConversationInput): Promise<IngestConversationOutput>;
  close(): Promise<void>;
}

export interface BootstrapTally {
  chunks: number;
  sent: number;
  duplicates: number;
  memoriesCreated: number;
  failed: number;
  /** True when the run stopped early on a consecutive-failure streak. */
  aborted: boolean;
}

/**
 * Circuit breaker: a streak of consecutive failures (an unreachable or
 * unauthenticated server fails every chunk the same way) aborts the run
 * instead of burning the whole discovery list — with the LLM path each chunk
 * is also an extraction call paid for. Any success resets the streak.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Parses `bootstrap` subcommand flags from `process.argv.slice(3)`. */
export const parseBootstrapArgs = (argv: string[]): BootstrapOptions => {
  const options: BootstrapOptions = {
    repoDir: process.cwd(),
    dryRun: false,
    depth: DEFAULT_HISTORY_DEPTH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--repo':
        options.repoDir = resolve(requireValue(argv, (i += 1), arg));
        break;
      case '--depth': {
        const value = Number(requireValue(argv, (i += 1), arg));
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error('--depth requires a positive integer.');
        }
        options.depth = value;
        break;
      }
      case '--docs-only':
        options.only = 'docs';
        break;
      case '--history-only':
        options.only = 'history';
        break;
      case '--project':
        options.projectHintOverride = requireValue(argv, (i += 1), arg);
        break;
      case '--server':
        options.serverUrl = requireValue(argv, (i += 1), arg);
        break;
      case '--exclude':
        options.exclude = requireValue(argv, (i += 1), arg)
          .split(',')
          .map((glob) => glob.trim())
          .filter((glob) => glob.length > 0);
        break;
      case '--e2e':
        // Sandbox mode: target the local e2e stack (disposable DB) instead of
        // the real server. Equivalent to --server with the e2e endpoint; the
        // last of --e2e/--server wins.
        options.serverUrl = E2E_SERVER_URL;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        // A bare token is the repo path (so `bootstrap ./some/repo` works);
        // only dash-prefixed tokens can be unknown flags.
        if (arg !== undefined && !arg.startsWith('-')) {
          options.repoDir = resolve(arg);
          break;
        }
        throw new Error(`Unknown bootstrap flag: ${arg}\n\n${BOOTSTRAP_USAGE}`);
    }
  }
  return options;
};

/** Usage for the `bootstrap` subcommand (`--help`, and on an unknown flag). */
export const BOOTSTRAP_USAGE = `usage: zero-memory-watcher bootstrap [repo-dir] [options]

One-shot LLM bootstrap from a repository: README/docs pages and the git history
are chunked and fed through the server's extraction pipeline. Idempotent per
chunk content hash — a re-run only processes what changed.

  [repo-dir]            repository to read (default: current directory)
  --repo <dir>          same as the positional argument
  --dry-run             preview only: prints how many chunks are NEW vs
                        already-processed (asks the server's ledger), never writes
  --exclude <globs>     comma-separated globs to drop sources before they cost
                        tokens, matched on the source path AND its basename
                        (e.g. --exclude 'docs/diagrams/*,*-ja.md')
  --docs-only           only README/docs pages
  --history-only        only the git history
  --depth <n>           git log depth for the history source (default ${DEFAULT_HISTORY_DEPTH})
  --project <hint>      override the project hint (default: the repo dir)
  --server <url>        MCP endpoint override
  --e2e                 target the local e2e sandbox instead of the real server
  -h, --help            print this help`;

const requireValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
};

/** A single glob (`*` = any chars) matched against the full source path AND its
 * basename, so `--exclude '*-ja.md'` works without spelling the directory. */
const globMatches = (path: string, pattern: string): boolean => {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
  );
  return re.test(path) || re.test(basename(path));
};

/** Drops chunks whose source path matches any `--exclude` glob. */
const applyExcludes = (
  chunks: BootstrapChunk[],
  patterns: string[] | undefined
): { kept: BootstrapChunk[]; excluded: number } => {
  if (!patterns || patterns.length === 0) {
    return { kept: chunks, excluded: 0 };
  }
  const kept = chunks.filter(
    (chunk) =>
      !patterns.some((pattern) => globMatches(chunk.sourcePath, pattern))
  );
  return { kept, excluded: chunks.length - kept.length };
};

const toInput = (
  chunk: BootstrapChunk,
  options: BootstrapOptions
): IngestConversationInput => ({
  transcript_chunk: chunk.content,
  chunk_hash: createHash('sha256')
    .update(`${chunk.sourceKind}\0${chunk.sourcePath}\0${chunk.content}`)
    .digest('hex'),
  client: BOOTSTRAP_CLIENT,
  conversation_id: `bootstrap:${options.repoDir}:${chunk.sourcePath}`,
  project_hint: options.projectHintOverride ?? options.repoDir,
  source_kind: chunk.sourceKind,
  source_path: chunk.sourcePath,
});

/**
 * One-shot LLM bootstrap from a repository: README/docs pages and the git
 * history are chunked and fed through the server's extraction pipeline
 * (`ingest_conversation` with a bootstrap source kind). Idempotent per chunk
 * content hash — a re-run only processes what changed. A per-chunk failure is
 * counted and logged, never fatal; a failure STREAK aborts (circuit breaker).
 */
export const runBootstrap = async (
  options: BootstrapOptions
): Promise<BootstrapTally> => {
  const tally: BootstrapTally = {
    chunks: 0,
    sent: 0,
    duplicates: 0,
    memoriesCreated: 0,
    failed: 0,
    aborted: false,
  };
  if (options.help) {
    process.stdout.write(`${BOOTSTRAP_USAGE}\n`);
    return tally;
  }
  const discovered: BootstrapChunk[] = [
    ...(options.only === 'history' ? [] : collectDocChunks(options.repoDir)),
    ...(options.only === 'docs'
      ? []
      : collectHistoryChunks(options.repoDir, options.depth)),
  ];
  // Excluding BEFORE any server call is the point: a dropped source never
  // costs an extraction call. Report the count — a silently shrunk source list
  // reads as "covered everything" when it did not.
  const { kept: chunks, excluded } = applyExcludes(discovered, options.exclude);
  tally.chunks = chunks.length;
  process.stdout.write(
    `Bootstrap sources: ${chunks.length} chunk(s) from ${options.repoDir}` +
      (excluded > 0 ? ` (${excluded} excluded by --exclude)` : '') +
      '\n'
  );

  // A dry run needs the server too: the only honest answer to "what will this
  // cost" comes from the ledger the real run consults.
  const client: BootstrapClientLike =
    options.client ?? new IngestClient(options.serverUrl);
  let consecutiveFailures = 0;
  // Flips off once probing has failed enough times to call the ledger down —
  // the preview then degrades to a plain listing instead of dying.
  let ledgerAvailable = true;

  try {
    for (const chunk of chunks) {
      const input = toInput(chunk, options);
      if (options.dryRun) {
        let verdict = 'unknown';
        if (ledgerAvailable) {
          try {
            // probe = ledger lookup only: it never claims the hash, so the
            // real run right after still processes everything it reports NEW.
            // The content is left out — the verdict is keyed by hash alone.
            const probed = await client.sendChunk({
              ...input,
              transcript_chunk: '',
              probe: true,
            });
            verdict = probed.duplicate ? 'already ingested' : 'NEW';
            if (probed.duplicate) tally.duplicates += 1;
            consecutiveFailures = 0;
          } catch (error) {
            tally.failed += 1;
            consecutiveFailures += 1;
            logger.debug('bootstrap probe failed', {
              sourcePath: chunk.sourcePath,
              error: String(error),
            });
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              ledgerAvailable = false;
              process.stdout.write(
                `  ! ledger unreachable — the rest is listed without a ` +
                  `new/already-ingested verdict\n`
              );
            }
          }
        }
        process.stdout.write(
          `  [${verdict}] ${chunk.sourceKind} <- ${chunk.sourcePath} ` +
            `(${chunk.content.length} chars)\n`
        );
        continue;
      }
      try {
        const output = await client.sendChunk(input);
        if (output.duplicate) {
          tally.duplicates += 1;
        } else {
          tally.sent += 1;
          tally.memoriesCreated += output.memories_created;
        }
        consecutiveFailures = 0;
      } catch (error) {
        tally.failed += 1;
        consecutiveFailures += 1;
        logger.error('bootstrap chunk failed', {
          sourcePath: chunk.sourcePath,
          error: String(error),
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          tally.aborted = true;
          process.stdout.write(
            `Aborting: ${consecutiveFailures} consecutive failures — the ` +
              `server looks unreachable or unauthenticated. Fix the cause ` +
              `and re-run (already-processed chunks are no-ops).\n`
          );
          break;
        }
      }
    }
  } finally {
    await client.close();
  }

  if (options.dryRun) {
    // The number the user actually needs before spending anything: how many
    // chunks a real run would extract. `failed` here means "the ledger did
    // not answer", so those are counted as unknown, never silently as new.
    const fresh = tally.chunks - tally.duplicates - tally.failed;
    process.stdout.write(
      `\nBootstrap (dry-run): ${tally.chunks} chunk(s), ` +
        `${tally.duplicates} already ingested, ${fresh} NEW` +
        (tally.failed > 0 ? `, ${tally.failed} unknown (ledger down)` : '') +
        `\nA real run would spend ${fresh}` +
        (tally.failed > 0 ? `-${fresh + tally.failed}` : '') +
        ` extraction call(s).\n`
    );
    return tally;
  }

  process.stdout.write(
    `\nBootstrap ${tally.aborted ? 'ABORTED' : 'complete'}: ` +
      `${tally.chunks} chunk(s), ${tally.sent} processed, ` +
      `${tally.memoriesCreated} memories created, ` +
      `${tally.duplicates} already-processed, ${tally.failed} failed\n`
  );
  return tally;
};
