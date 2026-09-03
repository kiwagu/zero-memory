import { z } from 'zod';

import { entityIdSchemas } from './entity-prefixes.js';

/** Kinds of memory a client can store. */
export const memoryKindSchema = z.enum([
  'fact',
  'preference',
  'decision',
  'convention',
  'gotcha',
  'reference',
  'episode',
  'task',
  'open-question',
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/**
 * Open-loop kinds: short-lived lifecycle memories (a handed-over task, an
 * unanswered question) that briefings surface ABOVE the ranked pack until
 * explicitly closed (invalidated). Excluded from long-term knowledge
 * machinery — the rules incubator, the ROI benchmark, and the extractor's
 * kind vocabulary (loops are opened deliberately, never auto-extracted).
 */
export const OPEN_LOOP_KINDS = ['task', 'open-question'] as const;
export type OpenLoopKind = (typeof OPEN_LOOP_KINDS)[number];

/** True when a kind is an open-loop kind (closable via `close_loop`). */
export const isOpenLoopKind = (kind: MemoryKind): kind is OpenLoopKind =>
  (OPEN_LOOP_KINDS as readonly string[]).includes(kind);

/**
 * The kinds the transcript extractor may classify into: everything EXCEPT
 * open-loop kinds. The extractor's tool schema is generated from this enum,
 * so the exclusion is structural — a widened `memoryKindSchema` can never
 * leak task/open-question into auto-extraction (they would produce noisy
 * loops nobody closes).
 */
export const extractableMemoryKindSchema = memoryKindSchema.exclude([
  'task',
  'open-question',
]);
export type ExtractableMemoryKind = z.infer<typeof extractableMemoryKindSchema>;

/** Visibility scope of a memory. */
export const memoryScopeSchema = z.string().min(1);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/** Who may read a memory: only its owner, or everyone within its scope. */
export const memoryVisibilitySchema = z.enum(['private', 'shared']);
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;

/** What kind of author produced a memory. */
export const memoryAuthorKindSchema = z.enum(['human', 'agent']);
export type MemoryAuthorKind = z.infer<typeof memoryAuthorKindSchema>;

/**
 * Language-canonicalization state of a memory's content:
 *   - 'skipped' — already English; `content` is canonical as-is.
 *   - 'pending' — non-English; `content` still holds the original, awaiting the
 *                 async translation worker.
 *   - 'done'    — translated; `content` is English, `content_original` the source.
 */
export const translationStatusSchema = z.enum(['pending', 'done', 'skipped']);
export type TranslationStatus = z.infer<typeof translationStatusSchema>;

/** A memory id: a branded `mem_` entity id (parsed, never a raw string). */
export const memoryIdSchema = entityIdSchemas.memory.schema;
export type MemoryId = z.infer<typeof memoryIdSchema>;

/** Mint a fresh memory id (trusted construction). */
export const newMemoryId = (): MemoryId => entityIdSchemas.memory.create();

/** Kinds of memory->memory links (controlled vocabulary). */
export const memoryLinkTypeSchema = z.enum([
  'relates_to',
  'supersedes',
  'contradicts',
  'derived_from',
]);
export type MemoryLinkType = z.infer<typeof memoryLinkTypeSchema>;

export const memoryLinkSchema = z.object({
  dst: memoryIdSchema,
  type: memoryLinkTypeSchema,
});
export type MemoryLink = z.infer<typeof memoryLinkSchema>;
