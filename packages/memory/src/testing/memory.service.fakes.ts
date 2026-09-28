import type { IContext } from '@workspace/context';
import type { UserId } from '@workspace/contracts';
import { DeterministicHashEmbeddingService } from '@workspace/embedding/testing';
import { None, Ok, Some, type Option } from 'oxide.ts';
import { vi } from 'vitest';

import type { IBriefingWorkReader } from '../briefing-work.reader.js';
import { EntityResolutionService } from '../entity-resolution.service.js';
import type { ContentAnchor, IEntityRepository } from '../entity.repository.js';
import type { IGraphService } from '../graph.service.js';
import type {
  IMemorySearchService,
  SimilarMemory,
  SimilarMemoryWithProvenance,
  SupersedeCandidateHit,
} from '../memory-search.service.js';
import type { IMemoryRepository } from '../memory.repository.js';
import { MemoryService } from '../memory.service.js';
import type {
  IPortabilityJudge,
  PortabilityOpinion,
} from '../portability-judge.js';
import type { IProjectBindingRepository } from '../project-binding.repository.js';
import type { ProjectCandidate } from '../project-name.utils.js';
import type { IProjectRulesReader } from '../project-rules.reader.js';
import type { IRuleFateReader } from '../rule-fate.reader.js';
import type { IScopeAccessService } from '../scope-access.service.js';
import { ScopeRoutingService } from '../scope-routing.service.js';
import { Scope } from '../scope.vo.js';
import type { ISessionThreadRepository } from '../session-thread.repository.js';
import type { ITranslator } from '../translator.js';
import type { IUserRulesReader } from '../user-rules.reader.js';

/**
 * Vitest fakes of every port `MemoryService` depends on, and one factory that
 * wires a real service from them. Spec support only: this module imports
 * vitest, so nothing outside a spec may import it.
 *
 * Every fake is inert by default — empty stores, no neighbours, a writable
 * scope — so a spec states only the state its assertion is about.
 */

/** The caller every fake context speaks for. */
export const TEST_USER_ID = 'b7e6a1c2-3d4f-4a5b-8c9d-0e1f2a3b4c5d';
export const TEST_USER_ENTITY_ID = 'usr_000000000000000a.0000000000' as UserId;

/** The token the session-thread fake hands back from `open`. */
export const TEST_THREAD = 'thr_test0000000000.0000000000';

/** A request context of the test user, with no session and no default scope. */
export const makeContext = (overrides: Partial<IContext> = {}): IContext => ({
  setContextValue: () => undefined,
  mustGetCurrentUserId: () => TEST_USER_ID,
  getCurrentUserId: () => TEST_USER_ID,
  mustGetCurrentUserEntityId: () => TEST_USER_ENTITY_ID,
  getCurrentUserEntityId: () => TEST_USER_ENTITY_ID,
  getAccessToken: () => 'token',
  getScopes: () => [],
  getDefaultScope: () => undefined,
  getCurrentSessionId: () => undefined,
  ...overrides,
});

export const makeRepository = (): IMemoryRepository => ({
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
  findOneById: vi.fn().mockResolvedValue(None),
  update: vi.fn().mockResolvedValue(Ok(undefined)),
  applyTranslation: vi.fn().mockResolvedValue(Ok(undefined)),
  markTranslationSkipped: vi.fn().mockResolvedValue(Ok(undefined)),
});

/** Translates everything to a fixed English text from a stub language. */
export const makeTranslator = (): ITranslator => ({
  translateToEnglish: vi
    .fn()
    .mockResolvedValue({ text: 'translated', sourceLang: 'ja' }),
});

