import type { MemoryId } from '@workspace/contracts';
import {
  Scope,
  type IGraphService,
  type IMemoryRepository,
  type IProjectBindingRepository,
  type IScopeAccessService,
  type ISessionThreadRepository,
} from '@workspace/memory';
import {
  makeContext,
  makeGraphService,
  makeMemoryService,
  makeProjectBindings,
  makeRepository,
  makeScopeAccess,
  makeThreads,
  TEST_USER_ENTITY_ID,
} from '@workspace/memory/testing';
import {
  BudgetExhaustedError,
  BUDGET_EXHAUSTED,
  type BudgetGuard,
  type BudgetDecision,
} from '@workspace/policy';
import type { IUsageRecorder } from '@workspace/usage';
import { Err, Ok, Some } from 'oxide.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtractionResult } from './extraction.schema.js';
import type { IExtractor } from './extractor.js';
import { makeIngestLog } from './ingest-log.repository.fake.js';
import type { IIngestLogRepository } from './ingest-log.repository.js';
import { IngestService } from './ingest.service.js';
import { DeterministicExtractor } from './testing/deterministic.extractor.js';
import { DeterministicUsefulnessJudge } from './testing/deterministic.usefulness-judge.js';
import type { IUsefulnessJudge } from './usefulness-judge.js';

const PERSONAL_SCOPE = `user.${TEST_USER_ENTITY_ID.replace(/\./g, '_')}`;

const stubExtractor = (result: ExtractionResult): IExtractor => ({
  extract: vi.fn().mockResolvedValue(result),
});

interface ServiceOptions {
  extractor?: IExtractor;
  defaultScope?: string;
  scopeAccess?: IScopeAccessService;
  bindings?: IProjectBindingRepository;
  graphService?: IGraphService;
  ingestLog?: IIngestLogRepository;
  usage?: IUsageRecorder;
  judge?: IUsefulnessJudge;
  repository?: IMemoryRepository;
  budgetGuard?: BudgetGuard;
  threads?: ISessionThreadRepository;
}

/** A budget guard fixed to one decision — unlimited unless a test overrides it. */
const makeBudgetGuard = (decision?: Partial<BudgetDecision>): BudgetGuard => {
  const status = async (): Promise<BudgetDecision> => ({
    budgetId: 'extraction',
    allowed: true,
    limit: null,
    spent: 0,
    remaining: null,
    windowDays: 30,
    source: 'default',
    ...decision,
  });
  return { status, check: status, require: status } as unknown as BudgetGuard;
};

/**
 * An IngestService over a real MemoryService. Scopes are NOT writable by
 * default, so a project a chunk names is set up on first sight and a routed
 * fact is not auto-shared unless a test grants write access.
 */
