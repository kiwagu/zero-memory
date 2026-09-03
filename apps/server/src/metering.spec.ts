import type { ToolResultMetering } from '@workspace/mcp';
import type { IUsageRecorder, UsageEvent } from '@workspace/usage';
import { describe, expect, it, vi } from 'vitest';

import {
  recordBriefing,
  recordInBandRecallUsed,
  recordRememberResult,
  recordToolError,
  recordToolInvocation,
  recordToolResult,
} from './metering.js';

/** Flush the fire-and-forget microtask chain in recordUsage. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const recorderSpy = (
  record: IUsageRecorder['record'] = vi.fn().mockResolvedValue(undefined)
): { recorder: IUsageRecorder; record: IUsageRecorder['record'] } => ({
  recorder: { record },
  record,
});

const events = (record: IUsageRecorder['record']): UsageEvent[] =>
  vi.mocked(record).mock.calls.map(([event]) => event);

const firstEvent = (record: IUsageRecorder['record']): UsageEvent | undefined =>
  vi.mocked(record).mock.calls[0]?.[0];

const briefingMetering = (
  overrides: Partial<ToolResultMetering> = {}
): ToolResultMetering => ({
  tool: 'build_context',
  returnedIds: ['mem_a', 'mem_b'],
  briefing: {
    topicLen: 12,
    memories: 2,
    entities: 3,
    kind: 'session',
    conversationId: null,
  },
  agentName: null,
  query: null,
  scopes: {
    mode: 'session',
    sessionScope: 'proj.usr_1.quokka_tool',
    returnedByScope: { 'proj.usr_1.quokka_tool': 2 },
  },
  ...overrides,
});

describe('recordBriefing — session_briefing metering', () => {
  it('emits one session_briefing event with the token estimate and hit signal', async () => {
    const { recorder, record } = recorderSpy();

    recordBriefing(recorder, briefingMetering());
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    const event = firstEvent(record);
    expect(event?.eventType).toBe('session_briefing');
    expect(event?.unit).toBe('tokens');
    // 2 memories * 200 + 3 entities * 40 = 520
    expect(event?.quantity).toBe(520);
    expect(event?.metadata).toEqual({
      topic_len: 12,
      returned: 2,
      empty: false,
      briefing_kind: 'session',
    });
  });

  it('stamps conversation_id when the hook supplied one, omits it otherwise', async () => {
    const withId = recorderSpy();
    recordBriefing(
      withId.recorder,
      briefingMetering({
        briefing: {
          topicLen: 12,
          memories: 2,
          entities: 3,
          kind: 'session',
          conversationId: 'ses_claude_abc',
        },
      })
    );
    await flush();
    expect(firstEvent(withId.record)?.metadata).toMatchObject({
      conversation_id: 'ses_claude_abc',
    });

    const without = recorderSpy();
    recordBriefing(without.recorder, briefingMetering());
    await flush();
    expect(firstEvent(without.record)?.metadata).not.toHaveProperty(
      'conversation_id'
    );
  });

  it('stamps the task kind on a task briefing', async () => {
    const { recorder, record } = recorderSpy();

    recordBriefing(
      recorder,
      briefingMetering({
        briefing: {
          topicLen: 40,
          memories: 2,
          entities: 3,
          kind: 'task',
          conversationId: null,
        },
      })
    );
    await flush();

    expect(firstEvent(record)?.metadata).toMatchObject({
      briefing_kind: 'task',
    });
  });

  it('marks an empty briefing as a miss (empty: true, zero tokens)', async () => {
    const { recorder, record } = recorderSpy();

    recordBriefing(
      recorder,
      briefingMetering({
        returnedIds: [],
        briefing: {
          topicLen: 4,
          memories: 0,
          entities: 0,
          kind: 'session',
          conversationId: null,
        },
      })
    );
    await flush();

    const event = firstEvent(record);
    expect(event?.quantity).toBe(0);
    expect(event?.metadata).toMatchObject({ returned: 0, empty: true });
  });

  it('is a no-op for a non-briefing call (briefing: null)', async () => {
    const { recorder, record } = recorderSpy();

    recordBriefing(recorder, briefingMetering({ briefing: null }));
    await flush();

    expect(record).not.toHaveBeenCalled();
  });

  it('carries only counts — never memory ids or content — in metadata', async () => {
    const { recorder, record } = recorderSpy();

    recordBriefing(recorder, briefingMetering());
    await flush();

    const event = firstEvent(record);
    expect(Object.keys(event?.metadata ?? {}).sort()).toEqual([
      'briefing_kind',
      'empty',
      'returned',
      'topic_len',
    ]);
  });

  it('never throws when the recorder rejects (fire-and-forget)', async () => {
    const { recorder } = recorderSpy(
      vi.fn().mockRejectedValue(new Error('db down'))
    );

    expect(() => recordBriefing(recorder, briefingMetering())).not.toThrow();
    await flush();
  });
});

describe('recordToolInvocation — pre-execution volume metering', () => {
  it('emits a generic mcp_tool_call for a non-attributed tool', async () => {
    const { recorder, record } = recorderSpy();

    recordToolInvocation(recorder, 'forget');
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    expect(firstEvent(record)).toMatchObject({
      eventType: 'mcp_tool_call',
      metadata: { tool: 'forget' },
    });
  });

  it.each(['recall', 'build_context', 'remember'])(
    'skips %s (metered post-result instead, no double count)',
    async (tool) => {
      const { recorder, record } = recorderSpy();

      recordToolInvocation(recorder, tool);
      await flush();

      expect(record).not.toHaveBeenCalled();
    }
  );
});

describe('recordRememberResult — post-result remember metering', () => {
  it('carries the surfaced supersede-candidate ids as similar_ids', async () => {
    const { recorder, record } = recorderSpy();

    recordRememberResult(recorder, {
      similarIds: ['mem_a', 'mem_b'],
      agentName: 'claude-code',
    });
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    expect(firstEvent(record)).toMatchObject({
      eventType: 'mcp_tool_call',
      agentName: 'claude-code',
      metadata: { tool: 'remember', similar_ids: ['mem_a', 'mem_b'] },
    });
  });

  it('omits similar_ids for an ordinary write (no candidates surfaced)', async () => {
    const { recorder, record } = recorderSpy();

    recordRememberResult(recorder, { similarIds: [], agentName: null });
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    const event = firstEvent(record);
    expect(event?.metadata).toEqual({ tool: 'remember' });
  });
});

describe('recordToolResult — recall-hit attribution', () => {
  it('emits one mcp_tool_call carrying the surfaced mem ids and count', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({
        tool: 'recall',
        returnedIds: ['mem_a', 'mem_b', 'mem_c'],
        briefing: null,
      })
    );
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    expect(firstEvent(record)).toEqual({
      eventType: 'mcp_tool_call',
      agentName: null,
      metadata: {
        tool: 'recall',
        returned: 3,
        returned_ids: ['mem_a', 'mem_b', 'mem_c'],
        read_mode: 'session',
        session_scope: 'proj.usr_1.quokka_tool',
        returned_by_scope: { 'proj.usr_1.quokka_tool': 2 },
      },
    });
  });

  it('records how an open (unattached, unpinned) read searched', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({
        tool: 'recall',
        briefing: null,
        scopes: {
          mode: 'open',
          sessionScope: null,
          returnedByScope: {
            'proj.usr_1.quokka_tool': 1,
            'user.usr_1': 1,
          },
        },
      })
    );
    await flush();

    const metadata = firstEvent(record)?.metadata;
    // 'open' is the degraded all-visible-scopes read — the mode the
    // scope-usage audit most needs to see, and the one a session scope key
    // would misrepresent, so the key is absent rather than null.
    expect(metadata?.read_mode).toBe('open');
    expect(metadata).not.toHaveProperty('session_scope');
    expect(metadata?.returned_by_scope).toEqual({
      'proj.usr_1.quokka_tool': 1,
      'user.usr_1': 1,
    });
  });

  it('attributes the MCP client as the agent principal when known', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({
        tool: 'recall',
        briefing: null,
        agentName: 'claude-code',
      })
    );
    await flush();

    expect(firstEvent(record)?.agentName).toBe('claude-code');
  });

  it('stores the search query, truncated to the cap', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({
        tool: 'recall',
        briefing: null,
        query: 'x'.repeat(500),
      })
    );
    await flush();

    const stored = firstEvent(record)?.metadata?.query as string;
    expect(stored).toHaveLength(200);
  });

  it('omits the query key entirely when none was sent', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({ tool: 'recall', briefing: null, query: null })
    );
    await flush();

    expect(firstEvent(record)?.metadata).not.toHaveProperty('query');
  });

  it('stores the translated query when translate-then-search rewrote it', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({
        tool: 'recall',
        briefing: null,
        query: 'ポートを固定する',
      })
    );
    await flush();

    // The metered query is the one the caller sent, whatever its language:
    // nothing rewrites it, so nothing has to be reported alongside it.
    expect(firstEvent(record)?.metadata?.query).toBe('ポートを固定する');
    expect(firstEvent(record)?.metadata).not.toHaveProperty('searched_as');
  });

  it('records an empty result as returned: 0 with no ids', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({
        tool: 'recall',
        returnedIds: [],
        briefing: null,
        scopes: {
          mode: 'session',
          sessionScope: 'proj.usr_1.q',
          returnedByScope: {},
        },
      })
    );
    await flush();

    expect(firstEvent(record)?.metadata).toEqual({
      tool: 'recall',
      returned: 0,
      returned_ids: [],
      read_mode: 'session',
      session_scope: 'proj.usr_1.q',
      returned_by_scope: {},
    });
  });

  it('also emits session_briefing when the call was a session-start briefing', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(recorder, briefingMetering());
    await flush();

    const kinds = events(record).map((event) => event.eventType);
    expect(kinds).toContain('mcp_tool_call');
    expect(kinds).toContain('session_briefing');
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('emits only mcp_tool_call for a non-briefing recall', async () => {
    const { recorder, record } = recorderSpy();

    recordToolResult(
      recorder,
      briefingMetering({ tool: 'recall', briefing: null })
    );
    await flush();

    expect(events(record).map((event) => event.eventType)).toEqual([
      'mcp_tool_call',
    ]);
  });
});

describe('recordInBandRecallUsed — in-band recall usefulness', () => {
  it('emits one recall_used per used id, source in_band, useful true', async () => {
    const { recorder, record } = recorderSpy();

    recordInBandRecallUsed(recorder, ['mem_a', 'mem_b']);
    await flush();

    expect(record).toHaveBeenCalledTimes(2);
    expect(events(record)).toEqual([
      {
        eventType: 'recall_used',
        metadata: { mem_id: 'mem_a', source: 'in_band', useful: true },
      },
      {
        eventType: 'recall_used',
        metadata: { mem_id: 'mem_b', source: 'in_band', useful: true },
      },
    ]);
  });

  it('is a no-op for an empty id list', async () => {
    const { recorder, record } = recorderSpy();

    recordInBandRecallUsed(recorder, []);
    await flush();

    expect(record).not.toHaveBeenCalled();
  });

  it('carries only the mem id and flags — never content', async () => {
    const { recorder, record } = recorderSpy();

    recordInBandRecallUsed(recorder, ['mem_a']);
    await flush();

    expect(Object.keys(firstEvent(record)?.metadata ?? {}).sort()).toEqual([
      'mem_id',
      'source',
      'useful',
    ]);
  });

  it('never throws when the recorder rejects (fire-and-forget)', async () => {
    const { recorder } = recorderSpy(
      vi.fn().mockRejectedValue(new Error('db down'))
    );

    expect(() => recordInBandRecallUsed(recorder, ['mem_a'])).not.toThrow();
    await flush();
  });
});

describe('recordToolError — failed read-tool metering', () => {
  it('emits one mcp_tool_call flagged error, without surfaced ids', async () => {
    const { recorder, record } = recorderSpy();

    recordToolError(recorder, {
      tool: 'recall',
      agentName: 'claude-code',
      query: 'カフカのポートは何番ですか',
    });
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    expect(firstEvent(record)).toEqual({
      eventType: 'mcp_tool_call',
      agentName: 'claude-code',
      metadata: {
        tool: 'recall',
        error: true,
        query: 'カフカのポートは何番ですか',
      },
    });
  });

  it('never throws when the recorder rejects (fire-and-forget)', async () => {
    const { recorder } = recorderSpy(
      vi.fn().mockRejectedValue(new Error('db down'))
    );

    expect(() =>
      recordToolError(recorder, {
        tool: 'build_context',
        agentName: null,
        query: null,
      })
    ).not.toThrow();
    await flush();
  });
});
