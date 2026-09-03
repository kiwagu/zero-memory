import { createLogger } from '@workspace/logger';

import { hookClient, type HookClient } from '../hook-client.js';

const logger = createLogger('guide');

/**
 * The machine-independent memory-first mandate injected into the model's
 * context. Self-guarding (a no-op when the zero-memory tools are absent) so the
 * same text is safe to ship to every machine. Delivered as a hook's
 * `additionalContext` instead of a ~/.claude/CLAUDE.md patch — same content
 * everywhere, no per-machine file edit.
 */
const ZM_FIRST_GUIDE =
  'Memory-first (zero-memory) — applies only when the mcp__zero-memory__* ' +
  'tools are present; if absent, ignore this. Consult memory FIRST: ' +
  'build_context at the start of a task, and recall(<the exact question>) ' +
  'BEFORE grepping code, reading files, searching the web, or answering from ' +
  'training knowledge. Re-fire recall per NEW sub-question — not once per ' +
  'session; being mid-task is not an exemption. A stored decision-with-why for ' +
  'this project outranks generic reasoning: follow it or challenge it ' +
  'explicitly, never silently re-derive a different answer. The moment a ' +
  'durable fact surfaces (a decision+why, preference, gotcha, or convention), ' +
  'call remember immediately — one atomic fact per memory.';

/**
 * `guide` — emit the memory-first mandate as hookSpecificOutput.additionalContext
 * so any hook it is wired to injects it into the model's context. The event
 * name is echoed from the payload (works on SessionStart, UserPromptSubmit,
 * etc.). Never throws.
 */
export const runGuide = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  let event = adapter.kind === 'cursor' ? 'sessionStart' : 'SessionStart';
  try {
    const input = await adapter.readInput();
    if (input.hookEventName) {
      event = input.hookEventName;
    }
  } catch {
    // ignore a malformed/empty payload — fall back to the session-start event.
  }
  adapter.emitTurnContext(event, ZM_FIRST_GUIDE);
  logger.info('guide hook fired', { event, client: adapter.kind });
};
