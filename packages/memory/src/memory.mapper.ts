import {
  memoryAuthorKindSchema,
  memoryIdSchema,
  memoryKindSchema,
  memoryVisibilitySchema,
  translationStatusSchema,
  userIdSchema,
} from '@workspace/contracts';
import type { Mapper } from '@workspace/domain';
import { z } from 'zod';

import { Lifecycle } from './lifecycle.vo.js';
import { MemoryContent } from './memory-content.vo.js';
import { MemoryFragment } from './memory-fragment.do.js';
import { Provenance } from './provenance.vo.js';
import { Scope } from './scope.vo.js';
import { TranslationState } from './translation-state.vo.js';
import { Visibility } from './visibility.vo.js';

/**
 * Persisted shape of a memory fragment as it crosses the persistence
 * boundary (snake_case column names, ISO timestamp strings).
 */
export const memoryFragmentRecordSchema = z.object({
  id: memoryIdSchema,
  content: z.string(),
  kind: memoryKindSchema,
  scope: z.string(),
  visibility: memoryVisibilitySchema,
  // User ids are the domain `usr_` handles: the repository resolves the DB auth
  // uuids to profiles.id before parsing, and back to uuids on write.
  owner_id: userIdSchema,
  author_kind: memoryAuthorKindSchema,
  agent_name: z.string().nullable(),
  source: z.record(z.string(), z.unknown()).nullable(),
  content_original: z.string().nullable(),
  content_lang: z.string().nullable(),
  translation_status: translationStatusSchema,
  translation_attempts: z.number(),
  translation_error: z.string().nullable(),
  valid_from: z.string().nullable(),
  invalidated_at: z.string().nullable(),
  invalidated_by: userIdSchema.nullable(),
  superseded_by: memoryIdSchema.nullable(),
  shared_at: z.string().nullable(),
  shared_by: userIdSchema.nullable(),
  created_at: z.string().nullable(),
});
export type MemoryFragmentRecord = z.infer<typeof memoryFragmentRecordSchema>;

export interface MemoryFragmentDTO {
  id: string;
  content: string;
  kind: string;
  scope: string;
  visibility: string;
  created_at: string | null;
}

const toDate = (value: string | null, fallback: Date): Date =>
  value === null ? fallback : new Date(value);

const toNullableDate = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

const toIso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * Maps between the MemoryFragment aggregate, its persistence record, and its
 * transport DTO. Reconstitution trusts the store (RLS + checks) but still
 * fails loudly on malformed values via the value objects.
 */
export class MemoryMapper implements Mapper<
  MemoryFragment,
  MemoryFragmentRecord,
  MemoryFragmentDTO
> {
  toDomain(record: MemoryFragmentRecord): MemoryFragment {
    const content = MemoryContent.create(record.content, record.kind).expect(
      `Corrupt memory content for ${record.id}`
    );
    const scope = Scope.fromStored(record.scope).expect(
      `Corrupt memory scope for ${record.id}`
    );
    const visibility = Visibility.create(record.visibility).expect(
      `Corrupt memory visibility for ${record.id}`
    );
    const createdAt = toDate(record.created_at, new Date(0));
    return MemoryFragment.reconstitute(record.id, {
      content,
      scope,
      visibility,
      provenance: Provenance.create({
        ownerId: record.owner_id,
        authorKind: record.author_kind,
        agentName: record.agent_name,
        source: record.source,
      }),
      translation: TranslationState.restore({
        status: record.translation_status,
        originalText: record.content_original,
        lang: record.content_lang,
        attempts: record.translation_attempts,
        error: record.translation_error,
      }),
      lifecycle: Lifecycle.restore({
        validFrom: toDate(record.valid_from, createdAt),
        createdAt,
        invalidatedAt: toNullableDate(record.invalidated_at),
        invalidatedBy: record.invalidated_by,
        supersededBy: record.superseded_by,
        sharedAt: toNullableDate(record.shared_at),
        sharedBy: record.shared_by,
      }),
    });
  }

  toEntity(domain: MemoryFragment): MemoryFragmentRecord {
    const { lifecycle, provenance, translation } = domain;
    return {
      id: domain.id,
      content: domain.content.content,
      kind: domain.content.kind,
      scope: domain.scope.path,
      visibility: domain.visibility.level,
      owner_id: provenance.ownerId,
      author_kind: provenance.authorKind,
      agent_name: provenance.agentName,
      source: provenance.source,
      content_original: translation.originalText,
      content_lang: translation.lang,
      translation_status: translation.status,
      translation_attempts: translation.attempts,
      translation_error: translation.error,
      valid_from: lifecycle.validFrom.toISOString(),
      invalidated_at: toIso(lifecycle.invalidatedAt),
      invalidated_by: lifecycle.invalidatedBy,
      superseded_by: lifecycle.supersededBy,
      shared_at: toIso(lifecycle.sharedAt),
      shared_by: lifecycle.sharedBy,
      created_at: lifecycle.createdAt.toISOString(),
    };
  }

  toDTO(domain: MemoryFragment): MemoryFragmentDTO {
    return {
      id: domain.id,
      content: domain.content.content,
      kind: domain.content.kind,
      scope: domain.scope.path,
      visibility: domain.visibility.level,
      created_at: domain.lifecycle.createdAt.toISOString(),
    };
  }
}
