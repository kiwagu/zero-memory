import type { IContext } from '@workspace/context';
import {
  CLIENT_SESSION_SOURCE_KEY,
  CORE_SCOPE,
  PERSONAL_SCOPE,
  THREAD_SOURCE_KEY,
  type EntityId,
  type MemoryId,
  type UserId,
} from '@workspace/contracts';
import { DeterministicHashEmbeddingService } from '@workspace/embedding/testing';
import { Err, None, Ok, Some, type Option } from 'oxide.ts';
import { describe, expect, it, vi } from 'vitest';

import { ANCHOR_HINT } from './entity-anchor.js';
import { EntityResolutionService } from './entity-resolution.service.js';
import { MemoryContent } from './memory-content.vo.js';
import { MemoryFragment } from './memory-fragment.do.js';
import { Provenance } from './provenance.vo.js';
import { Scope } from './scope.vo.js';
import type { ContentAnchor, IEntityRepository } from './entity.repository.js';
import type {
  IPortabilityJudge,
  PortabilityOpinion,
} from './portability-judge.js';
import type { ISessionThreadRepository } from './session-thread.repository.js';
import type { IGraphService } from './graph.service.js';
import type {
  IMemorySearchService,
  SimilarMemory,
  SimilarMemoryWithProvenance,
  SupersedeCandidateHit,
} from './memory-search.service.js';
import type { IMemoryRepository } from './memory.repository.js';
import { MemoryService } from './memory.service.js';
import type { IProjectBindingRepository } from './project-binding.repository.js';
import type { IProjectRulesReader } from './project-rules.reader.js';
import type { IScopeAccessService } from './scope-access.service.js';
import { ScopeRoutingService } from './scope-routing.service.js';
import type { ITranslator } from './translator.js';

const USER_ID = 'b7e6a1c2-3d4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ENTITY_ID = 'usr_000000000000000a.0000000000' as UserId;
const OTHER_USER_ENTITY_ID = 'usr_000000000000000b.0000000000' as UserId;
const MEMORY_A = 'mem_0000000000000001.0000000000' as MemoryId;
const MEMORY_B = 'mem_0000000000000002.0000000000' as MemoryId;
const ENTITY_PG = 'ent_0000000000000001.0000000000' as EntityId;

const contextStub: IContext = {
  setContextValue: () => undefined,
  mustGetCurrentUserId: () => USER_ID,
  getCurrentUserId: () => USER_ID,
  mustGetCurrentUserEntityId: () => USER_ENTITY_ID,
  getCurrentUserEntityId: () => USER_ENTITY_ID,
  getAccessToken: () => 'token',
  getScopes: () => [],
  getDefaultScope: () => undefined,
  getCurrentSessionId: () => undefined,
};

const makeRepository = (): IMemoryRepository => ({
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
  findOneById: vi.fn().mockResolvedValue(None),
  update: vi.fn().mockResolvedValue(Ok(undefined)),
  applyTranslation: vi.fn().mockResolvedValue(Ok(undefined)),
  markTranslationSkipped: vi.fn().mockResolvedValue(Ok(undefined)),
});

/** Fake translator: echoes English text back with a stub source language. */
const makeTranslator = (): ITranslator => ({
  translateToEnglish: vi
    .fn()
    .mockResolvedValue({ text: 'translated', sourceLang: 'ja' }),
});

const makeSearchService = (
  similar: Option<SimilarMemoryWithProvenance> = None,
  coverage: Option<SimilarMemory> = None,
  supersedeCandidates: SupersedeCandidateHit[] = []
): IMemorySearchService => ({
  search: vi.fn().mockResolvedValue([]),
  findSimilar: vi.fn().mockResolvedValue(similar),
  findAuthoritativeCoverage: vi.fn().mockResolvedValue(coverage),
  findSupersedeCandidates: vi.fn().mockResolvedValue(supersedeCandidates),
  listRecentByScope: vi.fn().mockResolvedValue([]),
});

const makeEntityRepository = (
  contentAnchors: ContentAnchor[] = []
): IEntityRepository => ({
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
  findByNormalizedName: vi.fn().mockResolvedValue(None),
  findByMatchKey: vi.fn().mockResolvedValue(None),
  findContentAnchors: vi.fn().mockResolvedValue(contentAnchors),
  linkMemory: vi.fn().mockResolvedValue(Ok(undefined)),
  list: vi.fn().mockResolvedValue([]),
  listForMemories: vi.fn().mockResolvedValue(new Map()),
});

const makeScopeAccess = (canWrite = true): IScopeAccessService => ({
  canWrite: vi.fn().mockResolvedValue(canWrite),
  createScope: vi.fn().mockResolvedValue(Ok(undefined)),
});

const makeProjectBindings = (): IProjectBindingRepository => ({
  findScope: vi.fn().mockResolvedValue(None),
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
});

/**
 * Portability-judge stub. Grants by default so a test opts INTO denial —
 * the interesting assertions are about what happens when leaving the project
 * is not confirmed.
 */
/** The token the session-thread stub hands back, asserted by the tests. */
const TEST_THREAD = 'thr_test0000000000.0000000000';

/**
 * Session-thread stub. `open` echoes a fixed token so a test can assert the
 * assertion reached the store; `findByToken` is empty by default so each test
 * opts into the inheritance path explicitly.
 */
const makeThreads = (): ISessionThreadRepository => ({
  open: vi
    .fn()
    .mockImplementation((conversationId: string, scope: Scope) =>
      Promise.resolve(Ok({ token: TEST_THREAD, conversationId, scope }))
    ),
  findByToken: vi.fn().mockResolvedValue(None),
  findByConversation: vi.fn().mockResolvedValue(None),
});

const makePortabilityJudge = (
  opinion: PortabilityOpinion = {
    portable: true,
    confidence: 0.95,
    rationale: '',
  }
): IPortabilityJudge => ({
  judgePortability: vi.fn().mockResolvedValue(opinion),
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
    open_loops: [],
    open_loops_total: 0,
  }),
});

const makeService = (overrides?: {
  repository?: IMemoryRepository;
  searchService?: IMemorySearchService;
  entityRepository?: IEntityRepository;
  graphService?: IGraphService;
  scopeAccess?: IScopeAccessService;
  projectBindings?: IProjectBindingRepository;
  translator?: ITranslator;
  context?: IContext;
  projectRules?: IProjectRulesReader;
  portabilityJudge?: IPortabilityJudge;
  threads?: ISessionThreadRepository;
}) => {
  const repository = overrides?.repository ?? makeRepository();
  const searchService = overrides?.searchService ?? makeSearchService();
  const entityRepository =
    overrides?.entityRepository ?? makeEntityRepository();
  const graphService = overrides?.graphService ?? makeGraphService();
  const scopeAccess = overrides?.scopeAccess ?? makeScopeAccess();
  const projectBindings = overrides?.projectBindings ?? makeProjectBindings();
  const translator = overrides?.translator ?? makeTranslator();
  const embeddingService = new DeterministicHashEmbeddingService();
  const context = overrides?.context ?? contextStub;
  const portabilityJudge =
    overrides?.portabilityJudge ?? makePortabilityJudge();
  const threads = overrides?.threads ?? makeThreads();
  const service = new MemoryService(
    repository,
    searchService,
    embeddingService,
    context,
    new EntityResolutionService(entityRepository, embeddingService),
    entityRepository,
    graphService,
    scopeAccess,
    new ScopeRoutingService(projectBindings, scopeAccess, context),
    translator,
    overrides?.projectRules,
    undefined,
    portabilityJudge,
    threads
  );
  return {
    service,
    repository,
    searchService,
    entityRepository,
    graphService,
    scopeAccess,
    projectBindings,
    translator,
    embeddingService,
    portabilityJudge,
    threads,
  };
};

