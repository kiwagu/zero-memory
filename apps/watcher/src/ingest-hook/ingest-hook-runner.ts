import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { formatEntries } from '@workspace/client-core';
import {
  receiptStatePath,
  recordCapturedMemories,
} from '@workspace/client-runtime';
import { createLogger } from '@workspace/logger';

import { IngestClient } from '@workspace/client-runtime';
import { hookClient, type HookClient, type HookInput } from '../hook-client.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { ingestAllowed } from '@workspace/client-runtime';

// Logs every invocation + outcome (stderr + ZM_LOG_FILE) so the rotating log
// shows the Stop hook firing even when there is nothing new to send.
const logger = createLogger('ingest');

/**
 * Hook-driven ingest: ship the NEW part of the session transcript to
 * ingest_conversation so durable facts are captured automatically. This is the
 * event-driven alternative to the always-on watch daemon — a consumer needs no
 * background service to get auto-capture of their own sessions.
 *
 * Two moments ask for it. End of turn is the ordinary one. A CONTEXT COMPACTION
 * is the other, and there the timing carries the meaning: taken just before the
 * boundary, the delta is exactly the epoch about to be condensed away, and the
 * offset it leaves behind starts the next flush after the boundary rather than
 * across it.
 *
 * Per-transcript byte offsets persist in the state directory, so each flush
 * sends only what was added since the previous one; the server-side chunk hash
 * makes retries idempotent. Auth is OAuth (the same token store as `login`).
 * Never throws — a down memory server must not block the session.
 */
const offsetStatePath = (): string =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'hook-offsets.json'
  );

const loadOffsets = (path: string): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
};

const saveOffsets = (path: string, offsets: Record<string, number>): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(offsets, null, 2));
};

/**
 * The `recalled_ids` half of an ingest payload — the "shown" set the usefulness
 * judge scores a chunk against.
 *
 * Its own function because this is the seam where the judge channel is easiest
 * to lose without noticing: the server gates the judge on the field being
 * present, so an ingest that quietly drops it reports success while measuring
 * nothing. It is omitted rather than sent empty — absent means "this slice
 * surfaced no memories", which is a different claim from "none were useful".
 */
export const recalledIdsField = (
  recalledIds: readonly string[]
): { recalled_ids?: string[] } =>
  recalledIds.length > 0 ? { recalled_ids: [...recalledIds] } : {};

/**
 * Which moment asked for the flush. Both legs ship the same bytes the same
 * way — the reason exists so the log can tell an end-of-turn capture from one
 * taken at a compaction boundary, which is the only way to audit afterwards
 * whether the boundary leg fired at all.
 */
export type FlushReason = 'stop' | 'compaction';
export type FlushOutcome =
  | 'no-transcript'
  | 'no-new-content'
  | 'noise-only'
  | 'failed'
  | `skipped:${string}`
  | `sent:${number},created:${number}`;

/** Ships the transcript delta since the last flush; best-effort, never throws.
 * The `adapter` selects the client (Claude by default, or Cursor via
 * `--client cursor`): its own payload shape, transcript parser, and provenance
 * label. Everything downstream (offsets, consent, hashing, receipt) is shared.
 *
 * Called at end of turn (`Stop`) and again at a compaction boundary, where
 * taking it EARLY is the whole point: the delta then covers exactly the epoch
 * about to be compacted away, and the advanced offset means the next turn's
 * flush starts after the boundary instead of straddling it. */
export const flushTranscriptDelta = async (
  adapter: HookClient = hookClient(),
  reason: FlushReason = 'stop',
  input?: HookInput
): Promise<FlushOutcome> => {
  const client = new IngestClient();
  try {
    // A composed hook (PreCompact) has already consumed stdin to inspect the
    // boundary. Accept that parsed payload so a stream is never read twice.
    const { sessionId, cwd, transcriptPath } =
      input ?? (await adapter.readInput());
    logger.info('ingest hook fired', {
      sessionId,
      reason,
      client: adapter.kind,
    });
    if (!transcriptPath) {
      logger.info('ingest hook done', {
        sessionId,
        reason,
        outcome: 'no-transcript',
      });
      return 'no-transcript';
    }

    // Per-project consent: never send a sensitive/unconsented project's
    // transcript. Default (no config) is `off` — nothing is captured.
    const consent = ingestAllowed(cwd);
    if (!consent.allowed) {
      logger.info('ingest hook done', {
        sessionId,
        reason,
        outcome: `skipped:${consent.reason}`,
      });
      return `skipped:${consent.reason}`;
    }

    const raw = readFileSync(transcriptPath, 'utf8');
    const statePath = offsetStatePath();
    const offsets = loadOffsets(statePath);
    const fresh = raw.slice(offsets[transcriptPath] ?? 0);
    if (fresh.trim().length === 0) {
      logger.info('ingest hook done', {
        sessionId,
        reason,
        outcome: 'no-new-content',
      });
      return 'no-new-content';
    }

    // The client's transcript parser: user/assistant text only, tool traffic
    // and meta lines dropped, rendered as `role: text` lines.
    const parsed = adapter.parse(fresh);
    const chunk = formatEntries(parsed.entries);
    // Even an all-noise delta advances the offset so it is not re-scanned.
    if (chunk.length === 0) {
      offsets[transcriptPath] = raw.length;
      saveOffsets(statePath, offsets);
      logger.info('ingest hook done', {
        sessionId,
        reason,
        outcome: 'noise-only',
      });
      return 'noise-only';
    }

    const response = await client.sendChunk({
      transcript_chunk: chunk,
      chunk_hash: createHash('sha256').update(chunk, 'utf8').digest('hex'),
      client: adapter.ingestProvenance,
      conversation_id: sessionId,
      project_hint: resolveProjectHint(cwd),
      // Without this the judge stays dark for every hook-driven client — only
      // the file-tailing daemon (Claude) used to pass it on.
      ...recalledIdsField(parsed.recalledIds),
    });

    offsets[transcriptPath] = raw.length;
    saveOffsets(statePath, offsets);

    // Feed the session receipt: the ingest RESPONSE is the "captured N"
    // source. Best-effort — receipt state problems must not fail the ingest.
    if (sessionId) {
      try {
        recordCapturedMemories(
          receiptStatePath(),
          sessionId,
          response.memories_created
        );
      } catch {
        // ignore: the receipt degrades to fewer counters, ingest succeeded.
      }
    }

    const outcome =
      `sent:${chunk.length},created:${response.memories_created}` as const;
    logger.info('ingest hook done', {
      sessionId,
      reason,
      outcome,
    });
    return outcome;
  } catch (error) {
    // Best-effort: ingestion problems must never block the session.
    logger.warn('ingest hook error (ignored)', {
      reason,
      error: String(error),
    });
    return 'failed';
  } finally {
    await client.close();
  }
};

/**
 * The Stop-hook leg: ship whatever the turn added. Kept as its own name so the
 * `ingest` subcommand and every existing caller read as what they are, while
 * the compaction leg calls the same body with its own reason.
 */
export const runStopIngest = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  await flushTranscriptDelta(adapter, 'stop');
};