const makeService = (options?: ServiceOptions) => {
  const memory = makeMemoryService({
    context: makeContext({ getDefaultScope: () => options?.defaultScope }),
    scopeAccess: options?.scopeAccess ?? makeScopeAccess(false),
    ...(options?.repository && { repository: options.repository }),
    ...(options?.graphService && { graphService: options.graphService }),
    ...(options?.bindings && { projectBindings: options.bindings }),
    ...(options?.threads && { threads: options.threads }),
  });
  const ingestLog = options?.ingestLog ?? makeIngestLog();
  const usage: IUsageRecorder = options?.usage ?? {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const service = new IngestService(
    options?.extractor ?? new DeterministicExtractor(),
    memory.service,
    memory.entityResolution,
    memory.graphService,
    memory.scopeRouting,
    ingestLog,
    memory.context,
    usage,
    memory.repository,
    options?.judge ?? new DeterministicUsefulnessJudge(),
    options?.budgetGuard ?? makeBudgetGuard(),
    memory.threads
  );
  return {
    service,
    repository: memory.repository,
    graphService: memory.graphService,
    scopeAccess: memory.scopeAccess,
    bindings: memory.projectBindings,
    ingestLog,
    memoryService: memory.service,
    usage,
    threads: memory.threads,
  };
};

const baseInput = (
  overrides?: Partial<Parameters<IngestService['ingest']>[0]>
) => ({
  transcript_chunk: 'user: nothing durable here',
  chunk_hash: `hash-${Math.random().toString(36).slice(2)}`,
  client: 'test',
  conversation_id: 'conv-1',
  ...overrides,
});

const insertedScopes = (repository: IMemoryRepository): string[] =>
  vi
    .mocked(repository.insert)
    .mock.calls.map(([fragment]) => fragment.scope.path);

// These suites predate the extraction gate and exercise extraction, routing,
// quota, metering and release on terse synthetic chunks. The gate has its own
// unit spec plus a dedicated ingest suite below; keep it OFF here so short
// fixtures still reach the extractor.
beforeEach(() => {
  process.env.ZM_INGEST_GATE = 'off';
  // Extraction now defaults OFF (metrics-only); these suites exercise the
  // extraction path, so opt them back in. The metrics-only suite below sets
  // ZM_INGEST_EXTRACT=off itself.
  process.env.ZM_INGEST_EXTRACT = 'on';
});

afterEach(() => {
  delete process.env.ZM_INGEST_MAX_MEMORIES;
  delete process.env.ZM_INGEST_AUTOSHARE;
  delete process.env.ZM_INGEST_GATE;
  delete process.env.ZM_INGEST_EXTRACT;
});

describe('IngestService — idempotency', () => {
  it('re-sending the same chunk hash is a duplicate no-op', async () => {
    const ingestLog = makeIngestLog();
    const { service, repository } = makeService({ ingestLog });
    const input = baseInput({
      transcript_chunk: 'DECISION: chose postgres over mysql because ltree',
      chunk_hash: 'stable-hash',
    });

    const first = await service.ingest(input);
    const second = await service.ingest(input);

    expect(first.unwrap().duplicate).toBe(false);
    expect(first.unwrap().memories_created).toBe(1);
    expect(second.unwrap()).toEqual({
      duplicate: true,
      memories_created: 0,
      memory_ids: [],
    });
    expect(repository.insert).toHaveBeenCalledTimes(1);
  });
});

describe('IngestService — budget pre-check', () => {
  it('pauses and leaves the chunk pending when the extraction allowance is exhausted', async () => {
    const ingestLog = makeIngestLog();
    const budgetGuard = makeBudgetGuard({
      allowed: false,
      limit: 1_000,
      spent: 1_000,
      remaining: 0,
    });
    const { service, repository } = makeService({ ingestLog, budgetGuard });

    const result = await service.ingest(
      baseInput({
        transcript_chunk: 'DECISION: chose ltree for scopes',
        chunk_hash: 'budget-paused-hash',
      })
    );

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('rate_limited');
    expect(result.unwrapErr().message).toContain(BUDGET_EXHAUSTED);
    // Nothing was stored, and the claim was released so a retry after the
    // budget lifts is not swallowed as a duplicate.
    expect(repository.insert).not.toHaveBeenCalled();
    expect(ingestLog.release).toHaveBeenCalledWith('budget-paused-hash');
    expect(ingestLog.hashes.has('budget-paused-hash')).toBe(false);
  });

  it('never pauses on a null limit (unlimited / BYO-key)', async () => {
    const budgetGuard = makeBudgetGuard({ allowed: false, limit: null });
    const { service } = makeService({ budgetGuard });

    const result = await service.ingest(
      baseInput({
        transcript_chunk: 'DECISION: use bun over npm',
        chunk_hash: 'unlimited-hash',
      })
    );

    expect(result.isOk()).toBe(true);
  });
});

describe('IngestService — probe (dry-run cost preview)', () => {
  it('answers from the ledger without claiming, extracting or metering', async () => {
    const ingestLog = makeIngestLog();
    const usage = { record: vi.fn().mockResolvedValue(undefined) };
    const extractor = stubExtractor({ memories: [] });
    const { service } = makeService({ ingestLog, usage, extractor });
    const input = baseInput({
      transcript_chunk: '',
      chunk_hash: 'unseen-hash',
      probe: true,
    });

    const probed = await service.ingest(input);

    expect(probed.unwrap()).toEqual({
      duplicate: false,
      memories_created: 0,
      memory_ids: [],
    });
    expect(ingestLog.insertIfAbsent).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(usage.record).not.toHaveBeenCalled();
    // The point of not claiming: the real run right after still does the work.
    expect(ingestLog.hashes.has('unseen-hash')).toBe(false);
  });

  it('reports an already-ingested chunk as a duplicate', async () => {
    const ingestLog = makeIngestLog();
    const { service } = makeService({ ingestLog });
    const input = baseInput({
      transcript_chunk: 'DECISION: chose postgres over mysql because ltree',
      chunk_hash: 'known-hash',
    });

    await service.ingest(input);
    const probed = await service.ingest({ ...input, probe: true });

    expect(probed.unwrap().duplicate).toBe(true);
  });

  it('rejects a real ingest with an empty chunk instead of claiming its hash', async () => {
    const ingestLog = makeIngestLog();
    const { service } = makeService({ ingestLog });

    const result = await service.ingest(
      baseInput({ transcript_chunk: '', chunk_hash: 'empty-hash' })
    );

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('validation_failed');
    expect(result.unwrapErr().message).toMatch(/transcript_chunk is required/);
    expect(ingestLog.hashes.has('empty-hash')).toBe(false);
  });
});

describe('IngestService — usage metering', () => {
  it('meters one ingest_chunk on an accepted chunk, none on a duplicate', async () => {
    const ingestLog = makeIngestLog();
    const usage: IUsageRecorder = {
      record: vi.fn().mockResolvedValue(undefined),
    };
    const { service } = makeService({ ingestLog, usage });
    const input = baseInput({ chunk_hash: 'stable-hash' });

    await service.ingest(input);
    await service.ingest(input); // duplicate — no new metering

    const ingestCalls = vi
      .mocked(usage.record)
      .mock.calls.filter(([event]) => event.eventType === 'ingest_chunk');
    expect(ingestCalls).toHaveLength(1);
  });
});

describe('IngestService — confidence gate and quota', () => {
  it('drops candidates below the 0.7 gate', async () => {
    const { service, repository } = makeService();

    const result = await service.ingest(
      baseInput({
        transcript_chunk: [
          'DECISION@0.95: keep migrations as raw sql because reviewability',
          'FACT@0.69: maybe the api uses graphql somewhere',
          'GOTCHA@0.7: bun test needs CI=1 to disable watch mode',
        ].join('\n'),
      })
    );

    expect(result.unwrap().memories_created).toBe(2);
    expect(repository.insert).toHaveBeenCalledTimes(2);
  });

  it('applies the ZM_INGEST_MAX_MEMORIES quota, keeping highest confidence', async () => {
    process.env.ZM_INGEST_MAX_MEMORIES = '2';
    const { service, repository } = makeService();

    const result = await service.ingest(
      baseInput({
        transcript_chunk: [
          'FACT@0.8: fact number one about the project stack',
          'FACT@0.99: fact number two about the project stack',
          'FACT@0.9: fact number three about the project stack',
        ].join('\n'),
      })
    );

    const output = result.unwrap();
    expect(output.memories_created).toBe(2);
    expect(output.notes?.[0]).toMatch(/Quota/);
    const contents = vi
      .mocked(repository.insert)
      .mock.calls.map(([fragment]) => fragment.content.content);
    expect(contents).toEqual([
      'fact number two about the project stack',
      'fact number three about the project stack',
    ]);
  });
});

describe('IngestService — scope routing decision table', () => {
  it('routes preferences to the personal scope even with a project hint', async () => {
    const { service, repository } = makeService({
      bindings: makeProjectBindings({ 'path:/home/dev/alpha': 'proj.alpha' }),
    });

    await service.ingest(
      baseInput({
        transcript_chunk: 'PREF: prefers single-line commit subjects',
        project_hint: '/home/dev/alpha',
      })
    );

    expect(insertedScopes(repository)).toEqual([PERSONAL_SCOPE]);
  });

  it('routes portable facts to the personal core scope, not the project', async () => {
    const { service, repository } = makeService({
      bindings: makeProjectBindings({ 'path:/home/dev/alpha': 'proj.alpha' }),
    });

    await service.ingest(
      baseInput({
        transcript_chunk:
          'GOTCHA: bun loads .env only from the cwd [[portable]]',
        project_hint: '/home/dev/alpha',
      })
    );

    expect(insertedScopes(repository)).toEqual([`${PERSONAL_SCOPE}.core`]);
  });

  it('routes non-preferences to the scope of an existing binding', async () => {
    const bindings = makeProjectBindings({
      'path:/home/dev/alpha': 'proj.alpha',
    });
    const { service, repository } = makeService({ bindings });

    await service.ingest(
      baseInput({
        transcript_chunk: 'DECISION: chose postgres because of ltree support',
        project_hint: '/home/dev/alpha/',
      })
    );

    // A stale binding may resolve the legacy 2-label generation; the write
    // canonicalizes it into the owner's per-owner scope.
    expect(insertedScopes(repository)).toEqual([
      'proj.usr_000000000000000a_0000000000.alpha',
    ]);
    expect(bindings.insert).not.toHaveBeenCalled();
  });

  it('uses the session default scope when no hint is given', async () => {
    const { service, repository } = makeService({
      defaultScope: 'proj.session_project',
    });

    await service.ingest(
      baseInput({
        transcript_chunk: 'FACT: the service exposes a streamable http api',
      })
    );

    expect(insertedScopes(repository)).toEqual([
      'proj.usr_000000000000000a_0000000000.session_project',
    ]);
  });

  it('falls back to personal without hint and default scope', async () => {
    const { service, repository } = makeService();

    await service.ingest(
      baseInput({
        transcript_chunk: 'FACT: the ci pipeline runs on every push',
      })
    );

    expect(insertedScopes(repository)).toEqual([PERSONAL_SCOPE]);
  });
});

describe('IngestService — entities and relations', () => {
  it('wires extracted relations as edges with source-memory provenance', async () => {
    const graphService = makeGraphService();
    const { service, repository } = makeService({ graphService });

    const result = await service.ingest(
      baseInput({
        transcript_chunk:
          'FACT: alpha uses postgres for storage ' +
          '[[entity:alpha|project]] [[entity:postgres|service]] ' +
          '[[rel:alpha|uses|postgres]]',
      })
    );

    const output = result.unwrap();
    expect(output.memories_created).toBe(1);
    expect(graphService.createEdge).toHaveBeenCalledOnce();
    const [params] = vi.mocked(graphService.createEdge).mock.calls[0]!;
    expect(params.sourceMemoryId).toBe(output.memory_ids[0]);
    expect(params.type.value).toBe('uses');
    // Mentions were wired through remember.
    expect(repository.insert).toHaveBeenCalledOnce();
  });

  it('skips a relation the graph rejects and notes it', async () => {
    const graphService = makeGraphService();
    vi.mocked(graphService.createEdge).mockResolvedValue(
      Err('edge rejected by rls')
    );
    const { service } = makeService({ graphService });

    const result = await service.ingest(
      baseInput({
        transcript_chunk:
          'FACT: alpha uses postgres for storage [[rel:alpha|uses|postgres]]',
      })
    );

    const output = result.unwrap();
    expect(output.memories_created).toBe(1);
    expect(output.notes?.some((note) => note.includes('edge rejected'))).toBe(
      true
    );
  });
});

describe('IngestService — extractor failures', () => {
  it('releases the claim on extractor failure so a retry is not a duplicate', async () => {
    const ingestLog = makeIngestLog();
    let calls = 0;
    const extractor: IExtractor = {
      extract: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('transient 529'));
        }
        return Promise.resolve({
          memories: [
            {
              content: 'chose postgres over mysql because of ltree',
              kind: 'decision' as const,
              confidence: 0.9,
              entities: [],
              relations: [],
            },
          ],
        });
      }),
    };
    const { service } = makeService({ extractor, ingestLog });
    const input = baseInput({ chunk_hash: 'retryable-hash' });

    const first = await service.ingest(input);
    expect(first.isErr()).toBe(true);
    expect(ingestLog.release).toHaveBeenCalledWith('retryable-hash');

    // The client retries the SAME chunk — it must be processed, not skipped.
    const second = await service.ingest(input);
    expect(second.unwrap().duplicate).toBe(false);
    expect(second.unwrap().memories_created).toBe(1);
  });

  it('marks the ledger processed with the created count', async () => {
    const ingestLog = makeIngestLog();
    const { service } = makeService({ ingestLog });

    await service.ingest(
      baseInput({
        transcript_chunk: 'DECISION: chose vitest because of speed',
      })
    );

    expect(ingestLog.markProcessed).toHaveBeenCalledWith(expect.any(String), 1);
  });
});

