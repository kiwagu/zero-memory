import type { IContext } from '@workspace/context';
import { DeterministicHashEmbeddingService } from '@workspace/embedding/testing';
import {
  EntityResolutionService,
  MemoryService,
  ScopeRoutingService,
  type IEntityRepository,
  type IGraphService,
  type IMemoryRepository,
  type IMemorySearchService,
  type IProjectBindingRepository,
  type IScopeAccessService,
} from '@workspace/memory';
import { Err, None, Ok, type Result } from 'oxide.ts';
import { describe, expect, it, vi } from 'vitest';

import { ImportService } from './import.service.js';
import type {
  IIngestLogRepository,
  IngestLogEntry,
} from './ingest-log.repository.js';

const USER_ENTITY_ID = 'usr_000000000000000a.0000000000';
const PERSONAL_SCOPE = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
const CORE_SCOPE = `${PERSONAL_SCOPE}.core`;

const makeContext = (): IContext => ({
  setContextValue: () => undefined,
  mustGetCurrentUserId: () => 'b7e6a1c2-3d4f-4a5b-8c9d-0e1f2a3b4c5d',
  getCurrentUserId: () => 'b7e6a1c2-3d4f-4a5b-8c9d-0e1f2a3b4c5d',
  mustGetCurrentUserEntityId: () => USER_ENTITY_ID,
  getCurrentUserEntityId: () => USER_ENTITY_ID,
  getAccessToken: () => 'token',
  getScopes: () => [],
  getDefaultScope: () => undefined,
  getCurrentSessionId: () => undefined,
});

const makeRepository = (
  insertResult: Result<undefined, string> = Ok(undefined)
): IMemoryRepository => ({
  insert: vi.fn().mockResolvedValue(insertResult),
  findOneById: vi.fn().mockResolvedValue(None),
  update: vi.fn().mockResolvedValue(Ok(undefined)),
  applyTranslation: vi.fn().mockResolvedValue(Ok(undefined)),
  markTranslationSkipped: vi.fn().mockResolvedValue(Ok(undefined)),
});

const makeSearchService = (): IMemorySearchService => ({
  search: vi.fn().mockResolvedValue([]),
  findSimilar: vi.fn().mockResolvedValue(None),
  findAuthoritativeCoverage: vi.fn().mockResolvedValue(None),
  findSupersedeCandidates: vi.fn().mockResolvedValue([]),
  listRecentByScope: vi.fn().mockResolvedValue([]),
});

const makeEntityRepository = (): IEntityRepository => ({
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
  findByNormalizedName: vi.fn().mockResolvedValue(None),
  findByMatchKey: vi.fn().mockResolvedValue(None),
  findContentAnchors: vi.fn().mockResolvedValue([]),
  linkMemory: vi.fn().mockResolvedValue(Ok(undefined)),
  list: vi.fn().mockResolvedValue([]),
  listForMemories: vi.fn().mockResolvedValue(new Map()),
});

const makeGraphService = (): IGraphService => ({
  createEdge: vi.fn().mockResolvedValue(Ok({ created: true })),
  linkMemories: vi.fn().mockResolvedValue(Ok({ created: true })),
  traverse: vi.fn().mockResolvedValue([]),
  neighborsOf: vi.fn().mockResolvedValue([]),
  buildContext: vi.fn().mockResolvedValue({
    memories: [],
    entities: [],
    edges: [],
    linked_memories: [],
  }),
});

const makeScopeAccess = (): IScopeAccessService => ({
  canWrite: vi.fn().mockResolvedValue(true),
  createScope: vi.fn().mockResolvedValue(Ok(undefined)),
});

const makeBindings = (): IProjectBindingRepository => ({
  findScope: vi.fn().mockResolvedValue(None),
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
});

const makeIngestLog = (
  seeded: string[] = []
): IIngestLogRepository & { hashes: Set<string> } => {
  const hashes = new Set<string>(seeded);
  return {
    hashes,
    insertIfAbsent: vi.fn().mockImplementation((entry: IngestLogEntry) => {
      const existed = hashes.has(entry.chunkHash);
      hashes.add(entry.chunkHash);
      return Promise.resolve(Ok({ existed }));
    }),
    exists: vi
      .fn()
      .mockImplementation((chunkHash: string) =>
        Promise.resolve(Ok(hashes.has(chunkHash)))
      ),
    markProcessed: vi.fn().mockResolvedValue(Ok(undefined)),
    release: vi.fn().mockImplementation((chunkHash: string) => {
      hashes.delete(chunkHash);
      return Promise.resolve(Ok(undefined));
    }),
  };
};

