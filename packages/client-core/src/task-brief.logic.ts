import {
  buildContextOutputSchema,
  type BuildContextOutput,
} from '@workspace/contracts';

/**
 * Pure decision logic for the task-brief-on-prompt hook: which prompts
 * deserve a task briefing, what topic to brief on, and how to drop memories
 * the session-start briefing already injected. Kept free of I/O so the hook
 * script stays a thin shell around it.
 */

/** Prompts shorter than this (after trimming) are not worth a briefing. */
export const MIN_PROMPT_LENGTH = 30;

/**
 * Short acknowledgements that carry no task signal even when padded with
 * punctuation. Checked word-by-word so combinations ("ok, go on") that sneak
 * past the length gate stay excluded. The defaults are English only — the
 * client-agnostic core carries no language bias; an operator whose
 * confirmations are in another language supplies them through config, and the
 * adapter passes the merged set to `isSubstantivePrompt`.
 */
export const DEFAULT_ACKNOWLEDGEMENT_WORDS: readonly string[] = [
  'yes',
  'no',
  'ok',
  'okay',
  'sure',
  'fine',
  'go',
  'continue',
  'proceed',
  'next',
  'thanks',
  'thank',
  'you',
  'please',
];

/**
 * The acknowledgement-word set: the English defaults plus any extra words the
 * operator configured — a whitespace/punctuation-separated string (e.g. their
 * language's confirmations, read from `ZM_ACK_WORDS` by the adapter). Pure: the
 * env read stays in the adapter, the merge lives here so it is unit-testable.
 */
export const resolveAcknowledgementWords = (extra?: string): Set<string> => {
  const words = new Set(
    DEFAULT_ACKNOWLEDGEMENT_WORDS.map((word) => word.toLowerCase())
  );
  if (extra) {
    for (const word of extra.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length > 0) words.add(word);
    }
  }
  return words;
};

/**
 * True when the prompt is worth a task briefing: not a slash command, long
 * enough to carry a task, and not just a string of acknowledgement words. The
 * acknowledgement set defaults to the English words; adapters pass the merged
 * set (defaults + configured extras) so non-English confirmations are skipped.
 */
export const isSubstantivePrompt = (
  prompt: string,
  ackWords: ReadonlySet<string> = resolveAcknowledgementWords()
): boolean => {
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_LENGTH) return false;
  if (trimmed.startsWith('/')) return false;
  const words = trimmed
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  return words.some((word) => !ackWords.has(word));
};

/** Parses a build_context tool payload into a typed briefing pack. */
export const parseBriefingPack = (payload: unknown): BuildContextOutput =>
  buildContextOutputSchema.parse(payload);

/**
 * Drops memories another briefing already injected (by `mem_` id), so the
 * task briefing only adds what the session has not seen. Entities and edges
 * stay: they are cheap and re-anchor the filtered memories. Open loops are
 * filtered the same way (the session-start briefing already showed them);
 * the total shrinks with the drops so "and N more" stays honest.
 */
export const filterBriefingPack = (
  pack: BuildContextOutput,
  excludeIds: readonly string[]
): BuildContextOutput => {
  const excluded = new Set(excludeIds);
  const openLoops = pack.open_loops.filter((loop) => !excluded.has(loop.id));
  return {
    ...pack,
    memories: pack.memories.filter((memory) => !excluded.has(memory.id)),
    linked_memories: pack.linked_memories.filter(
      (memory) => !excluded.has(memory.id)
    ),
    recent: pack.recent.filter((memory) => !excluded.has(memory.id)),
    open_loops: openLoops,
    open_loops_total: Math.max(
      0,
      pack.open_loops_total - (pack.open_loops.length - openLoops.length)
    ),
  };
};

/** True when the pack carries no memories worth injecting. */
export const isEmptyPack = (pack: BuildContextOutput): boolean =>
  pack.memories.length === 0 &&
  pack.linked_memories.length === 0 &&
  pack.recent.length === 0 &&
  pack.open_loops.length === 0;

/**
 * Best-effort `mem_` id extraction from an UNPARSED briefing payload — the
 * session-start hook records what it injected without failing on shape
 * drift, so this never throws.
 */
export const packMemoryIds = (payload: unknown): string[] => {
  const result = buildContextOutputSchema.safeParse(payload);
  if (!result.success) return [];
  return [
    ...result.data.memories,
    ...result.data.linked_memories,
    ...result.data.recent,
    ...result.data.open_loops,
  ].map((memory) => memory.id);
};
