import {
  memoryIdSchema,
  memoryKindSchema,
  memoryScopeSchema,
  memoryVisibilitySchema,
  userIdSchema,
} from '@workspace/contracts';
import { BaseEvent } from '@workspace/domain';
import { z } from 'zod';

export const MEMORY_REMEMBERED = 'memory.remembered' as const;
export const MEMORY_INVALIDATED = 'memory.invalidated' as const;
export const MEMORY_SHARED = 'memory.shared' as const;

export const memoryRememberedPayloadSchema = z.object({
  memoryId: memoryIdSchema,
  scope: memoryScopeSchema,
  kind: memoryKindSchema,
  visibility: memoryVisibilitySchema,
  ownerId: userIdSchema,
});
export type MemoryRememberedPayload = z.infer<
  typeof memoryRememberedPayloadSchema
>;

export const memoryInvalidatedPayloadSchema = z.object({
  memoryId: memoryIdSchema,
  invalidatedBy: userIdSchema,
  supersededBy: memoryIdSchema.nullable(),
});
export type MemoryInvalidatedPayload = z.infer<
  typeof memoryInvalidatedPayloadSchema
>;

export const memorySharedPayloadSchema = z.object({
  memoryId: memoryIdSchema,
  scope: memoryScopeSchema,
  sharedBy: userIdSchema,
});
export type MemorySharedPayload = z.infer<typeof memorySharedPayloadSchema>;

export class MemoryRememberedEvent extends BaseEvent<
  MemoryRememberedPayload,
  typeof MEMORY_REMEMBERED
> {
  readonly name = MEMORY_REMEMBERED;

  constructor(payload: MemoryRememberedPayload) {
    super(payload, undefined);
  }
}

export class MemoryInvalidatedEvent extends BaseEvent<
  MemoryInvalidatedPayload,
  typeof MEMORY_INVALIDATED
> {
  readonly name = MEMORY_INVALIDATED;

  constructor(payload: MemoryInvalidatedPayload) {
    super(payload, undefined);
  }
}

export class MemorySharedEvent extends BaseEvent<
  MemorySharedPayload,
  typeof MEMORY_SHARED
> {
  readonly name = MEMORY_SHARED;

  constructor(payload: MemorySharedPayload) {
    super(payload, undefined);
  }
}

export type MemoryDomainEvent =
  MemoryRememberedEvent | MemoryInvalidatedEvent | MemorySharedEvent;
