import { basename } from 'node:path';

import { renderCompactionAnchor } from '@workspace/client-core';
import {
  briefStatePath,
  callBuildContext,
  projectIgnored,
  projectScopeStatePath,
  readProjectScope,
  readSessionThread,
  stampSessionStart,
} from '@workspace/client-runtime';
import { buildContextOutputSchema } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';

import { hookClient, type HookClient } from '../hook-client.js';
import { flushTranscriptDelta } from '../ingest-hook/ingest-hook-runner.js';
import { resolveProjectHint } from '../project-hint-resolver.js';

// Every firing logs, including the ones that decide to do nothing: a
// compaction is invisible in the log otherwise, and "did the boundary hook run
// at all" is the first question anyone asks when knowledge goes missing.
const logger = createLogger('checkpoint');

/**
 * `checkpoint` — the compaction boundary, worked from both sides. Wire it on
 * the client event that fires just BEFORE a context compaction.
 *
 * A compaction is the sharpest joint a session has: the conversation continues
 * under the same id, but the context it was reasoning from is replaced by a
 * summary. Two different things are needed at that instant, and neither
 * substitutes for the other.
 *
 * CAPTURE — flush the transcript delta while it is still exactly one epoch.
 * The same body the end-of-turn hook runs, moved to a better moment: taken
 * here the delta covers precisely what is about to be compacted away, and the
 * advanced offset means the next turn's flush begins after the boundary rather
 * than straddling it.
 *
 * DELIVERY — hand the summarizing model an anchor. This is the ONLY moment at
 * which anything can influence what the summary keeps: the briefing that
 * re-fires afterwards arrives once the decision to drop something has already
 * been made. It is also the half that is NOT universal. Every client documents
 * its compaction hook as observational, and exactly one of them was measured to
 * behave otherwise, so the leg runs where `canAnchorCompaction` says a channel
 * exists and is skipped — not silenced, skipped — everywhere else.
 *
 * Both legs are best-effort and never throw: a compaction must not be blocked
 * by a memory server having a bad day.
 */
export const runCheckpoint = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const input = await adapter.readInput();
    const { sessionId, cwd } = input;
    logger.info('checkpoint hook fired', {
      sessionId,
      client: adapter.kind,
      // The client's word for why it is compacting (manual / auto), kept in
      // the log because the two are indistinguishable afterwards. All three
      // clients send it under `trigger`; it is NOT the session-event `source`.
      trigger: input.trigger,
    });

    // A .zero-memory-ignore project gets no capture and no anchor — the same
    // line the briefing and receipt hooks hold.
    if (projectIgnored(cwd)) {
      logger.info('checkpoint hook done', {
        sessionId,
        outcome: 'skipped:project-ignored',
      });
      return;
    }

    // Capture runs on every client; the anchor only where something it prints
    // can actually reach the summarizing model. Where it cannot, the leg is not
    // merely silenced — it is never assembled, because building it costs a
    // server round trip inside the boundary's own timeout and would compete
    // with the capture that DOES land.
    //
    // Concurrent, not sequential, when both run: each makes a round trip and
    // the hook has a wall-clock budget, so serializing would let a slow capture
    // eat the anchor's — and the anchor's value expires with the boundary.
    // `allSettled` because one leg failing is no reason to drop the other.
    const [capture, anchor] = await Promise.allSettled([
      flushTranscriptDelta(adapter, 'compaction', input),
      adapter.canAnchorCompaction
        ? deliverAnchor(adapter, sessionId, cwd)
        : Promise.resolve('skipped:no-anchor-channel'),
    ]);

    logger.info('checkpoint hook done', {
      sessionId,
      capture: capture.status === 'fulfilled' ? capture.value : 'failed',
      anchor: anchor.status === 'fulfilled' ? anchor.value : 'failed',
    });
  } catch (error) {
    // Best-effort: a checkpoint problem must never block the compaction.
    logger.warn('checkpoint hook error (ignored)', { error: String(error) });
  }
};

/**
 * Codex's post-compaction half of the boundary.
 *
 * PreCompact captures the transcript while the old epoch still exists.
 * PostCompact then marks that the model context was replaced: task/rule
 * deliveries re-arm for the next prompt while the conversation's thread token
 * stays attached to the unchanged session id. This event has no context output
 * channel in Codex, so the hook deliberately writes no stdout frame.
 */
export const runPostCompact = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const input = await adapter.readInput();
    const { sessionId, cwd } = input;
    logger.info('post-compact hook fired', {
      sessionId,
      client: adapter.kind,
      trigger: input.trigger,
    });

    if (projectIgnored(cwd)) {
      logger.info('post-compact hook done', {
        sessionId,
        outcome: 'skipped:project-ignored',
      });
      return;
    }
    if (!sessionId) {
      logger.info('post-compact hook done', {
        sessionId,
        outcome: 'skipped:no-session-id',
      });
      return;
    }

    stampSessionStart(briefStatePath(), sessionId, Date.now(), 'compact');
    logger.info('post-compact hook done', {
      sessionId,
      outcome: 'epoch-advanced',
    });
  } catch (error) {
    logger.warn('post-compact hook error (ignored)', { error: String(error) });
  }
};

/**
 * Builds the anchor and emits it, returning what happened for the log.
 *
 * The read is a PLAIN `build_context`, deliberately not a briefing one. Open
 * loops come back either way — they are assembled relevance-free, outside the
 * briefing gate — while `briefing: true` would meter this as a session briefing
 * and inflate the count of briefings actually delivered to an agent. The pack's
 * memories are not used at all, so the budget stays small; identity and loops
 * are the whole payload.
 *
 * Identity falls back to disk when the call fails. A server that is down is
 * exactly when a session most needs to keep its own name through a compaction,
 * and both values were persisted by an earlier briefing.
 */
const deliverAnchor = async (
  adapter: HookClient,
  sessionId: string,
  cwd: string
): Promise<string> => {
  const projectHint = resolveProjectHint(cwd);

  const payload = await callBuildContext({
    topic: basename(cwd),
    max_tokens: 400,
    conversation_id: sessionId || undefined,
    project_hint: projectHint,
  }).catch((error: unknown) => {
    logger.warn('checkpoint context call failed (degrading)', {
      sessionId,
      error: String(error),
    });
    return null;
  });

  const parsed =
    payload === null ? null : buildContextOutputSchema.safeParse(payload);
  const pack = parsed?.success === true ? parsed.data : null;

  const text = renderCompactionAnchor({
    scope:
      pack?.project_scope ??
      readProjectScope(projectScopeStatePath(), projectHint),
    thread:
      pack?.session?.thread ??
      (sessionId ? readSessionThread(briefStatePath(), sessionId) : null),
    loops: pack?.open_loops ?? [],
    total: pack?.open_loops_total ?? 0,
  });

  if (text === null) {
    return 'nothing-to-anchor';
  }
  adapter.emitCompactionAnchor(text);
  return `delivered:${text.length}`;
};