describe('MemoryService.remember', () => {
  it('embeds, probes for duplicates, and inserts a new memory', async () => {
    const { service, repository, searchService } = makeService();

    const result = await service.remember({
      content: 'prefer bun over npm',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().deduplicated).toBeUndefined();
    expect(searchService.findSimilar).toHaveBeenCalledOnce();
    expect(repository.insert).toHaveBeenCalledOnce();

    const [fragment, vectors] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.scope.path).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}`
    );
    expect(fragment.visibility.level).toBe('private');
    expect(vectors.primary).toHaveLength(1024);
    // Short content fits the model's window whole, so the primary vector
    // missed nothing for an overflow window to carry.
    expect(vectors.overflow).toEqual([]);
  });

  it('covers content past the embedding window with overflow vectors', async () => {
    const { service, repository } = makeService();

    // Long enough to need SEVERAL windows, which is the point: coverage
    // follows the length instead of a fixed number of vectors.
    const result = await service.remember({
      content: `${'a decision with its reasoning, restated at length. '.repeat(200)}THE INSTRUCTION THAT SITS AT THE END`,
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    const [, vectors] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(vectors.primary).toHaveLength(1024);
    expect(vectors.overflow.length).toBeGreaterThan(2);
    for (const window of vectors.overflow) {
      expect(window.embedding).toHaveLength(1024);
    }
    // Each window states where it starts, so a reader can show the passage
    // that matched instead of the record's opening.
    const starts = vectors.overflow.map((window) => window.charStart);
    expect(starts[0]).toBeGreaterThan(0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('surfaces supersede candidates (similar_existing + hint) from the aperture probe', async () => {
    const candidate: SupersedeCandidateHit = {
      id: 'mem_00000000000000c1.0000000000' as MemoryId,
      content: 'y'.repeat(260),
      kind: 'gotcha',
      scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
      source: null,
      created_at: new Date(
        Date.now() - (3 * 86_400_000 + 60_000)
      ).toISOString(),
      similarity: 0.89,
    };
    const searchService = makeSearchService(None, None, [candidate]);
    const { service } = makeService({ searchService });

    const result = await service.remember({
      content: 'a fresh discovery',
      scope: PERSONAL_SCOPE,
    });
    const out = result.unwrap();

    expect(searchService.findSupersedeCandidates).toHaveBeenCalledOnce();
    // The aperture is a floor plus a rank cap: no upper bound is passed, so an
    // above-dedup neighbour from another session or scope stays visible.
    expect(searchService.findSupersedeCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ minSimilarity: 0.8 })
    );
    expect(
      vi.mocked(searchService.findSupersedeCandidates).mock.calls[0]?.[1]
    ).not.toHaveProperty('maxSimilarity');
    expect(out.similar_existing).toHaveLength(1);
    expect(out.similar_existing?.[0]).toMatchObject({
      id: candidate.id,
      kind: 'gotcha',
      age_days: 3,
      similarity: 0.89,
    });
    // Content is truncated to a recognisable preview, not a full read.
    expect(out.similar_existing?.[0]?.content).toHaveLength(200);
    expect(out.hint).toContain('supersedes');
  });

  it('caps supersede candidates at 10', async () => {
    const scope = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    const hits: SupersedeCandidateHit[] = Array.from(
      { length: 14 },
      (_, i) => ({
        id: `mem_00000000000000${(i + 1).toString().padStart(2, '0')}.0000000000` as MemoryId,
        content: `candidate ${i}`,
        kind: 'fact',
        scope,
        source: null,
        created_at: new Date().toISOString(),
        similarity: 0.95 - i * 0.005,
      })
    );
    const { service } = makeService({
      searchService: makeSearchService(None, None, hits),
    });

    const out = (
      await service.remember({
        content: 'many neighbours',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    expect(out.similar_existing).toHaveLength(10);
  });

  it('drops provably cross-project candidates before the cap', async () => {
    const owner = USER_ENTITY_ID.replace(/\./g, '_');
    const hits: SupersedeCandidateHit[] = [
      {
        id: 'mem_00000000000000d1.0000000000' as MemoryId,
        content: 'same project',
        kind: 'fact',
        scope: `proj.${owner}.quokka_tool`,
        source: null,
        created_at: new Date().toISOString(),
        similarity: 0.9,
      },
      {
        id: 'mem_00000000000000d2.0000000000' as MemoryId,
        content: 'other project',
        kind: 'fact',
        scope: `proj.${owner}.other_tool`,
        source: null,
        created_at: new Date().toISOString(),
        similarity: 0.89,
      },
    ];
    const { service } = makeService({
      searchService: makeSearchService(None, None, hits),
    });

    const out = (
      await service.remember({
        content: 'writes into the quokka project',
        project_hint: '/home/someone/repos/quokka-tool',
      })
    ).unwrap();

    expect(out.similar_existing).toHaveLength(1);
    expect(out.similar_existing?.[0]?.id).toBe(
      'mem_00000000000000d1.0000000000'
    );
  });

  it('never offers the row just written as its own supersede candidate', async () => {
    // The aperture has no upper bound and the probe runs after the insert, so
    // the new row is its own nearest neighbour at cosine 1.0.
    const repository = makeRepository();
    const searchService = makeSearchService();
    vi.mocked(searchService.findSupersedeCandidates).mockImplementation(() => {
      const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
      return Promise.resolve([
        {
          id: fragment.id as MemoryId,
          content: 'the row that was just written',
          kind: 'fact',
          scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
          source: null,
          created_at: new Date().toISOString(),
          similarity: 1,
        },
        {
          id: 'mem_00000000000000e1.0000000000' as MemoryId,
          content: 'a genuine predecessor',
          kind: 'fact',
          scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
          source: null,
          created_at: new Date().toISOString(),
          similarity: 0.93,
        },
      ] satisfies SupersedeCandidateHit[]);
    });
    const { service } = makeService({ repository, searchService });

    const out = (
      await service.remember({
        content: 'a fact worth keeping',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    expect(out.similar_existing).toHaveLength(1);
    expect(out.similar_existing?.[0]?.id).toBe(
      'mem_00000000000000e1.0000000000'
    );
  });

  it('keeps a same-owner PERSONAL candidate for a write into a project scope', async () => {
    // Canon spans the owner's personal (portable) layer and a project: only a
    // pair whose two sides resolve to DIFFERENT projects is excluded.
    const owner = USER_ENTITY_ID.replace(/\./g, '_');
    const hits: SupersedeCandidateHit[] = [
      {
        id: 'mem_00000000000000f1.0000000000' as MemoryId,
        content: 'operating truth kept in the portable layer',
        kind: 'decision',
        scope: `user.${owner}`,
        source: null,
        created_at: new Date().toISOString(),
        similarity: 0.9,
      },
    ];
    const { service } = makeService({
      searchService: makeSearchService(None, None, hits),
    });

    const out = (
      await service.remember({
        content: 'the operating truth changed',
        project_hint: '/home/someone/repos/quokka-tool',
      })
    ).unwrap();

    expect(out.similar_existing).toHaveLength(1);
    expect(out.similar_existing?.[0]?.id).toBe(
      'mem_00000000000000f1.0000000000'
    );
  });

  it('leaves the response unchanged when the aperture probe is empty', async () => {
    const { service } = makeService();

    const out = (
      await service.remember({
        content: 'no neighbours here',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    expect(out.similar_existing).toBeUndefined();
    expect(out.hint).toBeUndefined();
  });

  it('does not probe for supersede candidates on a provisional (watcher) write', async () => {
    const searchService = makeSearchService(None, None, [
      {
        id: 'mem_00000000000000e1.0000000000' as MemoryId,
        content: 'would-be candidate',
        kind: 'fact',
        scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
        source: null,
        created_at: new Date().toISOString(),
        similarity: 0.9,
      },
    ]);
    const { service } = makeService({ searchService });

    const out = (
      await service.remember(
        { content: 'a watcher-extracted fact', scope: PERSONAL_SCOPE },
        { agentName: 'watcher' }
      )
    ).unwrap();

    expect(searchService.findSupersedeCandidates).not.toHaveBeenCalled();
    expect(out.similar_existing).toBeUndefined();
  });

  it('resolves scope "core" to the personal core scope', async () => {
    const { service, repository } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
    });

    const result = await service.remember({
      content: 'bun loads .env only from the cwd',
      scope: 'core',
    });

    expect(result.isOk()).toBe(true);
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.scope.path).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}.core`
    );
  });

  it('refuses a scope-less write when the session has no project attached', async () => {
    const { service, repository } = makeService();

    const result = await service.remember({
      content: 'a scope-less write in an unattached session',
    });

    expect(result.isErr()).toBe(true);
    const failure = result.unwrapErr();
    expect(failure.code).toBe('validation_failed');
    // The refusal must be actionable: every route out is named, so the retry
    // needs no guesswork.
    expect(failure.message).toContain('project_hint');
    expect(failure.message).toContain('"core"');
    expect(failure.message).toContain('"personal"');
    // Nothing was stored anywhere — the point of refusing over falling back.
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('stamps an explicit personal write as deliberate, not as a fallback', async () => {
    const { service, repository } = makeService();

    const result = await service.remember({
      content: 'the owner works from Vilnius',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.scope.path).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}`
    );
    expect(fragment.provenance.source).toMatchObject({
      routing: { via: 'personal', confidence: 1 },
    });
  });

  it('refuses a project_hint that does not resolve to a project scope', async () => {
    const { service, repository } = makeService();

    const result = await service.remember({
      content: 'a fact aimed at an unroutable hint',
      project_hint: '   ',
    });

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('validation_failed');
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('stamps hint-routed writes with the hint confidence', async () => {
    const { service, repository } = makeService();

    const result = await service.remember({
      content: 'a hint-routed write',
      project_hint: '/home/someone/repos/quokka-tool',
    });

    expect(result.isOk()).toBe(true);
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).toMatchObject({
      routing: { via: 'hint', confidence: 0.95 },
    });
  });

  it('routes a project_hint through project bindings and reports the scope', async () => {
    const { service, repository, projectBindings } = makeService();

    const result = await service.remember({
      content: 'the quokka importer batches uploads in groups of 50',
      project_hint: '/home/someone/repos/quokka-tool',
    });

    expect(result.isOk()).toBe(true);
    const expectedScope = `proj.${USER_ENTITY_ID.replace(/\./g, '_')}.quokka_tool`;
    expect(result.unwrap().scope).toBe(expectedScope);
    expect(projectBindings.findScope).toHaveBeenCalledOnce();
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.scope.path).toBe(expectedScope);
  });

  it('lets an explicit scope win over a project_hint', async () => {
    const { service, projectBindings } = makeService();

    const result = await service.remember({
      content: 'bun compiled binaries dispatch subcommands on argv[2]',
      scope: 'core',
      project_hint: '/home/someone/repos/quokka-tool',
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}.core`
    );
    expect(projectBindings.findScope).not.toHaveBeenCalled();
  });

  it('preserves the verbatim idiom anchor in provenance source', async () => {
    const { service, repository } = makeService();

    await service.remember({
      content: 'the user prefers single-line commit messages',
      verbatim: '一行コミット、本文なし',
      scope: PERSONAL_SCOPE,
    });

    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).toMatchObject({
      verbatim: '一行コミット、本文なし',
    });
  });

  it('stamps the MCP session id into provenance source', async () => {
    const { service, repository } = makeService({
      context: {
        ...contextStub,
        getCurrentSessionId: () => 'ses_000000000000000a.0000000000',
      },
    });

    await service.remember({
      content: 'prefer bun over npm',
      verbatim: 'npmの代わりにbun',
      scope: PERSONAL_SCOPE,
    });

    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).toMatchObject({
      verbatim: 'npmの代わりにbun',
      session: 'ses_000000000000000a.0000000000',
    });
  });

  it('always carries the routing stamp, even outside a transport session', async () => {
    const { service, repository } = makeService();

    await service.remember({
      content: 'prefer bun over npm',
      scope: PERSONAL_SCOPE,
    });

    // The source is never null since the routing audit: every write records
    // HOW its scope was decided.
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).toEqual({
      routing: { via: 'personal', confidence: 1 },
    });
  });

  it('stores English content as canonical, no translation triggered', async () => {
    const { service, repository, translator } = makeService();

    await service.remember({
      content: 'prefer bun over npm',
      scope: PERSONAL_SCOPE,
    });

    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.translation.status).toBe('skipped');
    expect(fragment.translation.originalText).toBeNull();
    expect(translator.translateToEnglish).not.toHaveBeenCalled();
  });

  it('inserts non-English as pending, then canonicalizes it in the background', async () => {
    const { service, repository, translator } = makeService();

    await service.remember({
      content: '短いcommitメッセージ',
      scope: PERSONAL_SCOPE,
    });

    // Stored immediately in the original language, marked pending — the write
    // does not block on the model.
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.translation.status).toBe('pending');
    expect(fragment.content.content).toBe('短いcommitメッセージ');

    // The write-triggered background task canonicalizes it (fire-and-forget).
    await vi.waitFor(() => {
      expect(translator.translateToEnglish).toHaveBeenCalledWith(
        '短いcommitメッセージ'
      );
      expect(repository.applyTranslation).toHaveBeenCalledOnce();
    });
    const [, params] = vi.mocked(repository.applyTranslation).mock.calls[0]!;
    expect(params.content).toBe('translated');
    expect(params.contentOriginal).toBe('短いcommitメッセージ');
    expect(params.contentLang).toBe('ja');
  });

  it('skips (no content_original) when the source turns out to be English', async () => {
    // The cheap write-path detector fired on a stray non-Latin char, but the
    // translator judges the source already English — no meaningful original to
    // keep, so the row is marked skipped rather than stamped "Original (en)".
    const translator: ITranslator = {
      translateToEnglish: vi
        .fn()
        .mockResolvedValue({ text: 'move a card', sourceLang: 'en' }),
    };
    const { service, repository } = makeService({ translator });

    await service.remember({
      content: 'move a card (移動)',
      scope: PERSONAL_SCOPE,
    });

    await vi.waitFor(() => {
      expect(repository.markTranslationSkipped).toHaveBeenCalledOnce();
    });
    expect(repository.applyTranslation).not.toHaveBeenCalled();
  });

  it('skips a no-op translation (text unchanged) even for a foreign source_lang', async () => {
    // English prose around a quoted foreign idiom: the detector flags the
    // non-Latin, but the translator keeps the quote verbatim and returns the
    // text unchanged with source_lang 'ja'. Storing it would leave a same-text
    // "Original (ja)" — mark skipped instead of persisting a no-op original.
    const unchanged = "call it a '完全な修正' (proper fix)";
    const translator: ITranslator = {
      translateToEnglish: vi
        .fn()
        .mockResolvedValue({ text: unchanged, sourceLang: 'ja' }),
    };
    const { service, repository } = makeService({ translator });

    await service.remember({ content: unchanged, scope: PERSONAL_SCOPE });

    await vi.waitFor(() => {
      expect(repository.markTranslationSkipped).toHaveBeenCalledOnce();
    });
    expect(repository.applyTranslation).not.toHaveBeenCalled();
  });

  it('swallows an EXACT duplicate (identical text) without inserting', async () => {
    const searchService = makeSearchService(
      Some({
        id: 'mem_000000000000000e.0000000000' as MemoryId,
        content: 'prefer bun over npm',
        similarity: 0.99,
        author_kind: 'agent',
        agent_name: null,
        source: null,
      })
    );
    const { service, repository } = makeService({ searchService });

    const result = await service.remember({
      content: 'prefer bun over npm',
      scope: PERSONAL_SCOPE,
    });

    expect(result.unwrap()).toEqual({
      memory_id: 'mem_000000000000000e.0000000000',
      deduplicated: true,
      scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('does NOT swallow a near-duplicate at equal authority — writes so hygiene can judge (closes the contradiction blind spot)', async () => {
    const searchService = makeSearchService(
      Some({
        id: 'mem_000000000000000e.0000000000' as MemoryId,
        content: 'the widget is blue',
        similarity: 0.94,
        author_kind: 'agent',
        agent_name: null,
        source: null,
      })
    );
    const { service, repository } = makeService({ searchService });

    // High similarity, opposite meaning — must NOT be silently absorbed.
    const result = await service.remember({
      content: 'the widget is green',
      scope: PERSONAL_SCOPE,
    });

    expect(result.unwrap().deduplicated).toBeUndefined();
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('a provisional (watcher) write defers to a same-scope authoritative near-match', async () => {
    const searchService = makeSearchService(
      Some({
        id: 'mem_00000000000000a0.0000000000' as MemoryId,
        content: 'the authoritative version',
        similarity: 0.94,
        author_kind: 'agent',
        agent_name: null,
        source: null,
      }),
      None // no owner-wide coverage, so the cascade decides
    );
    const { service, repository } = makeService({ searchService });

    const result = await service.remember(
      { content: 'a watcher paraphrase of it', scope: PERSONAL_SCOPE },
      { agentName: 'watcher' }
    );

    expect(result.unwrap()).toEqual({
      memory_id: 'mem_00000000000000a0.0000000000',
      deduplicated: true,
      scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('does NOT swallow an in-band agent write near a HUMAN memory — rank alone may not discard authoritative knowledge', async () => {
    const searchService = makeSearchService(
      Some({
        id: 'mem_00000000000000b0.0000000000' as MemoryId,
        content: 'the deploy script lives in scripts/deploy.sh',
        similarity: 0.94,
        author_kind: 'human',
        agent_name: null,
        source: null,
      })
    );
    const { service, repository } = makeService({ searchService });

    // Lower rank than the human memory (1 vs 2), but authoritative — and a
    // near-match at this similarity is as likely to be a CORRECTION as a
    // restatement. Swallowing it would discard the correction with nobody
    // ever seeing the pair.
    const result = await service.remember({
      content: 'the deploy script moved to scripts/ship.sh',
      scope: PERSONAL_SCOPE,
    });

    expect(result.unwrap().deduplicated).toBeUndefined();
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('defers a provisional (watcher) write to an authoritative memory that covers it', async () => {
    const searchService = makeSearchService(
      None,
      Some({
        id: 'mem_00000000000000c0.0000000000' as MemoryId,
        content: 'the authoritative version',
        similarity: 0.88,
      })
    );
    const { service, repository } = makeService({ searchService });

    const result = await service.remember(
      { content: 'watcher paraphrase of the same fact', scope: PERSONAL_SCOPE },
      { agentName: 'watcher' }
    );

    expect(result.unwrap()).toEqual({
      memory_id: 'mem_00000000000000c0.0000000000',
      deduplicated: true,
      scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
    });
    expect(repository.insert).not.toHaveBeenCalled();
    expect(searchService.findAuthoritativeCoverage).toHaveBeenCalledOnce();
  });

  it('does NOT run the coverage probe for an authoritative in-band write', async () => {
    const { service, repository, searchService } = makeService();

    const result = await service.remember({
      content: 'an in-band fact',
      scope: PERSONAL_SCOPE,
    });

    expect(result.unwrap().deduplicated).toBeUndefined();
    expect(searchService.findAuthoritativeCoverage).not.toHaveBeenCalled();
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('rejects a secret in content BEFORE the embedder and translator see it', async () => {
    const { service, repository, translator, embeddingService } = makeService();
    const embedSpy = vi.spyOn(embeddingService, 'embed');

    const result = await service.remember({
      content: 'ci deploys with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isErr()).toBe(true);
    // A rejection the caller fixes by rewording — never `internal`, which
    // would read as a server fault and invite a retry of the same content.
    expect(result.unwrapErr().code).toBe('validation_failed');
    expect(result.unwrapErr().message).toContain('secret_content_rejected');
    expect(result.unwrapErr().message).not.toContain(
      'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    );
    // The secret must not reach any external consumer or the table.
    expect(embedSpy).not.toHaveBeenCalled();
    expect(translator.translateToEnglish).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('rejects a secret riding in verbatim or provenance source', async () => {
    const { service, repository, embeddingService } = makeService();
    const embedSpy = vi.spyOn(embeddingService, 'embed');

    const viaVerbatim = await service.remember({
      content: 'the deploy token was rotated today',
      verbatim: 'トークン xoxb-1234567890-abcdefghij は失効済み',
      scope: PERSONAL_SCOPE,
    });
    expect(viaVerbatim.isErr()).toBe(true);
    expect(viaVerbatim.unwrapErr().code).toBe('validation_failed');
    expect(viaVerbatim.unwrapErr().message).toContain(
      'secret_content_rejected'
    );

    const viaSource = await service.remember(
      { content: 'imported from a notes file', scope: PERSONAL_SCOPE },
      {
        agentName: 'watcher',
        source: { dsn: 'postgres://zm:sup3rs3cret@db.internal/zm' },
      }
    );
    expect(viaSource.isErr()).toBe(true);
    expect(viaSource.unwrapErr().code).toBe('validation_failed');
    expect(viaSource.unwrapErr().message).toContain('secret_content_rejected');

    expect(embedSpy).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('fails on an invalid scope without touching any port', async () => {
    const { service, repository, searchService } = makeService();

    const result = await service.remember({
      content: 'x',
      scope: 'Not-A-Scope',
    });

    expect(result.isErr()).toBe(true);
    expect(searchService.findSimilar).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('resolves explicit entity mentions and links them to the memory', async () => {
    const { service, repository, entityRepository } = makeService();

    const result = await service.remember({
      content: 'project alpha uses postgres for storage',
      entities: [
        { name: 'alpha', type: 'project' },
        { name: 'postgres', type: 'service' },
      ],
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    const memoryId = result.unwrap().memory_id;
    // Both mentions resolved to new entities (the stub store is empty) ...
    expect(entityRepository.insert).toHaveBeenCalledTimes(2);
    // ... and both got a memory_entities row for the inserted memory.
    const linkCalls = vi.mocked(entityRepository.linkMemory).mock.calls;
    expect(linkCalls).toHaveLength(2);
    for (const [linkedMemoryId] of linkCalls) {
      expect(linkedMemoryId).toBe(memoryId);
    }
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('records explicit memory links, and only explicit ones', async () => {
    const { service, graphService } = makeService();

    const result = await service.remember({
      content: 'the utc decision derives from the timezone incident',
      links: [{ dst: MEMORY_B, type: 'derived_from' }],
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(graphService.linkMemories).toHaveBeenCalledExactlyOnceWith(
      result.unwrap().memory_id,
      MEMORY_B,
      'derived_from'
    );
    expect(graphService.createEdge).not.toHaveBeenCalled();
  });
});

describe('MemoryService.recall', () => {
  it('embeds the query and forwards filters to the search port', async () => {
    const { service, searchService } = makeService();

    const result = await service.recall({
      query: 'bun gotchas',
      scopes: ['proj.zero_memory'],
      kinds: ['gotcha'],
      k: 5,
    });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.queryText).toBe('bun gotchas');
    expect(params.queryEmbedding).toHaveLength(1024);
    // A legacy 2-label scope name canonicalizes to the caller's own
    // per-owner generation.
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      'proj.usr_000000000000000a_0000000000.zero_memory',
    ]);
    expect(params.kinds).toEqual(['gotcha']);
    expect(params.k).toBe(5);
  });

  it('isolates the default read set to project + personal + core scopes', async () => {
    const { service, searchService } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
    });

    const result = await service.recall({ query: 'bun gotchas' });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      'proj.usr_000000000000000a_0000000000.zero_memory',
      personal,
      `${personal}.core`,
    ]);
  });

  it('searches all visible scopes when scopes includes "*"', async () => {
    const { service, searchService } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
    });

    const result = await service.recall({
      query: 'bun gotchas',
      scopes: ['*'],
    });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.scopes).toBeUndefined();
  });

  it('pins the default read set from a project_hint when the session has no default', async () => {
    const { service, searchService, projectBindings } = makeService();

    const result = await service.recall({
      query: 'importer batching',
      project_hint: '/home/someone/repos/quokka-tool',
    });

    expect(result.isOk()).toBe(true);
    expect(projectBindings.findScope).toHaveBeenCalledOnce();
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      `proj.${USER_ENTITY_ID.replace(/\./g, '_')}.quokka_tool`,
      personal,
      `${personal}.core`,
    ]);
  });

  it('ignores the project_hint when explicit scopes are passed', async () => {
    const { service, searchService, projectBindings } = makeService();

    const result = await service.recall({
      query: 'bun gotchas',
      scopes: ['*'],
      project_hint: '/home/someone/repos/quokka-tool',
    });

    expect(result.isOk()).toBe(true);
    expect(projectBindings.findScope).not.toHaveBeenCalled();
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.scopes).toBeUndefined();
  });

  it('degrades (not narrows) when the project_hint falls back to personal', async () => {
    const { service, searchService } = makeService();

    // "/" normalizes to no usable slug -> routing falls back to the personal
    // scope; pinning reads to [user, core] would NARROW below the no-hint
    // behavior, so the read must degrade to all visible scopes instead.
    const result = await service.recall({
      query: 'bun gotchas',
      project_hint: '/',
    });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.scopes).toBeUndefined();
  });

  it('degrades to all visible scopes when the session has no project', async () => {
    const { service, searchService } = makeService();

    const result = await service.recall({ query: 'bun gotchas' });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.scopes).toBeUndefined();
  });

  it('resolves the "core" shorthand inside explicit scopes', async () => {
    const { service, searchService } = makeService();

    const result = await service.recall({
      query: 'bun gotchas',
      scopes: ['core'],
    });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}.core`,
    ]);
  });

  it('resolves the "personal" shorthand inside explicit scopes', async () => {
    const { service, searchService } = makeService();

    // A caller composing a read set (the ROI benchmark pinning a probe to
    // its source project) never derives the ltree-flattened owner label —
    // the shorthand resolves server-side, symmetric with "core".
    const result = await service.recall({
      query: 'bun gotchas',
      scopes: ['proj.zero_memory', 'personal', 'core'],
    });

    expect(result.isOk()).toBe(true);
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      'proj.usr_000000000000000a_0000000000.zero_memory',
      personal,
      `${personal}.core`,
    ]);
  });

  it('searches a non-English query exactly as it arrived', async () => {
    const { service, searchService, translator, embeddingService } =
      makeService();
    const embed = vi.spyOn(embeddingService, 'embed');

    const result = await service.recall({
      query: 'ウォッチャーのポートを固定する',
    });

    expect(result.isOk()).toBe(true);
    // The server has no opinion about the query's language: the same string
    // reaches the embedder and both search legs, so the activity log can show
    // it without qualification.
    expect(translator.translateToEnglish).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledWith(
      ['ウォッチャーのポートを固定する'],
      'query'
    );
    const params = vi.mocked(searchService.search).mock.calls[0]![0];
    expect(params.queryText).toBe('ウォッチャーのポートを固定する');
  });

  it('enriches hits with their entities when include_graph is set', async () => {
    const hit = {
      id: MEMORY_A,
      content: 'alpha uses postgres',
      kind: 'fact' as const,
      scope: 'proj.alpha',
      visibility: 'private' as const,
      created_at: '2026-07-03T00:00:00Z',
      score: 0.5,
      disputed: false,
      dispute_id: null,
      dispute_with: null,
      similarity: 0.9,
      fts_matched: false,
      stale_days: null,
    };
    const searchService = makeSearchService();
    vi.mocked(searchService.search).mockResolvedValue([hit]);
    const entityRepository = makeEntityRepository();
    const mention = {
      id: ENTITY_PG,
      name: 'postgres',
      type: 'service' as const,
    };
    vi.mocked(entityRepository.listForMemories).mockResolvedValue(
      new Map([[MEMORY_A, [mention]]])
    );
    const { service } = makeService({ searchService, entityRepository });

    const result = await service.recall({
      query: 'alpha storage',
      include_graph: true,
    });

    expect(result.unwrap().memories).toEqual([{ ...hit, entities: [mention] }]);
    expect(entityRepository.listForMemories).toHaveBeenCalledExactlyOnceWith([
      MEMORY_A,
    ]);
  });
});

describe('MemoryService.link', () => {
  it('links two memory uuids through memory_links', async () => {
    const { service, graphService } = makeService();

    const result = await service.link({
      src: MEMORY_A,
      dst: MEMORY_B,
      type: 'supersedes',
    });

    expect(result.unwrap()).toEqual({
      kind: 'memory_link',
      src_id: MEMORY_A,
      dst_id: MEMORY_B,
      type: 'supersedes',
      created: true,
    });
    expect(graphService.createEdge).not.toHaveBeenCalled();
  });

  it('resolves two entity names and creates an edge', async () => {
    const { service, graphService, entityRepository } = makeService();

    const result = await service.link({
      src: 'alpha',
      dst: 'postgres',
      type: 'uses',
    });

    const output = result.unwrap();
    expect(output.kind).toBe('entity_edge');
    expect(output.created).toBe(true);
    expect(entityRepository.insert).toHaveBeenCalledTimes(2);
    const [edge] = vi.mocked(graphService.createEdge).mock.calls[0]!;
    expect(edge.type.value).toBe('uses');
    expect(edge.scope.path).toBe(`user.${USER_ENTITY_ID.replace(/\./g, '_')}`);
  });

  it('rejects mixed endpoints and wrong type vocabularies', async () => {
    const { service, graphService } = makeService();

    const mixed = await service.link({
      src: MEMORY_A,
      dst: 'postgres',
      type: 'relates_to',
    });
    expect(mixed.isErr()).toBe(true);

    // supersedes is a memory-link type, not an edge type.
    const wrongEdgeType = await service.link({
      src: 'alpha',
      dst: 'postgres',
      type: 'supersedes',
    });
    expect(wrongEdgeType.isErr()).toBe(true);

    // uses is an edge type, not a memory-link type.
    const wrongLinkType = await service.link({
      src: MEMORY_A,
      dst: MEMORY_B,
      type: 'uses',
    });
    expect(wrongLinkType.isErr()).toBe(true);

    expect(graphService.createEdge).not.toHaveBeenCalled();
    expect(graphService.linkMemories).not.toHaveBeenCalled();
  });
});

describe('MemoryService.buildContext', () => {
  it('embeds the topic and maps max_tokens to row budgets', async () => {
    const { service, graphService } = makeService();

    const result = await service.buildContext({
      topic: 'project alpha',
      max_tokens: 2400,
    });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    expect(params.topicText).toBe('project alpha');
    expect(params.topicEmbedding).toHaveLength(1024);
    expect(params.maxMemories).toBe(12);
    expect(params.maxEntities).toBe(8);
  });

  it('briefs on a non-English topic exactly as it arrived', async () => {
    const { service, graphService, translator } = makeService();

    const result = await service.buildContext({
      topic: 'ウォッチャーのポートを固定する',
    });

    expect(result.isOk()).toBe(true);
    expect(translator.translateToEnglish).not.toHaveBeenCalled();
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    expect(params.topicText).toBe('ウォッチャーのポートを固定する');
  });

  it('briefs from the isolated read set when the session has a project', async () => {
    const { service, graphService } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
    });

    const result = await service.buildContext({ topic: 'project alpha' });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      'proj.usr_000000000000000a_0000000000.zero_memory',
      personal,
      `${personal}.core`,
    ]);
  });

  it('briefs across all visible scopes on the "*" sentinel', async () => {
    const { service, graphService } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
    });

    const result = await service.buildContext({
      topic: 'project alpha',
      scopes: ['*'],
    });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    expect(params.scopes).toBeUndefined();
  });

  it('narrows an unattached hint-less BRIEFING to personal + core', async () => {
    const { service, graphService } = makeService();

    // No session project, no hint: a briefing must not assemble the pack
    // from every visible scope — the working context of an unknown project
    // is a guess. Point reads keep the wide degrade (covered in the recall
    // suite).
    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
    });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      personal,
      `${personal}.core`,
    ]);
  });

  it('honors the "*" sentinel even on an unattached briefing', async () => {
    const { service, graphService } = makeService();

    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      scopes: ['*'],
    });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    expect(params.scopes).toBeUndefined();
  });

  it('keeps the wide degrade for an unattached NON-briefing call', async () => {
    const { service, graphService } = makeService();

    const result = await service.buildContext({ topic: 'project alpha' });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    expect(params.scopes).toBeUndefined();
  });

  it('pins the briefing from a project_hint and reports project_scope', async () => {
    const { service, graphService } = makeService();

    const result = await service.buildContext({
      topic: 'quokka importer',
      project_hint: '/home/someone/repos/quokka-tool',
    });

    expect(result.isOk()).toBe(true);
    const expectedScope = `proj.${USER_ENTITY_ID.replace(/\./g, '_')}.quokka_tool`;
    expect(result.unwrap().project_scope).toBe(expectedScope);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      expectedScope,
      personal,
      `${personal}.core`,
    ]);
  });

  it('reports no project_scope when the briefing ran unpinned', async () => {
    const { service } = makeService();

    const result = await service.buildContext({ topic: 'project alpha' });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().project_scope).toBeUndefined();
  });
});

describe('MemoryService.forget', () => {
  it('errs when the memory does not exist', async () => {
    const { service } = makeService();
    const result = await service.forget({
      memory_id: 'mem_000000000000000f.0000000000' as MemoryId,
    });
    expect(result.isErr()).toBe(true);
  });
});

describe('MemoryService.closeLoop', () => {
  const makeFragment = (kind: string) =>
    MemoryFragment.create({
      content: MemoryContent.create(
        'check the watcher log on machine B — /share/zm/watcher.log',
        kind
      ).unwrap(),
      scope: Scope.user(USER_ENTITY_ID),
      provenance: Provenance.create({ ownerId: USER_ENTITY_ID }),
    }).unwrap();

  it.each(['task', 'open-question'])(
    'closes a %s loop: invalidates and persists',
    async (kind) => {
      const repository = makeRepository();
      const fragment = makeFragment(kind);
      vi.mocked(repository.findOneById).mockResolvedValue(Some(fragment));
      const { service } = makeService({ repository });

      const result = await service.closeLoop({ memory_id: fragment.id });

      expect(result.unwrap()).toEqual({
        memory_id: fragment.id,
        closed: true,
      });
      expect(repository.update).toHaveBeenCalledExactlyOnceWith(fragment);
      expect(fragment.lifecycle.isInvalidated).toBe(true);
      expect(fragment.lifecycle.invalidatedBy).toBe(USER_ENTITY_ID);
    }
  );

  it('refuses a non-loop kind (use forget for regular memories)', async () => {
    const repository = makeRepository();
    const fragment = makeFragment('decision');
    vi.mocked(repository.findOneById).mockResolvedValue(Some(fragment));
    const { service } = makeService({ repository });

    const result = await service.closeLoop({ memory_id: fragment.id });

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('validation_failed');
    expect(result.unwrapErr().message).toContain('not an open loop');
    expect(repository.update).not.toHaveBeenCalled();
    expect(fragment.lifecycle.isInvalidated).toBe(false);
  });

  it('errs on an already-closed loop instead of double-closing', async () => {
    const repository = makeRepository();
    const fragment = makeFragment('task');
    fragment.invalidate(USER_ENTITY_ID);
    vi.mocked(repository.findOneById).mockResolvedValue(Some(fragment));
    const { service } = makeService({ repository });

    const result = await service.closeLoop({ memory_id: fragment.id });

    expect(result.isErr()).toBe(true);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('errs when the memory does not exist', async () => {
    const { service } = makeService();
    const result = await service.closeLoop({
      memory_id: 'mem_000000000000000f.0000000000' as MemoryId,
    });
    expect(result.isErr()).toBe(true);
  });
});

describe('MemoryService.share', () => {
  const makeOwnedFragment = (ownerId: UserId = USER_ENTITY_ID) =>
    MemoryFragment.create({
      content: MemoryContent.create(
        'the team prefers bun',
        'preference'
      ).unwrap(),
      scope: Scope.user(ownerId),
      provenance: Provenance.create({ ownerId }),
    }).unwrap();

  it('widens an owned memory into a writable scope and persists it', async () => {
    const repository = makeRepository();
    const fragment = makeOwnedFragment();
    vi.mocked(repository.findOneById).mockResolvedValue(Some(fragment));
    const { service, scopeAccess } = makeService({ repository });

    const result = await service.share({
      memory_id: fragment.id,
      scope: 'proj.alpha',
    });

    const canonical = 'proj.usr_000000000000000a_0000000000.alpha';
    expect(result.unwrap()).toEqual({
      memory_id: fragment.id,
      scope: canonical,
      shared: true,
    });
    // Once for the canonical-scope bootstrap probe, once for the share gate.
    expect(scopeAccess.canWrite).toHaveBeenCalledTimes(2);
    expect(repository.update).toHaveBeenCalledExactlyOnceWith(fragment);
    expect(fragment.visibility.level).toBe('shared');
    expect(fragment.scope.path).toBe(canonical);
    expect(fragment.lifecycle.sharedBy).toBe(USER_ENTITY_ID);
  });

  it('fails closed when the scope is not writable, before loading anything', async () => {
    const repository = makeRepository();
    const { service } = makeService({
      repository,
      scopeAccess: makeScopeAccess(false),
    });

    const result = await service.share({
      memory_id: MEMORY_A,
      scope: 'proj.alpha',
    });

    expect(result.isErr()).toBe(true);
    expect(repository.findOneById).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses to share a memory the user does not own', async () => {
    const repository = makeRepository();
    const fragment = makeOwnedFragment(OTHER_USER_ENTITY_ID);
    vi.mocked(repository.findOneById).mockResolvedValue(Some(fragment));
    const { service } = makeService({ repository });

    const result = await service.share({
      memory_id: fragment.id,
      scope: 'proj.alpha',
    });

    expect(result.isErr()).toBe(true);
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('MemoryService.remember — declared supersede (write-side)', () => {
  const makeOldFragment = (ownerId: UserId = USER_ENTITY_ID) =>
    MemoryFragment.create({
      content: MemoryContent.create(
        'deploy window is Monday',
        'decision'
      ).unwrap(),
      scope: Scope.user(ownerId),
      provenance: Provenance.create({ ownerId }),
    }).unwrap();

  it('retires an owned live target: superseded_by = the new memory, persisted', async () => {
    const repository = makeRepository();
    const old = makeOldFragment();
    vi.mocked(repository.findOneById).mockResolvedValue(Some(old));
    const { service } = makeService({ repository });

    const result = await service.remember({
      content: 'deploy window moved to Friday',
      links: [{ dst: old.id, type: 'supersedes' }],
      scope: PERSONAL_SCOPE,
    });

    const newId = result.unwrap().memory_id;
    expect(repository.findOneById).toHaveBeenCalledWith(old.id);
    expect(repository.update).toHaveBeenCalledExactlyOnceWith(old);
    expect(old.lifecycle.isInvalidated).toBe(true);
    expect(old.lifecycle.supersededBy).toBe(newId);
    expect(old.lifecycle.invalidatedBy).toBe(USER_ENTITY_ID);
  });

  it('skips a foreign target without failing the write', async () => {
    const repository = makeRepository();
    const foreign = makeOldFragment(OTHER_USER_ENTITY_ID);
    vi.mocked(repository.findOneById).mockResolvedValue(Some(foreign));
    const { service } = makeService({ repository });

    const result = await service.remember({
      content: 'a new fact naming a memory that is not ours',
      links: [{ dst: foreign.id, type: 'supersedes' }],
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(repository.update).not.toHaveBeenCalled();
    expect(foreign.lifecycle.isInvalidated).toBe(false);
  });

  it('skips a missing target and an already-invalidated one', async () => {
    const repository = makeRepository();
    const dead = makeOldFragment();
    dead.invalidate(USER_ENTITY_ID);
    vi.mocked(repository.findOneById)
      .mockResolvedValueOnce(None)
      .mockResolvedValueOnce(Some(dead));
    const { service } = makeService({ repository });

    const result = await service.remember({
      content: 'successor naming a missing and a dead target',
      links: [
        { dst: MEMORY_A, type: 'supersedes' },
        { dst: MEMORY_B, type: 'supersedes' },
      ],
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(repository.update).not.toHaveBeenCalled();
    expect(dead.lifecycle.supersededBy).toBeNull();
  });

  it('a provisional watcher write never applies a declared supersede', async () => {
    const repository = makeRepository();
    const { service } = makeService({ repository });

    const result = await service.remember(
      {
        content: 'watcher extraction naming an old memory',
        links: [{ dst: MEMORY_A, type: 'supersedes' }],
        scope: PERSONAL_SCOPE,
      },
      { agentName: 'watcher' }
    );

    expect(result.isOk()).toBe(true);
    expect(repository.findOneById).not.toHaveBeenCalled();
  });

  it('caps declared targets so one call cannot mass-retire a store', async () => {
    const repository = makeRepository();
    const { service } = makeService({ repository });
    const links = Array.from({ length: 12 }, (_, index) => ({
      dst: `mem_00000000000000${(index + 16).toString(16)}.0000000000` as MemoryId,
      type: 'supersedes' as const,
    }));

    const result = await service.remember({
      content: 'mass update',
      links,
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(repository.findOneById).toHaveBeenCalledTimes(10);
  });
});

describe('MemoryService.remember — same-session refinement collapse', () => {
  const SESSION = 'ses_000000000000000a.0000000000';
  const OTHER_SESSION = 'ses_000000000000000b.0000000000';
  const sessionContext: IContext = {
    ...contextStub,
    getCurrentSessionId: () => SESSION,
  };
  const makeOldFragment = (source: Record<string, unknown> | null) =>
    MemoryFragment.create({
      content: MemoryContent.create(
        'commit messages are single-line',
        'convention'
      ).unwrap(),
      scope: Scope.user(USER_ENTITY_ID),
      provenance: Provenance.create({ ownerId: USER_ENTITY_ID, source }),
    }).unwrap();

  it('a same-session neighbour below the collapse line stays a hint', async () => {
    // One session routinely stores several related-but-distinct facts about
    // one topic, and they are near neighbours of each other, so only a
    // near-verbatim restatement (>= 0.95) auto-collapses.
    const repository = makeRepository();
    const hit: SupersedeCandidateHit = {
      id: MEMORY_A,
      content: 'commit messages are single-line',
      kind: 'convention',
      scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
      source: { session: SESSION },
      created_at: new Date().toISOString(),
      similarity: 0.9,
    };
    const { service } = makeService({
      repository,
      searchService: makeSearchService(None, None, [hit]),
      context: sessionContext,
    });

    const out = (
      await service.remember({
        content: 'commit messages: strictly one line, no body',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    expect(out.similar_existing).toHaveLength(1);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('collapses a same-session near-verbatim restatement (>= 0.95)', async () => {
    const repository = makeRepository();
    const old = makeOldFragment({ session: SESSION });
    vi.mocked(repository.findOneById).mockResolvedValue(Some(old));
    const { service } = makeService({
      repository,
      searchService: makeSearchService(
        Some({
          id: old.id as MemoryId,
          content: 'commit messages are single-line',
          similarity: 0.96,
          author_kind: 'agent',
          agent_name: null,
          source: { session: SESSION },
        })
      ),
      context: sessionContext,
    });

    const out = (
      await service.remember({
        content: 'commit messages are single-line, imperative subject',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    expect(out.deduplicated).toBeUndefined();
    expect(repository.insert).toHaveBeenCalledOnce();
    expect(repository.update).toHaveBeenCalledExactlyOnceWith(old);
    expect(old.lifecycle.supersededBy).toBe(out.memory_id);
  });

  it('a hit from ANOTHER session is not collapsed: hinted as before', async () => {
    const repository = makeRepository();
    const hit: SupersedeCandidateHit = {
      id: MEMORY_A,
      content: 'commit messages are single-line',
      kind: 'convention',
      scope: `user.${USER_ENTITY_ID.replace(/\./g, '_')}`,
      source: { session: OTHER_SESSION },
      created_at: new Date().toISOString(),
      similarity: 0.9,
    };
    const { service } = makeService({
      repository,
      searchService: makeSearchService(None, None, [hit]),
      context: sessionContext,
    });

    const out = (
      await service.remember({
        content: 'single-line commits, always',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    expect(out.similar_existing).toHaveLength(1);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('a provisional (watcher) hit never collapses even in-session', async () => {
    const repository = makeRepository();
    const { service } = makeService({
      repository,
      searchService: makeSearchService(
        Some({
          id: MEMORY_A,
          content: 'watcher paraphrase of the fact',
          similarity: 0.96,
          author_kind: 'agent',
          agent_name: 'watcher',
          source: { session: SESSION },
        })
      ),
      context: sessionContext,
    });

    const out = (
      await service.remember({
        content: 'the authoritative correction',
        scope: PERSONAL_SCOPE,
      })
    ).unwrap();

    // Incoming authoritative vs provisional near-match falls through to the
    // provenance auto-resolve in hygiene, not to the session collapse.
    expect(out.deduplicated).toBeUndefined();
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('MemoryService — legacy project scope canonicalization', () => {
  const CANONICAL = 'proj.usr_000000000000000a_0000000000.zero_memory';

  it('remember with a legacy proj.<slug> writes into the per-owner scope', async () => {
    const { service, repository, scopeAccess } = makeService();

    const out = (
      await service.remember({
        content: 'a fact aimed at the legacy generation name',
        scope: 'proj.zero_memory',
      })
    ).unwrap();

    expect(out.scope).toBe(CANONICAL);
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.scope.path).toBe(CANONICAL);
    // Already writable — no bootstrap needed.
    expect(scopeAccess.createScope).not.toHaveBeenCalled();
  });

  it('bootstraps the canonical scope on first sight (upsert)', async () => {
    const scopeAccess = makeScopeAccess(false);
    const { service } = makeService({ scopeAccess });

    const out = (
      await service.remember({
        content: 'first write toward a not-yet-registered project scope',
        scope: 'proj.zero_memory',
      })
    ).unwrap();

    expect(out.scope).toBe(CANONICAL);
    expect(vi.mocked(scopeAccess.createScope).mock.calls[0]![0].path).toBe(
      CANONICAL
    );
  });

  it('a bootstrap failure never fails the write', async () => {
    const scopeAccess = makeScopeAccess(false);
    vi.mocked(scopeAccess.createScope).mockResolvedValue(
      Err('create_scope: denied')
    );
    const { service, repository } = makeService({ scopeAccess });

    const out = (
      await service.remember({
        content: 'write survives a failed scope bootstrap',
        scope: 'proj.zero_memory',
      })
    ).unwrap();

    expect(out.scope).toBe(CANONICAL);
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('a per-owner scope passes through untouched', async () => {
    const { service, scopeAccess } = makeService();

    const out = (
      await service.remember({
        content: 'already canonical',
        scope: CANONICAL,
      })
    ).unwrap();

    expect(out.scope).toBe(CANONICAL);
    expect(scopeAccess.canWrite).not.toHaveBeenCalled();
  });
});

describe('MemoryService.buildContext — project rules delivery', () => {
  const CANON = 'proj.usr_000000000000000a_0000000000.zero_memory';

  it('a briefing carries promoted project rules of the briefed project scopes', async () => {
    const projectRules: IProjectRulesReader = {
      listForScopes: vi
        .fn()
        .mockResolvedValue(['always run the e2e suite before review']),
    };
    const { service } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
      projectRules,
    });

    const out = (
      await service.buildContext({ topic: 'anything', briefing: true })
    ).unwrap();

    expect(out.rules).toEqual(['always run the e2e suite before review']);
    // Only the PROJECT scope is consulted — personal/core rules have no
    // project to bind to (user-layer rules ride instructions instead).
    const [scopes] = vi.mocked(projectRules.listForScopes).mock.calls[0]!;
    expect(scopes.map((scope) => scope.path)).toEqual([CANON]);
  });

  it('a non-briefing call and a rules failure both leave the pack unruled', async () => {
    const projectRules: IProjectRulesReader = {
      listForScopes: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const { service } = makeService({
      context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
      projectRules,
    });

    const plain = (await service.buildContext({ topic: 'anything' })).unwrap();
    expect(plain.rules).toEqual([]);
    expect(projectRules.listForScopes).not.toHaveBeenCalled();

    const briefed = (
      await service.buildContext({ topic: 'anything', briefing: true })
    ).unwrap();
    expect(briefed.rules).toEqual([]);
  });
});

describe('MemoryService.remember — the portable-layer gate', () => {
  /** A session working in a project: the state the gate exists to protect. */
  const attached = {
    context: { ...contextStub, getDefaultScope: () => 'proj.zero_memory' },
  };
  const project = 'proj.usr_000000000000000a_0000000000.zero_memory';

  it('grants core when the judge confirms the fact travels', async () => {
    const { service, repository } = makeService(attached);

    const result = await service.remember({
      content: 'bun caches transpiled output in ~/.bun/install/cache',
      kind: 'fact',
      scope: CORE_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}.core`
    );
    expect(result.unwrap().routed_to_project).toBeUndefined();
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('routes to the project, and says so, when portability is not confirmed', async () => {
    const { service } = makeService({
      ...attached,
      portabilityJudge: makePortabilityJudge({
        portable: false,
        confidence: 0.9,
        rationale: 'names this repository and its branch',
      }),
    });

    const result = await service.remember({
      content: 'the e2e stack listens on :8788 in this repo',
      kind: 'fact',
      scope: CORE_SCOPE,
    });

    // The fact is NOT lost — it lands in the project, and the caller is told.
    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(project);
    expect(result.unwrap().routed_to_project).toContain(project);
    expect(result.unwrap().routed_to_project).toContain(
      'names this repository and its branch'
    );
  });

  it('rejects a project-shaped KIND without spending a judge call', async () => {
    const { service, portabilityJudge } = makeService(attached);

    // A decision is about how THIS project works — the prefilter settles it,
    // so the model is never asked.
    const result = await service.remember({
      content: 'we chose bun over node for the runtime',
      kind: 'decision',
      scope: CORE_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(project);
    expect(portabilityJudge.judgePortability).not.toHaveBeenCalled();
  });

  it('keeps a preference in the personal scope without a judge', async () => {
    const { service, portabilityJudge } = makeService(attached);

    // The owner is the only oracle for a preference, so no model can read the
    // property off the content — and that is exactly what makes it personal.
    const result = await service.remember({
      content:
        'the owner prefers concise prose in chat and full sentences in artifacts',
      kind: 'preference',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}`
    );
    expect(portabilityJudge.judgePortability).not.toHaveBeenCalled();
  });

  it('fails closed into the project when the judge is unavailable', async () => {
    const { service } = makeService({
      ...attached,
      portabilityJudge: makePortabilityJudge({
        portable: false,
        confidence: 0,
        rationale: 'portability could not be judged',
      }),
    });

    const result = await service.remember({
      content: 'postgres ltree labels cannot contain a dot',
      kind: 'fact',
      scope: CORE_SCOPE,
    });

    // A judge that cannot answer must never be the reason a fact leaves its
    // project: doubt keeps it home.
    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(project);
  });

  it('leaves core alone when no project is attached', async () => {
    const { service, portabilityJudge } = makeService();

    // Nothing to default to: the gate has no project to route into, so the
    // caller's explicit choice stands.
    const result = await service.remember({
      content: 'ltree labels cannot contain a dot',
      kind: 'fact',
      scope: CORE_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}.core`
    );
    expect(portabilityJudge.judgePortability).not.toHaveBeenCalled();
  });

  it('never gates an explicitly named project scope', async () => {
    const { service, portabilityJudge } = makeService(attached);

    // Addressing another scope by name is the owner's own instruction, not a
    // default — it must pass through untouched.
    const result = await service.remember({
      content: 'put this loop in the other project',
      kind: 'task',
      scope: 'proj.ulearn',
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toContain('ulearn');
    expect(portabilityJudge.judgePortability).not.toHaveBeenCalled();
  });
});

describe('MemoryService — the session thread', () => {
  const project = 'proj.usr_000000000000000a_0000000000.zero_memory';
  const threadOn = (scopePath: string): ISessionThreadRepository => {
    const threads = makeThreads();
    vi.mocked(threads.findByToken).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: 'conv-1',
        scope: Scope.create(scopePath).unwrap(),
      })
    );
    return threads;
  };

  it('asserts the thread from a briefing and returns its token', async () => {
    const { service, threads } = makeService();

    const result = await service.buildContext({
      topic: 'quokka importer',
      briefing: true,
      project_hint: '/home/someone/repos/quokka-tool',
      conversation_id: 'conv-42',
    });

    expect(result.isOk()).toBe(true);
    // The hook runs this on every user message, so this is the assertion that
    // keeps the thread alive without the agent doing anything.
    expect(threads.open).toHaveBeenCalledOnce();
    const [conversationId, scope] = vi.mocked(threads.open).mock.calls[0]!;
    expect(conversationId).toBe('conv-42');
    expect(scope.path).toBe(
      `proj.${USER_ENTITY_ID.replace(/\./g, '_')}.quokka_tool`
    );
    expect(result.unwrap().session?.thread).toBe(TEST_THREAD);
  });

  it('never asserts a thread when no project resolved', async () => {
    const { service, threads } = makeService();

    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      conversation_id: 'conv-43',
    });

    // A conversation id without a resolved project is not a thread: recording
    // one would be a guess about where the work belongs.
    expect(result.isOk()).toBe(true);
    expect(threads.open).not.toHaveBeenCalled();
    expect(result.unwrap().session).toBeUndefined();
  });

  it('lets the hook win when its project differs from the echoed thread', async () => {
    const threads = threadOn('proj.ulearn');
    const { service } = makeService({ threads });

    // cwd moved, so the work moved: the assertion rewrites the row rather
    // than letting a stale token hold the conversation in the old project.
    const result = await service.buildContext({
      topic: 'quokka importer',
      briefing: true,
      conversation_id: 'conv-42',
      project_hint: '/home/someone/repos/quokka-tool',
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().project_scope).toBe(
      `proj.${USER_ENTITY_ID.replace(/\./g, '_')}.quokka_tool`
    );
    const [, scope] = vi.mocked(threads.open).mock.calls[0]!;
    expect(scope.path).toBe(
      `proj.${USER_ENTITY_ID.replace(/\./g, '_')}.quokka_tool`
    );
  });

  it('pins a read from the thread on a session that lost its attachment', async () => {
    const { service, graphService } = makeService({
      threads: threadOn('proj.zero_memory'),
    });

    // No hint and no session default — exactly what a transport reconnect
    // leaves behind. The echoed token restores the read set.
    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      project,
      personal,
      `${personal}.core`,
    ]);
  });

  it('places a scope-less WRITE from the thread instead of refusing it', async () => {
    const { service } = makeService({ threads: threadOn('proj.zero_memory') });

    // This is the drift the thread exists to stop: the session record was
    // reset, the work did not move, and the fact belongs in the project.
    const result = await service.remember({
      content: 'the deploy hook pulls before invoking the upgrade script',
      kind: 'fact',
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(project);
  });

  it('refuses a scope-less write when the thread is unknown', async () => {
    const { service } = makeService();

    // Fail-open on reads, fail-closed on writes: an unusable token must not
    // become a reason to guess a target.
    const result = await service.remember({
      content: 'a fact with nowhere to go',
      kind: 'fact',
      thread: TEST_THREAD,
    });

    expect(result.isErr()).toBe(true);
  });

  it('keeps the thread out of the way of an explicitly named scope', async () => {
    const { service, threads } = makeService({
      threads: threadOn('proj.ulearn'),
    });

    // Addressing another scope by name is the owner's instruction: it must
    // not consult the thread at all.
    const result = await service.remember({
      content: 'put this loop in the other project',
      kind: 'task',
      scope: 'proj.zero_memory',
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(project);
    expect(threads.findByToken).not.toHaveBeenCalled();
  });

  it('stamps the session marker of the conversation a fact was born in', async () => {
    const { service, repository } = makeService({
      threads: threadOn('proj.zero_memory'),
    });

    const result = await service.remember({
      content: 'the deploy hook pulls before invoking the upgrade script',
      kind: 'fact',
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    // A pointer to the conversation — the token plus the client's own session
    // id — and nothing of what was said in it.
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).toMatchObject({
      thread: TEST_THREAD,
      client_session_id: 'conv-1',
    });
  });

  it('marks the conversation even when the caller named the scope outright', async () => {
    const { service, repository } = makeService({
      threads: threadOn('proj.zero_memory'),
    });

    // Routing and provenance are independent questions: naming a target says
    // where the fact goes, not that it stopped being born in this conversation.
    const result = await service.remember({
      content: 'the review stand clones the live cluster before rehearsing',
      kind: 'fact',
      scope: PERSONAL_SCOPE,
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().scope).toBe(
      `user.${USER_ENTITY_ID.replace(/\./g, '_')}`
    );
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).toMatchObject({
      thread: TEST_THREAD,
      client_session_id: 'conv-1',
    });
  });

  it('leaves the marker off a write with no conversation behind it', async () => {
    const { service, repository } = makeService();

    await service.remember({
      content: 'captured from a terminal, outside any conversation',
      kind: 'fact',
      scope: PERSONAL_SCOPE,
    });

    // Absence is an honest state, not a gap: quick-capture, import and
    // bootstrap have no conversation to point at.
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    expect(fragment.provenance.source).not.toHaveProperty('thread');
    expect(fragment.provenance.source).not.toHaveProperty('client_session_id');
  });

  it('falls back to the pre-thread behaviour when the lookup throws', async () => {
    const threads = makeThreads();
    vi.mocked(threads.findByToken).mockRejectedValue(
      new Error('thread store unreachable')
    );
    const { service, graphService } = makeService({ threads });

    // A thread lookup must never turn into a failed briefing.
    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    const [params] = vi.mocked(graphService.buildContext).mock.calls[0]!;
    const personal = `user.${USER_ENTITY_ID.replace(/\./g, '_')}`;
    expect(params.scopes?.map((scope) => scope.path)).toEqual([
      personal,
      `${personal}.core`,
    ]);
  });
});

describe('MemoryService.buildContext — the thread a hook-less client gets', () => {
  const SESSION = 'ses_000000000000000c.0000000000';
  const sessionContext: IContext = {
    ...contextStub,
    getCurrentSessionId: () => SESSION,
  };

  it('mints a thread from the transport when the caller names no conversation', async () => {
    // Every client without the briefing hook is in this case. Before, it got
    // no thread at all: reads could not survive a reconnect and its writes
    // recorded no birth conversation.
    const threads = makeThreads();
    const { service } = makeService({ threads, context: sessionContext });

    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      project_hint: '/home/u/repos/alpha',
    });

    expect(result.isOk()).toBe(true);
    const [conversationId] = vi.mocked(threads.open).mock.calls[0]!;
    // Prefixed, so the fallback is legible in the data rather than passing
    // for a client's own conversation id.
    expect(conversationId).toBe(`transport:${SESSION}`);
    expect(result.unwrap().session?.thread).toBe(TEST_THREAD);
  });

  it('keeps an echoed conversation instead of minting a fresh fallback', async () => {
    // THE REGRESSION THIS GUARDS: minting on every hook-less call would hand
    // the agent a new token per reconnect and destroy the continuity the echo
    // exists to provide.
    const threads = makeThreads();
    vi.mocked(threads.findByToken).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: 'transport:ses_earlier',
        scope: Scope.user(USER_ENTITY_ID),
      })
    );
    const { service } = makeService({ threads, context: sessionContext });

    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      thread: TEST_THREAD,
    });

    expect(result.isOk()).toBe(true);
    const [conversationId] = vi.mocked(threads.open).mock.calls[0]!;
    expect(conversationId).toBe('transport:ses_earlier');
    expect(conversationId).not.toBe(`transport:${SESSION}`);
  });

  it('a sideways read leaves an existing transport thread where it is', async () => {
    // THE SETTLED INVARIANT, and the drift it prevents. Looking into another
    // project is a first-class move — a decision made there is often the answer
    // here — so it must carry no consequences. If this read re-pointed the row,
    // every later scope-less write would follow it into that project, silently:
    // the same class of bug the first-attach-wins rule was written to close, and
    // the transport fallback is a fresh door into it.
    const threads = makeThreads();
    vi.mocked(threads.findByConversation).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: `transport:${SESSION}`,
        scope: Scope.user(USER_ENTITY_ID),
      })
    );
    const { service } = makeService({ threads, context: sessionContext });

    const result = await service.buildContext({
      topic: 'a neighbouring project',
      project_hint: '/home/u/repos/elsewhere',
    });

    expect(result.isOk()).toBe(true);
    expect(threads.open).not.toHaveBeenCalled();
    // The caller still gets its own token back — the read works, it just does
    // not move anything.
    expect(result.unwrap().session?.thread).toBe(TEST_THREAD);
  });

  it('a named conversation may still re-point the row', async () => {
    // The counterpart, and why the rule is about WHO asks rather than about
    // never writing: the hook names the conversation on every user message and
    // states where that work is. When it disagrees with the stored row, that
    // assertion is exactly what must win.
    const threads = makeThreads();
    vi.mocked(threads.findByConversation).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: 'conv-from-the-hook',
        scope: Scope.user(USER_ENTITY_ID),
      })
    );
    const { service } = makeService({ threads, context: sessionContext });

    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      conversation_id: 'conv-from-the-hook',
      project_hint: '/home/u/repos/alpha',
    });

    expect(result.isOk()).toBe(true);
    expect(threads.open).toHaveBeenCalledTimes(1);
    expect(vi.mocked(threads.open).mock.calls[0]![0]).toBe(
      'conv-from-the-hook'
    );
  });

  it('a named conversation still outranks both', async () => {
    const threads = makeThreads();
    vi.mocked(threads.findByToken).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: 'transport:ses_earlier',
        scope: Scope.user(USER_ENTITY_ID),
      })
    );
    const { service } = makeService({ threads, context: sessionContext });

    await service.buildContext({
      topic: 'project alpha',
      briefing: true,
      conversation_id: 'claude-session-uuid',
      thread: TEST_THREAD,
    });

    const [conversationId] = vi.mocked(threads.open).mock.calls[0]!;
    expect(conversationId).toBe('claude-session-uuid');
  });

  it('mints nothing when the transport has no session either', async () => {
    const threads = makeThreads();
    const { service } = makeService({ threads });

    const result = await service.buildContext({
      topic: 'project alpha',
      briefing: true,
    });

    expect(result.isOk()).toBe(true);
    expect(threads.open).not.toHaveBeenCalled();
  });
});

