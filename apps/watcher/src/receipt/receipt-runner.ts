import { formatReceiptLine } from '@workspace/client-core';
import {
  briefStatePath,
  claimReceipt,
  loadBriefState,
  receiptStatePath,
} from '@workspace/client-runtime';
import { createLogger } from '@workspace/logger';

import { hookClient, type HookClient } from '../hook-client.js';
import { projectIgnored } from '@workspace/client-runtime';
import { callSessionReceipt } from '@workspace/client-runtime';

// Every invocation logs a line (stderr + ZM_LOG_FILE) so the rotating log
// shows the receipt hook firing — and carries the receipt line itself, which
// is the fallback surface when the client does not render SessionEnd output.
const logger = createLogger('receipt');

/** Reads the hook's JSON payload from stdin (empty object when none). */
/**
 * `receipt` — the end-of-session value receipt: one chat line ("captured N ·
 * fired M · loops +A/−B · ~T tokens saved") delivered via the hook's
 * `systemMessage`, the deterministic user-facing channel. Wire it on
 * SessionEnd (event-agnostic: it reads whatever payload it gets, so a
 * Stop-with-state fallback needs no code change).
 *
 * Sources: "captured" accumulates client-side from the Stop-hook ingest
 * responses; the rest comes from ONE read-only `session_receipt` call with
 * the session-start stamp as the window. Every stage degrades quietly —
 * no stamp -> first-capture fallback, server down -> captured-only line,
 * nothing at all -> silence. Never throws, never blocks the session.
 */
export const runReceipt = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const input = await adapter.readInput();
    const sessionId = input.sessionId;
    if (!sessionId) {
      return;
    }

    // A .zero-memory-ignore project gets no briefing and no ingest — and no
    // receipt: even counters would advertise that the project was watched.
    const cwd = input.cwd;
    if (projectIgnored(cwd)) {
      logger.info('receipt hook fired', {
        sessionId,
        outcome: 'skipped:project-ignored',
      });
      return;
    }

    // One receipt per session: a re-fired end event (resume) stays silent.
    const claimed = claimReceipt(receiptStatePath(), sessionId);
    if (claimed === null) {
      logger.info('receipt hook fired', {
        sessionId,
        outcome: 'already-receipted',
      });
      return;
    }

    // Window start: the SessionStart stamp, else the first capture. Without
    // either there is nothing to ask the server about.
    const startedAt =
      loadBriefState(briefStatePath())[sessionId]?.started_at ??
      claimed.first_capture_at;

    let fired = 0;
    let loopsCreated = 0;
    let loopsClosed = 0;
    let savedTokens = 0;
    let alreadyKnew = 0;
    if (startedAt !== undefined) {
      try {
        const receipt = await callSessionReceipt(
          new Date(startedAt).toISOString()
        );
        fired = receipt.fired;
        loopsCreated = receipt.loops_created;
        loopsClosed = receipt.loops_closed;
        savedTokens = receipt.saved_tokens;
        alreadyKnew = receipt.already_knew;
      } catch (error) {
        // Server unreachable: degrade to the client-side counters.
        logger.warn('session_receipt call failed (degrading)', {
          sessionId,
          error: String(error),
        });
      }
    }

    const line = formatReceiptLine({
      captured: claimed.captured,
      fired,
      loopsCreated,
      loopsClosed,
      savedTokens,
      alreadyKnew,
    });
    if (line === null) {
      logger.info('receipt hook fired', { sessionId, outcome: 'empty' });
      return;
    }

    adapter.emitReceipt(line);
    logger.info('receipt hook fired', {
      sessionId,
      client: adapter.kind,
      outcome: 'delivered',
      receipt: line,
    });
  } catch (error) {
    // Best-effort: a receipt problem must never block the session end.
    logger.warn('receipt hook error (ignored)', { error: String(error) });
  }
};
