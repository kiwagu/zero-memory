import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { parseTranscript } from '@workspace/client-adapter-claude';
import { formatEntries } from '@workspace/client-core';
import { ingestAllowed, OffsetState } from '@workspace/client-runtime';
import type { IngestConversationInput } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';

import { ConversationChunker, type Chunk } from './chunker.js';
import { resolveProjectHint } from './project-hint-resolver.js';
import { runWithRunId } from './run-context.js';

export interface TranscriptWatcherOptions {
  /** Root holding per-project transcript dirs (…/projects/<dir>/<id>.jsonl). */
  watchDir: string;
  sendChunk: (input: IngestConversationInput) => Promise<void>;
  state?: OffsetState;
  chunkChars?: number;
  idleMs?: number;
  scanIntervalMs?: number;
  client?: string;
}

const DEFAULT_CHUNK_CHARS = 16_000;
const DEFAULT_OVERLAP_CHARS = 1_500;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const IDLE_SWEEP_INTERVAL_MS = 5_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export const resolveChunkChars = (): number => {
  const raw = Number(process.env.ZM_WATCH_CHUNK_CHARS ?? DEFAULT_CHUNK_CHARS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_CHUNK_CHARS;
};

/**
 * Overlap carried between consecutive size-flushed chunks so a fact split by
 * the cut is seen whole in the next chunk. Non-negative; 0 disables.
 */
export const resolveOverlapChars = (): number => {
  const raw = Number(
    process.env.ZM_WATCH_CHUNK_OVERLAP_CHARS ?? DEFAULT_OVERLAP_CHARS
  );
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_OVERLAP_CHARS;
};

/**
 * Best-effort reverse of the transcript directory naming, where the project
 * path is flattened with `-` (lossy: hyphens inside real path segments are
 * indistinguishable). Only used when no `cwd` was found on the lines.
 */
export const decodeProjectDir = (dirName: string): string | undefined => {
  if (!dirName.startsWith('-')) {
    return undefined;
  }
  return dirName.replace(/-/g, '/');
};

/**
 * Tails coding-agent transcript files (JSONL) below `watchDir`: new bytes
 * are parsed (user/assistant text only), accumulated per conversation, and
 * flushed as hashed chunks to the ingest endpoint — on size (chunkChars) or
 * after an idle period. Byte offsets persist across restarts; a down server
 * only grows the retry queue, it never crashes the process.
 */
export class TranscriptWatcher {
  readonly #logger = createLogger(TranscriptWatcher.name);
  readonly #options: Required<Omit<TranscriptWatcherOptions, 'state'>>;
  readonly #state: OffsetState;
  readonly #chunker: ConversationChunker;
  readonly #projectHints = new Map<string, string>();
  readonly #sendQueue: Chunk[] = [];
  #watcher: FSWatcher | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  #scanning = false;
  #sending = false;
  #backoffMs = BACKOFF_BASE_MS;
  #stopped = false;

  constructor(options: TranscriptWatcherOptions) {
    this.#options = {
      chunkChars: resolveChunkChars(),
      idleMs: DEFAULT_IDLE_MS,
      scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS,
      client: 'zero-memory-watcher',
      ...options,
    };
    this.#state = options.state ?? new OffsetState();
    this.#chunker = new ConversationChunker({
      maxChars: this.#options.chunkChars,
      idleMs: this.#options.idleMs,
      overlapChars: resolveOverlapChars(),
    });
  }

  async start(): Promise<void> {
    await this.#scan();

    try {
      this.#watcher = watch(
        this.#options.watchDir,
        { recursive: true },
        () => void this.#scan()
      );
    } catch (error) {
      this.#logger.warn('fs.watch unavailable, relying on periodic scans', {
        error: String(error),
      });
    }

    this.#timers = [
      setInterval(() => void this.#scan(), this.#options.scanIntervalMs),
      setInterval(() => this.#sweepIdle(), IDLE_SWEEP_INTERVAL_MS),
    ];
    this.#logger.info('watching transcripts', {
      watchDir: this.#options.watchDir,
      chunkChars: this.#options.chunkChars,
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#watcher?.close();
    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    this.#enqueue(this.#chunker.flushAll());
    await this.#drainQueue();
  }

  async #scan(): Promise<void> {
    if (this.#scanning || this.#stopped) {
      return;
    }
    this.#scanning = true;
    try {
      // One run id per scan pass groups the reads/flushes it triggers.
      await runWithRunId(async () => {
        try {
          for (const filePath of await this.#listTranscripts()) {
            await this.#readNewBytes(filePath);
          }
        } catch (error) {
          this.#logger.warn('scan failed', { error: String(error) });
        }
      });
    } finally {
      this.#scanning = false;
      void this.#drainQueue();
    }
  }

  async #listTranscripts(): Promise<string[]> {
    const entries = await readdir(this.#options.watchDir, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(entry.parentPath, entry.name));
  }

  async #readNewBytes(filePath: string): Promise<void> {
    const offset = this.#state.get(filePath);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size <= offset) {
      return;
    }

    const handle = await open(filePath, 'r');
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(info.size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
    } finally {
      await handle.close();
    }

    // Only complete lines: a torn tail line is re-read on the next scan.
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return;
    }
    const slice = buffer.subarray(0, lastNewline + 1);
    this.#state.set(filePath, offset + slice.length);

    const conversationId = basename(filePath, '.jsonl');
    const parsed = parseTranscript(slice.toString('utf8'));
    // Resolve the raw cwd to the enclosing git repo so a session run in a
    // subdirectory routes to the one project, not a phantom named after the
    // leaf directory (a nested checkout resolves to its host project, not to a
    // project named after its own folder). Falls back to the raw path for
    // non-git directories.
    const rawHint =
      parsed.cwd ??
      this.#projectHints.get(conversationId) ??
      decodeProjectDir(basename(dirname(filePath)));
    const hint = rawHint ? resolveProjectHint(rawHint) : rawHint;
    if (hint) {
      this.#projectHints.set(conversationId, hint);
    }
    if (parsed.entries.length === 0) {
      return;
    }
    // Consent gate — parity with the Stop-hook path: a watch-mode daemon (e.g.
    // on a remote client) must not ship an unconsented project's transcript.
    // `.zero-memory-ignore` / ingest.json decide uniformly; without a resolvable
    // project it fails closed. The offset has already advanced, so a skipped
    // delta is not re-scanned (set consent before running the daemon).
    const consent = hint
      ? ingestAllowed(hint)
      : { allowed: false, reason: 'no-project-hint' };
    if (!consent.allowed) {
      this.#logger.debug('skip chunk (consent)', {
        conversationId,
        reason: consent.reason,
      });
      return;
    }
    this.#enqueue(
      this.#chunker.append(
        conversationId,
        formatEntries(parsed.entries),
        parsed.recalledIds,
        hint
      )
    );
  }

  #sweepIdle(): void {
    this.#enqueue(this.#chunker.flushIdle());
    void this.#drainQueue();
  }

  #enqueue(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      this.#sendQueue.push(chunk);
    }
  }

  async #drainQueue(): Promise<void> {
    if (this.#sending) {
      return;
    }
    this.#sending = true;
    try {
      while (this.#sendQueue.length > 0) {
        const chunk = this.#sendQueue[0]!;
        try {
          await this.#options.sendChunk({
            transcript_chunk: chunk.text,
            chunk_hash: chunk.hash,
            client: this.#options.client,
            conversation_id: chunk.conversationId,
            ...(chunk.projectHint ? { project_hint: chunk.projectHint } : {}),
            ...(chunk.recalledIds.length
              ? { recalled_ids: chunk.recalledIds }
              : {}),
          });
          this.#sendQueue.shift();
          this.#backoffMs = BACKOFF_BASE_MS;
        } catch (error) {
          // While stopping, the connection is being torn down — a failed flush
          // is expected (e.g. "Connection closed"), and the un-acked chunk is
          // re-read on the next run, so exit quietly: no warn, no backoff wait.
          if (this.#stopped) {
            break;
          }
          // Server down or rejecting: keep the chunk, back off, no crash.
          this.#logger.warn('send failed, backing off', {
            backoffMs: this.#backoffMs,
            queued: this.#sendQueue.length,
            error: String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, this.#backoffMs));
          this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
        }
      }
    } finally {
      this.#sending = false;
    }
  }
}