const makeService = (options?: {
  ingestLog?: IIngestLogRepository & { hashes: Set<string> };
  repository?: IMemoryRepository;
}) => {
  const embedding = new DeterministicHashEmbeddingService();
  const context = makeContext();
  const repository = options?.repository ?? makeRepository();
  const entityRepository = makeEntityRepository();
  const scopeAccess = makeScopeAccess();
  const entityResolution = new EntityResolutionService(
    entityRepository,
    embedding
  );
  const scopeRouting = new ScopeRoutingService(
    makeBindings(),
    scopeAccess,
    context
  );
  const memoryService = new MemoryService(
    repository,
    makeSearchService(),
    embedding,
    context,
    entityResolution,
    entityRepository,
    makeGraphService(),
    scopeAccess,
    scopeRouting,
    { translateToEnglish: vi.fn() }
  );
  const ingestLog = options?.ingestLog ?? makeIngestLog();
  const remember = vi.spyOn(memoryService, 'remember');
  const service = new ImportService(memoryService, scopeRouting, ingestLog);
  return { service, remember, ingestLog, repository };
};

const baseInput = (overrides?: Record<string, unknown>) => ({
  content: 'The owner prefers Bun over npm.',
  kind: 'preference' as const,
  target: 'personal' as const,
  source_tool: 'claude-code',
  source_path: '/home/u/.claude/projects/x/memory/a.md',
  source_hash: `hash-${Math.random().toString(36).slice(2)}`,
  ...overrides,
});

describe('ImportService', () => {
  it('is a no-op when the source hash was already imported', async () => {
    const input = baseInput();
    const ingestLog = makeIngestLog([input.source_hash]);
    const { service, remember } = makeService({ ingestLog });

    const result = await service.import(input);

    expect(result.unwrap()).toEqual({ skipped: true });
    expect(remember).not.toHaveBeenCalled();
  });

  it('imports a personal memory with source.kind=import provenance', async () => {
    const { service, remember } = makeService();

    const result = await service.import(baseInput());

    expect(result.unwrap().skipped).toBe(false);
    expect(result.unwrap().memory_id).toBeTruthy();
    const [inputArg, provenanceArg] = remember.mock.calls[0]!;
    expect(inputArg.scope).toBe(PERSONAL_SCOPE);
    expect(provenanceArg?.source).toMatchObject({
      kind: 'import',
      tool: 'claude-code',
      path: '/home/u/.claude/projects/x/memory/a.md',
    });
  });

  it('routes core and project targets to the right scope', async () => {
    const core = makeService();
    await core.service.import(
      baseInput({ target: 'core', source_hash: 'h-core' })
    );
    expect(core.remember.mock.calls[0]![0].scope).toBe(CORE_SCOPE);

    const project = makeService();
    await project.service.import(
      baseInput({
        target: 'project',
        project_hint: '/home/u/repos/alpha-import',
        source_hash: 'h-proj',
      })
    );
    expect(project.remember.mock.calls[0]![0].scope).toMatch(/^proj\./);
  });

  it('errors and releases the claim when target=project lacks a hint', async () => {
    const { service, ingestLog } = makeService();
    const input = baseInput({ target: 'project', source_hash: 'h-nohint' });

    const result = await service.import(input);

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('validation_failed');
    expect(result.unwrapErr().message).toMatch(/project_hint is required/);
    expect(ingestLog.hashes.has('h-nohint')).toBe(false); // released
  });

  it('releases the claim when the underlying write fails', async () => {
    const repository = makeRepository(Err('insert boom'));
    const ingestLog = makeIngestLog();
    const { service } = makeService({ repository, ingestLog });
    const input = baseInput({ source_hash: 'h-fail' });

    const result = await service.import(input);

    expect(result.isErr()).toBe(true);
    expect(ingestLog.hashes.has('h-fail')).toBe(false); // released for retry
  });
});
