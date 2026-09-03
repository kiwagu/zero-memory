import type { IContext } from '@workspace/context';
import { setLlmGateway, type ILlmGateway } from '@workspace/llm';
import type {
  IMemorySearchService,
  IScopeMetaRepository,
} from '@workspace/memory';
import type { IUsageRecorder, UsageEvent } from '@workspace/usage';
import { None, Ok } from 'oxide.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScopeDescribeService } from './scope-describe.service.js';

const USER_ENTITY_ID = 'usr_000000000000000a.0000000000';
const CANONICAL = 'proj.usr_000000000000000a_0000000000.zero_memory';

const context: IContext = {
  setContextValue: () => undefined,
  mustGetCurrentUserId: () => 'uuid',
  getCurrentUserId: () => 'uuid',
  mustGetCurrentUserEntityId: () => USER_ENTITY_ID,
  getCurrentUserEntityId: () => USER_ENTITY_ID,
  getAccessToken: () => 'token',
  getScopes: () => [],
  getDefaultScope: () => undefined,
  getCurrentSessionId: () => undefined,
};

const gateway = (description: string): ILlmGateway => ({
  callTool: () =>
    Promise.resolve({
      input: { description },
      model: 'a-model',
      inputTokens: 100,
      outputTokens: 20,
      ranOnCallerKey: false,
    }),
  searchWeb: () => Promise.reject(new Error('not used by scope describe')),
});

const makeSearch = (
  samples: Array<{ content: string; kind: string }>
): IMemorySearchService => ({
  search: vi.fn().mockResolvedValue([]),
  findSimilar: vi.fn().mockResolvedValue(None),
  findAuthoritativeCoverage: vi.fn().mockResolvedValue(None),
  findSupersedeCandidates: vi.fn().mockResolvedValue([]),
  listRecentByScope: vi.fn().mockResolvedValue(samples),
});

const makeMeta = (): IScopeMetaRepository => ({
  upsertModelDescription: vi.fn().mockResolvedValue(Ok(undefined)),
});

const collectingRecorder = () => {
  const events: UsageEvent[] = [];
  const recorder: IUsageRecorder = {
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  return { events, recorder };
};

/** Metering is fire-and-forget, so let the microtasks drain. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ScopeDescribeService', () => {
  beforeEach(() => {
    setLlmGateway(gateway('A project scope about the memory engine.'));
  });

  it('samples the scope, stores and returns the model description', async () => {
    const search = makeSearch([
      { content: 'decision about hygiene', kind: 'decision' },
      { content: 'gotcha about ltree', kind: 'gotcha' },
    ]);
    const meta = makeMeta();
    const { events, recorder } = collectingRecorder();
    const service = new ScopeDescribeService(context, search, meta, recorder);

    const result = await service.describe({ scope: CANONICAL });
    await settled();

    expect(result.unwrap()).toEqual({
      scope: CANONICAL,
      description: 'A project scope about the memory engine.',
    });
    expect(meta.upsertModelDescription).toHaveBeenCalledOnce();
    const [scopeArg, text] = vi.mocked(meta.upsertModelDescription).mock
      .calls[0]!;
    expect(scopeArg.path).toBe(CANONICAL);
    expect(text).toBe('A project scope about the memory engine.');
    // Metered against the owner with the dedicated purpose.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subjectId: USER_ENTITY_ID,
      metadata: { purpose: 'scope_description' },
    });
  });

  it('canonicalizes a legacy proj.<slug> before sampling and storing', async () => {
    const search = makeSearch([{ content: 'anything', kind: 'fact' }]);
    const meta = makeMeta();
    const service = new ScopeDescribeService(context, search, meta);

    const result = await service.describe({ scope: 'proj.zero_memory' });

    expect(result.unwrap().scope).toBe(CANONICAL);
    const [sampledScope] = vi.mocked(search.listRecentByScope).mock.calls[0]!;
    expect(sampledScope.path).toBe(CANONICAL);
  });

  it('refuses an empty scope instead of hallucinating a description', async () => {
    const service = new ScopeDescribeService(
      context,
      makeSearch([]),
      makeMeta()
    );

    const result = await service.describe({ scope: CANONICAL });

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('conflict');
    expect(result.unwrapErr().message).toContain('no memories');
  });

  it('rejects an unrooted scope path', async () => {
    const service = new ScopeDescribeService(
      context,
      makeSearch([]),
      makeMeta()
    );

    const result = await service.describe({ scope: 'ulearn' });

    expect(result.isErr()).toBe(true);
  });
});
