#!/usr/bin/env bun
/**
 * SessionStart hook: if an earlier merge/promote left the durable-status
 * sync marker in place (the one-shot post-merge reminder was ignored, or the
 * merge ran outside an agent session and only the native git hook saw it),
 * keep re-surfacing it at every session start until someone syncs the docs
 * and memory and deletes the marker.
 *
 * Silent no-op (empty stdout, exit 0) when no marker is pending.
 */
import { readMarker } from './merge-sync-marker.js';

const found = readMarker();
if (found) {
  const context = [
    `An earlier merge/promote (${found.marker.source}; detected ${found.marker.detected_at}) is still awaiting its durable-status sync:`,
    '- flip status markers in the planning/roadmap docs ("not merged /',
    '  awaiting review / in branch X" -> done, date-stamped);',
    "- update the merged feature's status line in its decision record;",
    '- record the merge in the memory server (remember, superseding any',
    '  stale status memory).',
    `When synced — or if nothing durable asserts this merge's status — delete the marker: rm ${found.path}`,
  ].join('\n');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  );
}
