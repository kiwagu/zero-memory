import {
  edgeTypeSchema,
  entityTypeSchema,
  extractableMemoryKindSchema,
} from '@workspace/contracts';
import { z } from 'zod';

/**
 * Relation vocabulary an extractor may emit: the entity edge types minus
 * `relates_to` (too vague to auto-extract — explicit `link` calls only).
 */
export const extractedRelationTypeSchema = edgeTypeSchema.exclude([
  'relates_to',
]);
export type ExtractedRelationType = z.infer<typeof extractedRelationTypeSchema>;

export const extractedEntitySchema = z.object({
  name: z.string().min(1),
  type: entityTypeSchema,
});
export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;

/**
 * Canonical comparison key for entity names: lowercase with separator runs
 * (space/underscore/hyphen) unified — "zero_memory", "Zero Memory" and
 * "zero-memory" all denote one entity. Mirrors the briefing's display
 * normalization, so a relation the pack would render as a self-loop is
 * rejected at the source.
 */
const canonicalEntityKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '-');

export const extractedRelationSchema = z
  .object({
    /** Entity names — must resolve within the memory's scope. */
    src: z.string().min(1),
    dst: z.string().min(1),
    type: extractedRelationTypeSchema,
  })
  .refine(
    (relation) =>
      canonicalEntityKey(relation.src) !== canonicalEntityKey(relation.dst),
    {
      message:
        'Self-loop relation: src and dst are the same entity by canonical name.',
    }
  );
export type ExtractedRelation = z.infer<typeof extractedRelationSchema>;

export const extractedMemorySchema = z.object({
  /** Self-contained standalone statement (never a transcript snippet). */
  content: z.string().min(8),
  /** Open-loop kinds are excluded: loops are opened deliberately by an
   * agent/owner, never auto-extracted (noisy loops nobody closes). */
  kind: extractableMemoryKindSchema,
  /** Extractor's confidence that this is a durable, correct fact. */
  confidence: z.number().min(0).max(1),
  /**
   * True when the fact holds OUTSIDE this project (a tool/technology quirk,
   * not a project decision) — routed to the user's core scope, which every
   * session reads. Defaults to false: a project fact leaked to all sessions
   * is worse than a portable fact scoped to one project.
   */
  portable: z.boolean().default(false),
  entities: z.array(extractedEntitySchema).default([]),
  relations: z.array(extractedRelationSchema).default([]),
});
export type ExtractedMemory = z.infer<typeof extractedMemorySchema>;

/** Boundary contract every extractor adapter must satisfy (schema-first). */
export const extractionResultSchema = z.object({
  memories: z.array(extractedMemorySchema),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/** What a lenient parse discarded — for ops visibility, not an error. */
export interface DroppedCounts {
  memories: number;
  entities: number;
  relations: number;
}

export interface LenientExtraction {
  result: ExtractionResult;
  dropped: DroppedCounts;
}

const rawLength = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

const keepValid = <T>(value: unknown, item: z.ZodType<T>): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: T[] = [];
  for (const element of value) {
    const parsed = item.safeParse(element);
    if (parsed.success) {
      kept.push(parsed.data);
    }
  }
  return kept;
};

/**
 * Parse extractor output resiliently: a single out-of-vocabulary relation or
 * entity type (the model does not always honor the tool enum) must NOT sink
 * the whole chunk — drop just the offending sub-item and keep the memory with
 * its valid parts. A memory whose core fields (content/kind/confidence) are
 * invalid is dropped whole. Returns drop counts so the adapter can log them.
 */
export const parseExtractionLenient = (raw: unknown): LenientExtraction => {
  const outer = z
    .object({ memories: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success) {
    return {
      result: { memories: [] },
      dropped: { memories: 0, entities: 0, relations: 0 },
    };
  }

  const dropped: DroppedCounts = { memories: 0, entities: 0, relations: 0 };
  const memories: ExtractedMemory[] = [];

  for (const rawMemory of outer.data.memories) {
    const rawEntities = rawLength(
      (rawMemory as { entities?: unknown }).entities
    );
    const rawRelations = rawLength(
      (rawMemory as { relations?: unknown }).relations
    );

    const core = extractedMemorySchema
      .omit({ entities: true, relations: true })
      .safeParse(rawMemory);
    if (!core.success) {
      dropped.memories += 1;
      continue;
    }

    const entities = keepValid(
      (rawMemory as { entities?: unknown }).entities,
      extractedEntitySchema
    );
    const relations = keepValid(
      (rawMemory as { relations?: unknown }).relations,
      extractedRelationSchema
    );
    dropped.entities += rawEntities - entities.length;
    dropped.relations += rawRelations - relations.length;

    memories.push({ ...core.data, entities, relations });
  }

  return { result: { memories }, dropped };
};
