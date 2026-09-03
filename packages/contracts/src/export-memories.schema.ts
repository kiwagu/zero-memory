import { z } from 'zod';

import {
  memoryAuthorKindSchema,
  memoryIdSchema,
  memoryKindSchema,
  memoryScopeSchema,
  memoryVisibilitySchema,
} from './memory.schema.js';

/**
 * `export_memories` — read every memory the caller can access (their own plus
 * anything shared into their scopes, exactly what RLS returns) for a Markdown
 * export. A privileged bulk egress: it is dispatched as a COMMAND so the
 * audited command bus records one `audit_log` row per export, unlike the
 * un-audited read tools (recall / build_context).
 */
export const exportMemoriesInputSchema = z.object({
  /**
   * Restrict the export to these exact scopes (e.g. a single shared scope
   * exported from its card). Omit to export everything accessible.
   */
  scopes: z.array(memoryScopeSchema).min(1).optional(),
});
export type ExportMemoriesInput = z.infer<typeof exportMemoriesInputSchema>;

/** One memory rendered into a file: the fields the Markdown export needs. */
export const exportedMemorySchema = z.object({
  id: memoryIdSchema,
  content: z.string(),
  /** Pre-translation source, when the content was canonicalized to English. */
  content_original: z.string().nullable(),
  content_lang: z.string().nullable(),
  kind: memoryKindSchema,
  scope: z.string(),
  visibility: memoryVisibilitySchema,
  author_kind: memoryAuthorKindSchema,
  agent_name: z.string().nullable(),
  /** Free-form provenance jsonb, kept verbatim in the exported frontmatter. */
  source: z.unknown().nullable(),
  superseded_by: memoryIdSchema.nullable(),
  invalidated_at: z.string().nullable(),
  created_at: z.string(),
});
export type ExportedMemory = z.infer<typeof exportedMemorySchema>;

export const exportMemoriesOutputSchema = z.object({
  items: exportedMemorySchema.array(),
  /** Total exported, for the audit trail and the client's progress display. */
  count: z.number().int().nonnegative(),
});
export type ExportMemoriesOutput = z.infer<typeof exportMemoriesOutputSchema>;