describe('MemoryService.remember — the marker without an echoed token', () => {
  const SESSION = 'ses_000000000000000d.0000000000';
  const sessionContext: IContext = {
    ...contextStub,
    getCurrentSessionId: () => SESSION,
  };

  it('stamps the transport thread the read side already opened', async () => {
    // The whole point: an agent that briefed and then wrote gets its memory
    // attributed to that conversation WITHOUT having to echo anything. Before
    // this, a write with no `thread` recorded no birth conversation at all.
    const threads = makeThreads();
    vi.mocked(threads.findByConversation).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: `transport:${SESSION}`,
        scope: Scope.user(USER_ENTITY_ID),
      })
    );
    const repository = makeRepository();
    const { service } = makeService({
      repository,
      threads,
      context: sessionContext,
    });

    const result = await service.remember({
      content: 'the pre-commit hook regenerates types from the running stack',
      kind: 'convention',
      scope: 'personal',
    });

    expect(result.isOk()).toBe(true);
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    const source = fragment.provenance.source as Record<string, unknown>;
    expect(source[THREAD_SOURCE_KEY]).toBe(TEST_THREAD);
    expect(source[CLIENT_SESSION_SOURCE_KEY]).toBe(`transport:${SESSION}`);
  });

  it('does not invent a conversation for a session that never read', async () => {
    // Lookup, never a mint: a write is not the place to create a conversation
    // out of nothing, and no marker is an honest state.
    const threads = makeThreads();
    const repository = makeRepository();
    const { service } = makeService({
      repository,
      threads,
      context: sessionContext,
    });

    const result = await service.remember({
      content: 'the launcher reuses a running stack instead of resetting it',
      kind: 'convention',
      scope: 'personal',
    });

    expect(result.isOk()).toBe(true);
    expect(threads.open).not.toHaveBeenCalled();
    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    const source = (fragment.provenance.source ?? {}) as Record<
      string,
      unknown
    >;
    expect(source[THREAD_SOURCE_KEY]).toBeUndefined();
  });

  it('an echoed token still wins over the transport fallback', async () => {
    const threads = makeThreads();
    vi.mocked(threads.findByToken).mockResolvedValue(
      Some({
        token: TEST_THREAD,
        conversationId: 'claude-session-uuid',
        scope: Scope.user(USER_ENTITY_ID),
      })
    );
    const repository = makeRepository();
    const { service } = makeService({
      repository,
      threads,
      context: sessionContext,
    });

    await service.remember({
      content: 'the digest gate refuses a stale provenance claim',
      kind: 'convention',
      scope: 'personal',
      thread: TEST_THREAD,
    });

    const [fragment] = vi.mocked(repository.insert).mock.calls[0]!;
    const source = fragment.provenance.source as Record<string, unknown>;
    expect(source[CLIENT_SESSION_SOURCE_KEY]).toBe('claude-session-uuid');
    expect(threads.findByConversation).not.toHaveBeenCalled();
  });
});

