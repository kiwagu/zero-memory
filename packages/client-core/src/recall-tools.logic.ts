/**
 * Recognizing a recall call, and the ids it surfaced, in ANY client's
 * transcript. Every adapter needs the same two answers — "was this tool call a
 * read?" and "which `mem_` ids did its result show the agent?" — while the
 * shapes around them differ per client, so the answers live here (pure domain)
 * and the envelope-walking stays in the adapters.
 */

import { CROCKFORD_CLASS } from 'entity-id';

/** Read tools whose result carries the `mem_` ids surfaced to the agent. */
export const RECALL_TOOLS: ReadonlySet<string> = new Set([
  'recall',
  'build_context',
]);

/**
 * A tool's own name, with any namespace prefix stripped.
 *
 * The prefix is a per-client MOUNT ARTIFACT, not part of the tool's identity,
 * and every client spells it differently: Claude Code records
 * `mcp__zero-memory__recall` (or `mcp__plugin_zero-memory_zero-memory__recall`
 * for a plugin-bundled server), while Codex and Cursor record the bare `recall`
 * and keep the namespace in a field of its own. Comparing the LAST `__` segment
 * therefore covers every variant, bare names included — which is exactly why
 * one helper serves all three clients.
 *
 * Matching a foreign server's same-named tool is harmless: ids are collected
 * with {@link collectMemoryIds}, which only accepts this store's id format.
 */
export const toolBaseName = (name: string): string => {
  const separator = name.lastIndexOf('__');
  return separator === -1 ? name : name.slice(separator + 2);
};

/** Whether a recorded tool name denotes a recall / build_context call. */
export const isRecallTool = (name: string | undefined): boolean =>
  name !== undefined && RECALL_TOOLS.has(toolBaseName(name));

/**
 * Non-anchored `mem_` id matcher, built from the canonical entity-id char class
 * so it never drifts from the id format. `matchAll` clones the regex, so
 * sharing this one instance across calls is safe.
 */
const MEMORY_ID_RE = new RegExp(
  `mem_${CROCKFORD_CLASS}{16}\\.${CROCKFORD_CLASS}{10}`,
  'g'
);

/**
 * The `mem_` ids appearing in a recall result's payload. Callers pass the
 * STRINGIFIED result (shapes vary: a raw string, an array of text blocks, a
 * nested object), since every variant carries the ids as plain text.
 */
export const collectMemoryIds = (payload: string): string[] => [
  ...new Set([...payload.matchAll(MEMORY_ID_RE)].map((match) => match[0])),
];