describe('IngestService — empty extraction', () => {
  it('stores nothing when the extractor finds nothing', async () => {
    const extractor = stubExtractor({ memories: [] });
    const { service, repository } = makeService({ extractor });

    const result = await service.ingest(baseInput());

    expect(result.unwrap()).toEqual({
      duplicate: false,
      memories_created: 0,
      memory_ids: [],
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });
});

describe('IngestService — auto-share', () => {
  const decisionAndPref =
    'DECISION: chose postgres over mysql because of ltree\n' +
    'PREF: prefers bun over npm';

  it('shares facts routed to a project scope, not personal preferences', async () => {
    const scopeAccess = makeScopeAccess(true);
    const { service, memoryService } = makeService({ scopeAccess });
    const shareSpy = vi.spyOn(memoryService, 'share').mockResolvedValue(
      Ok({
        memory_id: 'mem_000000000000000d.0000000000' as MemoryId,
        scope: 'proj.acme',
        shared: true,
      })
    );

    await service.ingest(
      baseInput({
        transcript_chunk: decisionAndPref,
        project_hint: '/home/dev/acme',
      })
    );

    // Exactly one share — the decision (project scope); the preference stays private.
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(shareSpy.mock.calls[0]![0].scope.startsWith('proj.')).toBe(true);
  });

  it('does not share when ZM_INGEST_AUTOSHARE=false', async () => {
    process.env.ZM_INGEST_AUTOSHARE = 'false';
    const scopeAccess = makeScopeAccess(true);
    const { service, memoryService } = makeService({ scopeAccess });
    const shareSpy = vi.spyOn(memoryService, 'share');

    await service.ingest(
      baseInput({
        transcript_chunk: decisionAndPref,
        project_hint: '/home/dev/acme',
      })
    );

    expect(shareSpy).not.toHaveBeenCalled();
  });
});

describe('IngestService — bootstrap source provenance', () => {
  const fact = 'user: FACT: alpha uses postgres';

  const insertedFragments = (repository: IMemoryRepository) =>
    vi.mocked(repository.insert).mock.calls.map(([fragment]) => fragment);

  it('stamps document chunks with the bootstrap agent and source', async () => {
    const { service, repository } = makeService();

    const result = await service.ingest(
      baseInput({
        transcript_chunk: fact,
        source_kind: 'document',
        source_path: 'README.md',
        chunk_hash: 'doc-hash-1',
      })
    );

    expect(result.isOk()).toBe(true);
    const fragments = insertedFragments(repository);
    expect(fragments.length).toBe(1);
    expect(fragments[0]!.provenance.agentName).toBe('bootstrap');
    expect(fragments[0]!.provenance.source).toMatchObject({
      kind: 'bootstrap',
      path: 'README.md',
      hash: 'doc-hash-1',
    });
  });

  it('keeps transcript chunks on the watcher identity, carrying the client in source', async () => {
    const { service, repository } = makeService();

    await service.ingest(
      baseInput({ transcript_chunk: fact, client: 'cursor-stop-hook' })
    );

    const fragments = insertedFragments(repository);
    expect(fragments.length).toBe(1);
    // agent_name stays 'watcher' (the trust tier), but source.client makes the
    // row attributable to the ingesting tool.
    expect(fragments[0]!.provenance.agentName).toBe('watcher');
    // toMatchObject: the write path also stamps the routing audit alongside.
    expect(fragments[0]!.provenance.source).toMatchObject({
      client: 'cursor-stop-hook',
    });
  });

  it('marks a transcript chunk with the conversation it came out of', async () => {
    const threads = makeThreads();
    vi.mocked(threads.findByConversation).mockResolvedValue(
      Some({
        token: 'thr_000000000000000a.0000000000',
        conversationId: 'conv-77',
        scope: Scope.create(PERSONAL_SCOPE).unwrap(),
      })
    );
    const { service, repository } = makeService({ threads });

    await service.ingest(
      baseInput({ transcript_chunk: fact, conversation_id: 'conv-77' })
    );

    // The marker is a pointer to the conversation: the thread token plus the
    // client's own session id, which is what finds the local transcript again.
    const fragments = insertedFragments(repository);
    expect(fragments[0]!.provenance.source).toMatchObject({
      thread: 'thr_000000000000000a.0000000000',
      client_session_id: 'conv-77',
    });
    // One lookup for the whole chunk, not one per extracted candidate.
    expect(threads.findByConversation).toHaveBeenCalledOnce();
  });

  it('still marks the client session when the conversation has no live thread', async () => {
    const { service, repository } = makeService();

    await service.ingest(
      baseInput({ transcript_chunk: fact, conversation_id: 'conv-88' })
    );

    // A transcript ingested before its hook asserted a thread (or after that
    // thread lapsed) still has an addressable conversation.
    const fragments = insertedFragments(repository);
    expect(fragments[0]!.provenance.source).toMatchObject({
      client_session_id: 'conv-88',
    });
    expect(fragments[0]!.provenance.source).not.toHaveProperty('thread');
  });

  it('leaves a bootstrap chunk unmarked — its conversation id is synthetic', async () => {
    const { service, repository, threads } = makeService();

    await service.ingest(
      baseInput({
        transcript_chunk: fact,
        source_kind: 'document',
        source_path: 'README.md',
        conversation_id: 'bootstrap-readme',
      })
    );

    // A document is not a conversation: a marker here would point at nothing.
    const fragments = insertedFragments(repository);
    expect(fragments[0]!.provenance.source).not.toHaveProperty('thread');
    expect(fragments[0]!.provenance.source).not.toHaveProperty(
      'client_session_id'
    );
    expect(threads.findByConversation).not.toHaveBeenCalled();
  });

  it('passes the source kind through to the extractor', async () => {
    const extractor = stubExtractor({ memories: [] });
    const { service } = makeService({ extractor });

    await service.ingest(
      baseInput({
        transcript_chunk: 'a history slice',
        source_kind: 'history',
        source_path: 'git-log#0',
      })
    );

    expect(vi.mocked(extractor.extract)).toHaveBeenCalledWith(
      'a history slice',
      'history'
    );
  });
});

describe('IngestService — an exhausted budget pauses, it does not lose work', () => {
  const exhausted = () =>
    new BudgetExhaustedError({
      budgetId: 'extraction',
      limit: 100,
      spent: 100,
      windowDays: 30,
    });

  it('leaves the chunk pending so a later attempt still gets it', async () => {
    const ingestLog = makeIngestLog();
    const extractor: IExtractor = {
      extract: vi.fn().mockRejectedValue(exhausted()),
    };
    const { service } = makeService({ extractor, ingestLog });

    const result = await service.ingest(
      baseInput({ chunk_hash: 'pending-hash' })
    );

    expect(result.isErr()).toBe(true);
    // Released, so the retry is not mistaken for a duplicate...
    expect(ingestLog.release).toHaveBeenCalledWith('pending-hash');
    // ...and never marked done, which would have buried the chunk for good.
    expect(ingestLog.markProcessed).not.toHaveBeenCalled();
  });

  it('says the budget ran out rather than reporting a failure', async () => {
    const extractor: IExtractor = {
      extract: vi.fn().mockRejectedValue(exhausted()),
    };
    const { service } = makeService({ extractor });

    const result = await service.ingest(baseInput());

    // An exhausted allowance is a rate limit, not a breakage: the caller
    // retries once the window rolls forward.
    expect(result.unwrapErr().code).toBe('rate_limited');
    expect(result.unwrapErr().message).toContain(BUDGET_EXHAUSTED);
    expect(result.unwrapErr().message).not.toContain('Extraction failed');
  });

  it('still calls an ordinary failure a failure', async () => {
    const extractor: IExtractor = {
      extract: vi.fn().mockRejectedValue(new Error('model unavailable')),
    };
    const { service } = makeService({ extractor });

    const result = await service.ingest(baseInput());

    expect(result.unwrapErr().code).toBe('internal');
    expect(result.unwrapErr().message).toContain('Extraction failed');
    // The extractor's own reason travels with it.
    expect(result.unwrapErr().message).toMatch(/model unavailable/);
    expect(result.unwrapErr().message).not.toContain(BUDGET_EXHAUSTED);
  });
});

describe('IngestService — extraction gate (enforce)', () => {
  beforeEach(() => {
    process.env.ZM_INGEST_GATE = 'enforce';
  });

  it('a no-signal chunk skips the LLM but still closes the ledger row', async () => {
    const extractor: IExtractor = { extract: vi.fn() };
    const ingestLog = makeIngestLog();
    const { service } = makeService({ extractor, ingestLog });

    const result = await service.ingest(
      baseInput({
        transcript_chunk: 'user: はい、お願いします\nassistant: 完了しました。',
        chunk_hash: 'filler-hash',
      })
    );

    expect(extractor.extract).not.toHaveBeenCalled();
    expect(result.unwrap().memories_created).toBe(0);
    expect(ingestLog.markProcessed).toHaveBeenCalledWith('filler-hash', 0);
  });

  it('records the gate decision on the metered chunk', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      usage: { record },
      extractor: { extract: vi.fn() },
    });

    await service.ingest(
      baseInput({ transcript_chunk: 'user: はい\nassistant: はい' })
    );

    const chunkEvent = record.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventType === 'ingest_chunk');
    expect(chunkEvent?.metadata).toMatchObject({
      gate_mode: 'enforce',
      gate: 'no-signal',
    });
  });

  it('drops a low-confidence fact but keeps a decision from the same chunk', async () => {
    const extractor = stubExtractor({
      memories: [
        {
          content: 'the service exposes a streamable http api endpoint',
          kind: 'fact',
          confidence: 0.78,
          portable: false,
          entities: [],
          relations: [],
        },
        {
          content: 'chose bun over node for workspace install speed',
          kind: 'decision',
          confidence: 0.78,
          portable: false,
          entities: [],
          relations: [],
        },
      ],
    });
    const { service, repository } = makeService({ extractor });

    const result = await service.ingest(
      baseInput({
        transcript_chunk:
          'assistant: a long enough substantive turn to clear the chunk gate',
      })
    );

    expect(result.unwrap().memories_created).toBe(1);
    expect(insertedScopes(repository)).toHaveLength(1);
    expect(result.unwrap().notes?.join(' ')).toContain('Kind gate');
  });

  it('keeps a low-confidence fact when the gate is off', async () => {
    process.env.ZM_INGEST_GATE = 'off';
    const extractor = stubExtractor({
      memories: [
        {
          content: 'the service exposes a streamable http api endpoint',
          kind: 'fact',
          confidence: 0.78,
          portable: false,
          entities: [],
          relations: [],
        },
      ],
    });
    const { service, repository } = makeService({ extractor });

    const result = await service.ingest(
      baseInput({ transcript_chunk: 'assistant: anything, the gate is off' })
    );

    expect(result.unwrap().memories_created).toBe(1);
    expect(insertedScopes(repository)).toHaveLength(1);
  });
});

