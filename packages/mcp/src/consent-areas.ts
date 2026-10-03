import type { TOOL_ANNOTATIONS } from './mcp-server.js';

type ToolName = keyof typeof TOOL_ANNOTATIONS;

/**
 * What an agent the person allows can do, grouped the way the dashboard's
 * consent screen names it. An authorized client acts as the person on every
 * tool, so the screen must not describe less than the tool list allows: every
 * registered tool belongs to exactly one area here, and the spec next to this
 * file fails when a tool is added without one, or when an area has no copy in
 * the catalogs or no line on the consent page.
 */
export const CONSENT_AREAS = {
  memories: [
    'remember',
    'recall',
    'build_context',
    'forget',
    'close_loop',
    'restore_memory',
    'share',
    'move_memories',
    'import_memory',
    'export_memories',
  ],
  graph: ['entities', 'link'],
  conflicts: [
    'list_conflicts',
    'get_conflict',
    'challenge',
    'resolve_conflict',
    'resolve_conflicts',
    'scan_hygiene',
    'benchmark_memory',
  ],
  rules: ['promote_rule'],
  board: ['board', 'card', 'card_log', 'release'],
  projects: ['describe_scope'],
  activity: ['ingest_conversation', 'session_receipt', 'export_metrics'],
  account: ['delete_account'],
} as const satisfies Record<string, readonly ToolName[]>;

export type ConsentArea = keyof typeof CONSENT_AREAS;
