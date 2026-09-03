import type { EntityId } from '@workspace/contracts';
import { DeterministicHashEmbeddingService } from '@workspace/embedding/testing';
import { None, Ok, Some, type Option } from 'oxide.ts';
import { describe, expect, it, vi } from 'vitest';

import { EntityResolutionService } from './entity-resolution.service.js';
import type { EntityRef, IEntityRepository } from './entity.repository.js';
import { Scope } from './scope.vo.js';

const scope = Scope.create('proj.alpha').unwrap();

const makeRepository = (overrides?: {
  exact?: Option<EntityRef>;
  matchKey?: Option<EntityRef>;
}): IEntityRepository => ({
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
  findByNormalizedName: vi.fn().mockResolvedValue(overrides?.exact ?? None),
  findByMatchKey: vi.fn().mockResolvedValue(overrides?.matchKey ?? None),
  findContentAnchors: vi.fn().mockResolvedValue([]),
  linkMemory: vi.fn().mockResolvedValue(Ok(undefined)),
  list: vi.fn().mockResolvedValue([]),
  listForMemories: vi.fn().mockResolvedValue(new Map()),
});

const makeService = (repository: IEntityRepository) =>
  new EntityResolutionService(
    repository,
    new DeterministicHashEmbeddingService()
  );

describe('EntityResolutionService.resolve — decision table (DESIGN §6.6)', () => {
  it('exact normalized match attaches without touching the embedder', async () => {
    const repository = makeRepository({
      exact: Some({
        id: 'ent_0000000000000001.0000000000' as EntityId,
        name: 'Postgres',
      }),
    });
    const service = makeService(repository);

    const result = await service.resolve('  Postgres ', 'tool', scope);

    expect(result.unwrap()).toEqual({
      entityId: 'ent_0000000000000001.0000000000' as EntityId,
      name: 'Postgres',
      created: false,
    });
    // Normalization: trim + collapse spaces + lowercase for the lookup key.
    // The probe is type-agnostic even when the caller names a type: a
    // same-name node under another type is reused, never duplicated.
    expect(repository.findByNormalizedName).toHaveBeenCalledWith(
      'postgres',
      null,
      scope
    );
    expect(repository.findByMatchKey).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('the same name spelled differently attaches by match key', async () => {
    const repository = makeRepository({
      matchKey: Some({
        id: 'ent_0000000000000002.0000000000' as EntityId,
        name: 'zero-memory',
      }),
    });
    const service = makeService(repository);

    const result = await service.resolve('zero_memory', 'repo', scope);

    expect(result.unwrap()).toEqual({
      entityId: 'ent_0000000000000002.0000000000' as EntityId,
      name: 'zero-memory',
      created: false,
    });
    const [key, probeType, probeScope] = vi.mocked(repository.findByMatchKey)
      .mock.calls[0]!;
    // Separator runs are removed, so every spelling of one subject is one key.
    expect(key).toBe('zeromemory');
    // Type-agnostic like the exact probe: one subject written as a repo in one
    // memory and a project in another is the duplication this step stops.
    expect(probeType).toBeNull();
    expect(probeScope).toBe(scope);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('resolves by match key across every separator and casing spelling', async () => {
    for (const spelling of [
      'zero-memory',
      'zero memory',
      'ZeroMemory',
      'Zero_Memory',
      '  zero   memory  ',
    ]) {
      const repository = makeRepository({
        matchKey: Some({
          id: 'ent_0000000000000002.0000000000' as EntityId,
          name: 'zero-memory',
        }),
      });
      await makeService(repository).resolve(spelling, null, scope);

      const [key] = vi.mocked(repository.findByMatchKey).mock.calls[0]!;
      expect(key, `spelling ${spelling}`).toBe('zeromemory');
    }
  });

  it('attaching by either probe costs no model call', async () => {
    const embedder = new DeterministicHashEmbeddingService();
    const embed = vi.spyOn(embedder, 'embed');
    const repository = makeRepository({
      matchKey: Some({
        id: 'ent_0000000000000002.0000000000' as EntityId,
        name: 'zero-memory',
      }),
    });

    await new EntityResolutionService(repository, embedder).resolve(
      'zero_memory',
      'repo',
      scope
    );

    // Both probes are exact, so the embedding is computed only for an insert.
    expect(embed).not.toHaveBeenCalled();
  });

  it('a serial-numbered sibling is a DISTINCT subject and is created', async () => {
    // The regression this design exists for: the cosine probe it replaced
    // scored serial-numbered siblings as high as 0.9805 — above any workable
    // floor — and so silently anchored one record's decisions onto another.
    const repository = makeRepository();
    const service = makeService(repository);

    const result = await service.resolve('TICKET-4210', 'concept', scope);

    expect(result.unwrap().created).toBe(true);
    const [key] = vi.mocked(repository.findByMatchKey).mock.calls[0]!;
    expect(key).toBe('ticket4210');
    const [entity] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(entity.name).toBe('TICKET-4210');
  });

  it.each([
    ['TICKET-4210', 'ticket4210'],
    ['resolve_conflicts', 'resolveconflicts'],
    ['multilingual-e5-large', 'multilinguale5large'],
    ['port 8793', 'port8793'],
    ['v0.9.1', 'v0.9.1'],
    ['README', 'readme'],
  ])(
    'keeps %s on its own key, which no near neighbour shares',
    async (name, expected) => {
      const repository = makeRepository();
      await makeService(repository).resolve(name, null, scope);

      const [key] = vi.mocked(repository.findByMatchKey).mock.calls[0]!;
      expect(key).toBe(expected);
    }
  );

  it('neither probe matching creates a new entity with its name embedding', async () => {
    const repository = makeRepository();
    const service = makeService(repository);

    const result = await service.resolve('  Apache   AGE ', 'library', scope);

    const resolved = result.unwrap();
    expect(resolved.created).toBe(true);
    // Display name keeps casing, whitespace collapsed.
    expect(resolved.name).toBe('Apache AGE');

    const [entity, embedding] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(entity.name).toBe('Apache AGE');
    expect(entity.normalizedName).toBe('apache age');
    expect(entity.type).toBe('library');
    expect(entity.scope.path).toBe('proj.alpha');
    expect(embedding).toHaveLength(1024);
    expect(resolved.entityId).toBe(entity.id);
  });

  it('resolution is scope-local: the probes carry the given scope', async () => {
    const repository = makeRepository();
    const service = makeService(repository);
    const otherScope = Scope.create('user.someone').unwrap();

    await service.resolve('bun', 'tool', otherScope);

    expect(repository.findByNormalizedName).toHaveBeenCalledWith(
      'bun',
      null,
      otherScope
    );
    const [, , probeScope] = vi.mocked(repository.findByMatchKey).mock
      .calls[0]!;
    expect(probeScope).toBe(otherScope);
  });

  it('type-agnostic resolve (link tool) reuses an exact hit of any type', async () => {
    const repository = makeRepository({
      exact: Some({
        id: 'ent_0000000000000003.0000000000' as EntityId,
        name: 'alpha',
      }),
    });
    const service = makeService(repository);

    const result = await service.resolve('Alpha', null, scope);

    expect(result.unwrap()).toEqual({
      entityId: 'ent_0000000000000003.0000000000' as EntityId,
      name: 'alpha',
      created: false,
    });
    expect(repository.findByNormalizedName).toHaveBeenCalledWith(
      'alpha',
      null,
      scope
    );
  });

  it('type-agnostic resolve falls back to creating a concept entity', async () => {
    const repository = makeRepository();
    const service = makeService(repository);

    const result = await service.resolve('brand new thing', null, scope);

    expect(result.unwrap().created).toBe(true);
    const [entity] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(entity.type).toBe('concept');
    // The match-key probe stays type-agnostic; only creation takes the
    // concept fallback.
    const [, probeType] = vi.mocked(repository.findByMatchKey).mock.calls[0]!;
    expect(probeType).toBeNull();
  });

  it('rejects empty names before any port call', async () => {
    const repository = makeRepository();
    const service = makeService(repository);

    const result = await service.resolve('   ', 'concept', scope);

    expect(result.isErr()).toBe(true);
    expect(repository.findByNormalizedName).not.toHaveBeenCalled();
    expect(repository.findByMatchKey).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });
});
