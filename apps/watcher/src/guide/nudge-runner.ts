import { decideRecallGap } from '@workspace/client-core';
import {
  countMemoryTool,
  markRecallGapReminded,
  readRecallGapCounters,
  recallGapStatePath,
} from '@workspace/client-runtime';
import { createLogger } from '@workspace/logger';

import { hookClient, type HookClient } from '../hook-client.js';

const logger = createLogger('nudge');

/**
 * `nudge` — the recall reminder, wired to several events and driven by one
 * per-session counter.
 *
 * One runner rather than one per event, because they are one concern: every
 * reminder is gated on the same fact — whether this session has consulted memory
 * at all — and that fact only exists because the memory-tool wiring counts it.
 * Splitting them would mean two runners sharing one state file for no gain.
 *
 * What each wiring does:
 *  - on a memory-tool call: count it, say nothing;
 *  - on a FAILING investigation tool: the moment a stored gotcha would have
 *    helped, so remind — but only if the session has never read memory;
 *  - at END OF TURN: if the session wrote memories and read none, say so while
 *    the next turn can still act on it;
 *  - on a code SEARCH: the original reminder, now under the same gate.
 *
 * Each reminder fires at most once per session, and any read silences all of them
 * for the rest of it. Never throws: a hook must not break the session it
 * observes.
 *
 * Client reach differs, honestly rather than silently: on a client whose
 * end-of-turn hook is fire-and-forget, the turn-end reminder is computed and
 * logged but cannot reach the agent, and a client with no tool-failure event
 * simply never hits that trigger.
 */
export const runNudge = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const input = await adapter.readInput();
    const sessionId = input.sessionId;
    if (!sessionId) {
      return;
    }
    const event =
      input.hookEventName ||
      (adapter.kind === 'cursor' ? 'preToolUse' : 'PreToolUse');

    const path = recallGapStatePath();
    const action = decideRecallGap({
      event,
      counters: readRecallGapCounters(path, sessionId),
      toolName: input.toolName,
      alreadyContinued: input.alreadyContinued,
    });

    if (action.kind === 'count') {
      countMemoryTool(path, sessionId, action.tally);
      logger.info('nudge hook counted a memory call', {
        sessionId,
        tally: action.tally,
        client: adapter.kind,
      });
      return;
    }

    if (action.kind === 'silent') {
      return;
    }

    // Recorded BEFORE emitting: if this process died in between, a reminder
    // nobody saw costs far less than one that repeats on every firing.
    markRecallGapReminded(path, sessionId, action.trigger);
    adapter.emitTurnContext(event, action.text);
    logger.info('nudge hook fired', {
      sessionId,
      trigger: action.trigger,
      client: adapter.kind,
    });
  } catch (error) {
    logger.warn('nudge hook error (ignored)', { error: String(error) });
  }
};