describe('MemoryService.remember entity anchoring', () => {
  const ANCHOR = {
    id: 'ent_1111111111111111.01kwp93915',
    name: 'write-time aperture',
    type: 'concept',
  } as ContentAnchor;

  it('anchors a write that named no subject to entities the scope knows', async () => {
    const { service, entityRepository } = makeService({
      entityRepository: makeEntityRepository([ANCHOR]),
    });

    const result = await service.remember({
      content: 'the write-time aperture is a floor plus a rank cap',
      kind: 'decision',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(entityRepository.findContentAnchors).toHaveBeenCalledOnce();
    expect(entityRepository.linkMemory).toHaveBeenCalledWith(
      result.unwrap().memory_id,
      ANCHOR.id
    );
    expect(result.unwrap().anchors).toEqual([ANCHOR.name]);
    // The ask still comes: the machine key is a floor, not a verdict on the
    // subject, so finding one must not silence the request for the real one.
    expect(result.unwrap().anchor_hint).toBe(ANCHOR_HINT);
  });

  it('leaves a stated subject alone instead of adding to it', async () => {
    const { service, entityRepository } = makeService({
      entityRepository: makeEntityRepository([ANCHOR]),
    });

    const result = await service.remember({
      content: 'the write-time aperture is a floor plus a rank cap',
      kind: 'decision',
      scope: PERSONAL_SCOPE,
      entities: [{ name: 'supersede aperture' }],
    });

    expect(result.isOk()).toBe(true);
    expect(entityRepository.findContentAnchors).not.toHaveBeenCalled();
    expect(result.unwrap().anchors).toEqual(['supersede aperture']);
  });

  it('asks the author to name the subject when nothing could be resolved', async () => {
    const { service } = makeService({
      entityRepository: makeEntityRepository([]),
    });

    const result = await service.remember({
      content: 'a subject this scope has never heard of was settled today',
      kind: 'decision',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().anchors).toBeUndefined();
    expect(result.unwrap().anchor_hint).toBe(ANCHOR_HINT);
  });

  it('does not ask on a kind whose missing key is not worth the interruption', async () => {
    const { service } = makeService({
      entityRepository: makeEntityRepository([]),
    });

    const result = await service.remember({
      content: 'a subject this scope has never heard of was observed today',
      kind: 'fact',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().anchor_hint).toBeUndefined();
  });

  it('never asks a provisional writer, which cannot act on the answer', async () => {
    const { service } = makeService({
      entityRepository: makeEntityRepository([]),
    });

    const result = await service.remember(
      {
        content: 'a subject this scope has never heard of was extracted',
        kind: 'decision',
        scope: PERSONAL_SCOPE,
      },
      { agentName: 'watcher' }
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().anchor_hint).toBeUndefined();
  });

  it('stores the memory even when the anchoring probe fails', async () => {
    const entityRepository = makeEntityRepository([]);
    vi.mocked(entityRepository.findContentAnchors).mockRejectedValue(
      new Error('probe exploded')
    );
    const { service, repository } = makeService({ entityRepository });

    const result = await service.remember({
      content: 'the write must survive a broken graph enrichment',
      kind: 'decision',
      scope: PERSONAL_SCOPE,
    });

    expect(result.isOk()).toBe(true);
    expect(repository.insert).toHaveBeenCalledOnce();
    expect(result.unwrap().anchors).toBeUndefined();
  });
});
