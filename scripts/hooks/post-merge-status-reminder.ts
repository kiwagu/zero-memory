#!/usr/bin/env bun
/**
 * PostToolUse hook (matcher: Bash): after a merge/promote command runs, remind
 * the agent to sync durable status markers so they do not go stale.
 *
 * Recurring failure mode: the session that merges a feature branch (or promotes
 * stage) does NOT update the durable status notes in the planning docs ("not
 * merged yet") nor record the merge fact in ZM — so the next session plans work
 * that is already done. This hook fires exactly in the session that changes
 * merge state, at the moment it changes.
 *
 * It only injects additionalContext when the Bash command actually ran a
 * `git merge` (excluding --abort/--quit) or `scripts/promote-stage.sh`; for any
 * other command it is a silent no-op (empty stdout, exit 0). It never blocks.
 */
import { readStdinJson } from './mcp-http-call.js';
import { writeMarker } from './merge-sync-marker.js';

/** True when the command performs an actual merge or a stage promotion. */
const isMergeLike = (command: string): boolean => {
  const abort = /\bgit\s+merge\b[^\n|&;]*--(abort|quit|continue)\b/.test(
    command
  );
  if (abort) return false;
  const merge = /\bgit\s+merge\b/.test(command);
  // Only an actual invocation (start of a command segment, possibly via an
  // interpreter) — a grep/cat that merely mentions the script must not fire.
  const promote = /(^|[;&|(]\s*|\b(?:bash|sh)\s+)\S*promote-stage\.sh\b/m.test(
    command
  );
  return merge || promote;
};

const reminder = (markerPath: string | null): string =>
  [
    'A merge/promote just ran. Before moving on, sync durable status so the next',
    'session does not re-plan finished work:',
    '- flip status markers in your planning/roadmap docs ("not merged /',
    '  awaiting review / in branch X" -> done, date-stamped);',
    "- update the merged feature's status line in its decision record;",
    '- record the merge in the memory server (remember, superseding any stale',
    '  status memory): what merged into which branch.',
    ...(markerPath
      ? [
          `A pending-sync marker was written; delete it once synced (or if nothing`,
          `durable asserts this merge's status): rm ${markerPath}`,
        ]
      : [
          'Skip only if this merge changed nothing a durable doc or memory asserts.',
        ]),
  ].join('\n');

const main = async (): Promise<void> => {
  const payload = await readStdinJson();
  const toolInput = (payload.tool_input ?? {}) as { command?: string };
  const command = toolInput.command ?? '';
  if (!isMergeLike(command)) return; // silent no-op

  const markerPath = writeMarker(command.slice(0, 200));
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reminder(markerPath),
      },
    })
  );
};

// Never let a hook failure surface to the user or block the session.
main().catch(() => process.exit(0));