export const makeSearchService = (
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

export const makeEntityRepository = (
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

export const makeGraphService = (): IGraphService => ({
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

export const makeScopeAccess = (
  canWrite = true,
  projects: ProjectCandidate[] = []
): IScopeAccessService => ({
  canWrite: vi.fn().mockResolvedValue(canWrite),
  createScope: vi.fn().mockResolvedValue(Ok(undefined)),
  listMemberProjects: vi.fn().mockResolvedValue(Ok(projects)),
});

/**
 * Project bindings keyed `<kind>:<key>` (for example
 * `path:/home/dev/alpha`) to the scope path they point at; none by default.
 */
export const makeProjectBindings = (
  bound: Record<string, string> = {}
): IProjectBindingRepository => ({
  findScope: vi.fn().mockImplementation((kind: string, key: string) => {
    const scope = bound[`${kind}:${key}`];
    return Promise.resolve(scope ? Some(Scope.create(scope).unwrap()) : None);
  }),
  insert: vi.fn().mockResolvedValue(Ok(undefined)),
});

/**
 * No live conversation: `findByToken` and `findByConversation` find nothing,
 * so a spec opts into the thread path explicitly; `open` echoes
 * {@link TEST_THREAD}.
 */
export const makeThreads = (): ISessionThreadRepository => ({
  open: vi
    .fn()
    .mockImplementation((conversationId: string, scope: Scope) =>
      Promise.resolve(Ok({ token: TEST_THREAD, conversationId, scope }))
    ),
  findByToken: vi.fn().mockResolvedValue(None),
  findByConversation: vi.fn().mockResolvedValue(None),
});

/**
 * Grants by default, so a spec opts INTO denial — the interesting assertions
 * are about what happens when leaving the project is not confirmed.
 */
export const makePortabilityJudge = (
  opinion: PortabilityOpinion = {
    portable: true,
    confidence: 0.95,
    rationale: '',
  }
): IPortabilityJudge => ({
  judgePortability: vi.fn().mockResolvedValue(opinion),
});

/** No promoted project rules. */
export const makeProjectRules = (): IProjectRulesReader => ({
  listForScopes: vi.fn().mockResolvedValue([]),
});

/** No promoted user-layer rules. */
export const makeUserRules = (): IUserRulesReader => ({
  listPromoted: vi.fn().mockResolvedValue([]),
});

/** An empty board: no work summary for any briefing. */
export const makeBriefingWork = (): IBriefingWorkReader => ({
  forBriefing: vi.fn().mockResolvedValue(null),
});

/** No memory carries a promoted rule. */
export const makeRuleFates = (): IRuleFateReader => ({
  afterSupersede: vi.fn().mockResolvedValue([]),
  hasPromotedRule: vi.fn().mockResolvedValue(false),
});

/** The ports a spec may replace; every other one gets its inert fake. */
export interface MemoryServicePorts {
  repository: IMemoryRepository;
  searchService: IMemorySearchService;
  context: IContext;
  entityRepository: IEntityRepository;
  graphService: IGraphService;
  scopeAccess: IScopeAccessService;
  projectBindings: IProjectBindingRepository;
  translator: ITranslator;
  projectRules: IProjectRulesReader;
  userRules: IUserRulesReader;
  portabilityJudge: IPortabilityJudge;
  threads: ISessionThreadRepository;
  briefingWork: IBriefingWorkReader;
  ruleFates: IRuleFateReader;
}

/**
 * A real `MemoryService` over fakes, with the deterministic embedder and real
 * entity resolution and scope routing on top of the faked stores. Returns
 * the service with every collaborator, so a spec can assert on the port it
 * cares about and hand the same routing and resolution to a service built on
 * top of this one.
 */
export const makeMemoryService = (
  overrides: Partial<MemoryServicePorts> = {}
) => {
  const ports: MemoryServicePorts = {
    repository: makeRepository(),
    searchService: makeSearchService(),
    context: makeContext(),
    entityRepository: makeEntityRepository(),
    graphService: makeGraphService(),
    scopeAccess: makeScopeAccess(),
    projectBindings: makeProjectBindings(),
    translator: makeTranslator(),
    projectRules: makeProjectRules(),
    userRules: makeUserRules(),
    portabilityJudge: makePortabilityJudge(),
    threads: makeThreads(),
    briefingWork: makeBriefingWork(),
    ruleFates: makeRuleFates(),
    ...overrides,
  };
  const embeddingService = new DeterministicHashEmbeddingService();
  const entityResolution = new EntityResolutionService(
    ports.entityRepository,
    embeddingService
  );
  const scopeRouting = new ScopeRoutingService(
    ports.projectBindings,
    ports.scopeAccess,
    ports.context
  );
  const service = new MemoryService(
    ports.repository,
    ports.searchService,
    embeddingService,
    ports.context,
    entityResolution,
    ports.entityRepository,
    ports.graphService,
    ports.scopeAccess,
    scopeRouting,
    ports.translator,
    ports.projectRules,
    ports.userRules,
    ports.portabilityJudge,
    ports.threads,
    ports.briefingWork,
    ports.ruleFates
  );
  return {
    service,
    ...ports,
    embeddingService,
    entityResolution,
    scopeRouting,
  };
};