describe('IngestService — metrics-only (ZM_INGEST_EXTRACT=off)', () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    delete process.env.ZM_INGEST_EXTRACT;
  });

  it('never calls the extractor and stores nothing, but closes the ledger', async () => {
    process.env.ZM_INGEST_EXTRACT = 'off';
    const extractor: IExtractor = { extract: vi.fn() };
    const ingestLog = makeIngestLog();
    const { service, repository } = makeService({ extractor, ingestLog });

    const result = await service.ingest(
      baseInput({
        transcript_chunk:
          'assistant: We chose Postgres over MySQL because ltree gives native scope paths',
        chunk_hash: 'metrics-only-hash',
      })
    );

    expect(extractor.extract).not.toHaveBeenCalled();
    expect(result.unwrap().memories_created).toBe(0);
    expect(insertedScopes(repository)).toHaveLength(0);
    expect(ingestLog.markProcessed).toHaveBeenCalledWith(
      'metrics-only-hash',
      0
    );
  });

  /**
   * Everything a judgement needs: a readable fact behind any id, and a judge
   * that calls one recalled fact used and says another one misled the turn.
   */
  const judgeFixture = () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const repository = makeRepository();
    vi.mocked(repository.findOneById).mockResolvedValue(
      Some({
        id: 'mem_x',
        content: { content: 'a recalled fact', lang: 'en' },
      } as never)
    );
    const judge: IUsefulnessJudge = {
      judge: vi.fn().mockResolvedValue([
        { mem_id: 'mem_x', useful: true, relevant: true, confidence: 0.9 },
        {
          mem_id: 'mem_y',
          useful: false,
          relevant: true,
          misled: true,
          confidence: 0.8,
        },
      ]),
    };
    const { service } = makeService({
      repository,
      judge,
      extractor: { extract: vi.fn() },
      usage: { record },
    });
    const recallUsed = () =>
      record.mock.calls
        .map(([event]) => event)
        .filter((event) => event.eventType === 'recall_used');
    return { service, judge, recallUsed };
  };

  it('still runs the usefulness judge on recalled ids', async () => {
    process.env.ZM_INGEST_EXTRACT = 'off';
    const { service, judge, recallUsed } = judgeFixture();

    await service.ingest(
      baseInput({
        transcript_chunk: 'user: thanks, that recalled fact was the fix',
        recalled_ids: ['mem_x', 'mem_y'],
      })
    );
    await flush(); // the judge runs fire-and-forget after ingest returns

    expect(judge.judge).toHaveBeenCalledTimes(1);
    const [used, misled] = recallUsed();
    expect(recallUsed()).toHaveLength(2);
    expect(used?.metadata).toMatchObject({
      mem_id: 'mem_x',
      source: 'judge',
      useful: true,
      // The judge's second axis (context precision): used implies relevant.
      relevant: true,
    });
    expect(used?.metadata).not.toHaveProperty('valence');
    // A fact that led the turn astray carries negative valence on the same
    // event, which the reinforcement and stale-suspect rollups filter on.
    expect(misled?.metadata).toMatchObject({
      mem_id: 'mem_y',
      useful: false,
      valence: 'misled',
    });
  });

  it('does not judge a chunk that carries no recalled ids', async () => {
    process.env.ZM_INGEST_EXTRACT = 'off';
    // The fixture would judge anything it is handed, so the missing recalled
    // ids are the only reason nothing is judged. The judge runs
    // fire-and-forget and a failure there is only logged, so a warning is
    // the one trace a broken guard leaves: none may appear. Pin the sink
    // that trace would reach: LOG_STDERR=1 or a level above warn would route
    // or drop it, and the negative would pass over nothing.
    vi.stubEnv('LOG_LEVEL', 'warn');
    vi.stubEnv('LOG_STDERR', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, judge, recallUsed } = judgeFixture();

    try {
      await service.ingest(
        baseInput({ transcript_chunk: 'user: nothing was recalled here' })
      );
      await flush();

      expect(judge.judge).not.toHaveBeenCalled();
      expect(recallUsed()).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('meters the chunk with extract:off', async () => {
    process.env.ZM_INGEST_EXTRACT = 'off';
    const record = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      usage: { record },
      extractor: { extract: vi.fn() },
    });

    await service.ingest(
      baseInput({ transcript_chunk: 'assistant: a substantive line of prose' })
    );

    const chunkEvent = record.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventType === 'ingest_chunk');
    expect(chunkEvent?.metadata).toMatchObject({ extract: 'off' });
  });
});
