import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BuildContextOutput, RecallOutput } from '@workspace/contracts';
import type { ICommandBus, IQueryBus } from '@workspace/cqrs';
import { buildMcpServer } from '@workspace/mcp';
import type { IUsageRecorder, UsageEvent } from '@workspace/usage';
import { describe, expect, it, vi } from 'vitest';

import {
  recordRememberResult,
  recordToolInvocation,
  recordToolResult,
} from './metering.js';

/**
 * End-to-end of the metering seam: a real MCP client calls a tool,
 * the request flows through buildMcpServer's dispatch into the pre-execution
 * (onToolInvocation) and post-result (onToolResult) hooks, which drive the
 * shared metering helpers. Asserts the usage_events payloads the dashboard will
 * aggregate — no live DB, but the whole in-process wiring is exercised.
 */

// Fixtures cast past the branded id types — only the `.id` strings matter to
// the metering seam under test.
const buildContextOutput = {
  memories: [
    { id: 'mem_a', content: 'a', kind: 'fact', scope: 'user', created_at: 't' },
    { id: 'mem_b', content: 'b', kind: 'fact', scope: 'user', created_at: 't' },
  ],
  entities: [{ id: 'ent_x', name: 'x', type: 'concept' }],
  edges: [],
  linked_memories: [
    { id: 'mem_c', content: 'c', kind: 'fact', scope: 'user', created_at: 't' },
  ],
  recent: [
    { id: 'mem_d', content: 'd', kind: 'fact', scope: 'user', created_at: 't' },
  ],
} as unknown as BuildContextOutput;

const recallOutput = {
  memories: [
    {
      id: 'mem_r1',
      content: 'r1',
      kind: 'gotcha',
      scope: 'user',
      visibility: 'private',
      created_at: 't',
      score: 0.9,
      disputed: false,
      dispute_id: null,
      dispute_with: null,
    },
  ],
} as unknown as RecallOutput;

// Discriminate the query structurally (build_context carries `topic`, recall
// carries `query`) to avoid a test-only dependency on @workspace/queries.
const queryBus = {
  execute: vi.fn(async (query: Record<string, unknown>) => {
    if ('topic' in query) {
      return buildContextOutput;
    }
    if ('query' in query) {
      return recallOutput;
    }
    throw new Error('unexpected query');
  }),
} as unknown as IQueryBus;

const commandBus = {
  execute: vi.fn(),
} as unknown as ICommandBus;

const connectClient = (
  recorder: IUsageRecorder
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const server = buildMcpServer({
    commandBus,
    queryBus,
    runInToolContext: (fn) => fn(),
    onToolInvocation: (tool) => recordToolInvocation(recorder, tool),
    onToolResult: (metering) => recordToolResult(recorder, metering),
    onRememberResult: (metering) => recordRememberResult(recorder, metering),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  return Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]).then(() => ({
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  }));
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const recorderSpy = (): {
  recorder: IUsageRecorder;
  events: () => UsageEvent[];
} => {
  const record = vi.fn().mockResolvedValue(undefined);
  return {
    recorder: { record },
    events: () => record.mock.calls.map(([event]) => event as UsageEvent),
  };
};

describe('metering seam — MCP client → usage events', () => {
  it('a session-start build_context yields one mcp_tool_call (with ids) + session_briefing, no double count', async () => {
    const { recorder, events } = recorderSpy();
    const { client, close } = await connectClient(recorder);

    await client.callTool({
      name: 'build_context',
      arguments: { topic: 'billing', briefing: true },
    });
    await flush();
    await close();

    const emitted = events();
    const toolCalls = emitted.filter((e) => e.eventType === 'mcp_tool_call');
    const briefings = emitted.filter((e) => e.eventType === 'session_briefing');

    // Exactly one volume row — the pre-execution emit is suppressed for the
    // result-attributed build_context (no double count).
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.metadata).toEqual({
      tool: 'build_context',
      returned: 4, // 2 memories + 1 linked + 1 recent
      returned_ids: ['mem_a', 'mem_b', 'mem_c', 'mem_d'],
      // Scope observability: this harness session has no attached project and
      // the call carries no scopes/hint, so the read is the degraded
      // all-visible one — exactly what the audit needs to see recorded.
      read_mode: 'open',
      returned_by_scope: { user: 4 },
      // The search string travels with the event (owner-approved exception
      // to the content-free posture — it is the caller's own input).
      query: 'billing',
    });
    expect(briefings).toHaveLength(1);
    expect(briefings[0]?.metadata).toMatchObject({ returned: 4, empty: false });
  });

  it('a mid-session build_context (no flag) meters the hit but no briefing', async () => {
    const { recorder, events } = recorderSpy();
    const { client, close } = await connectClient(recorder);

    await client.callTool({
      name: 'build_context',
      arguments: { topic: 'billing' },
    });
    await flush();
    await close();

    const kinds = events().map((e) => e.eventType);
    expect(kinds).toContain('mcp_tool_call');
    expect(kinds).not.toContain('session_briefing');
  });

  it('recall attributes the surfaced mem ids on a single mcp_tool_call', async () => {
    const { recorder, events } = recorderSpy();
    const { client, close } = await connectClient(recorder);

    await client.callTool({
      name: 'recall',
      arguments: { query: 'billing' },
    });
    await flush();
    await close();

    const toolCalls = events().filter((e) => e.eventType === 'mcp_tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.metadata).toEqual({
      tool: 'recall',
      returned: 1,
      returned_ids: ['mem_r1'],
      read_mode: 'open',
      returned_by_scope: { user: 1 },
      query: 'billing',
    });
  });

  it('remember emits one mcp_tool_call carrying similar_ids, no double count', async () => {
    const { recorder, events } = recorderSpy();
    vi.mocked(commandBus.execute).mockResolvedValueOnce({
      memory_id: 'mem_new',
      similar_existing: [
        {
          id: 'mem_old1',
          kind: 'gotcha',
          age_days: 2,
          similarity: 0.9,
          content: 'x',
        },
        {
          id: 'mem_old2',
          kind: 'fact',
          age_days: 5,
          similarity: 0.89,
          content: 'y',
        },
      ],
      hint: 'declare a supersede if this replaces one',
    });
    const { client, close } = await connectClient(recorder);

    await client.callTool({
      name: 'remember',
      arguments: { content: 'a fact' },
    });
    await flush();
    await close();

    const toolCalls = events().filter((e) => e.eventType === 'mcp_tool_call');
    // Exactly one row — the pre-execution emit is suppressed for the
    // result-attributed remember (no double count).
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.metadata).toEqual({
      tool: 'remember',
      similar_ids: ['mem_old1', 'mem_old2'],
    });
  });

  it('remember without candidates emits a bare {tool} row', async () => {
    const { recorder, events } = recorderSpy();
    vi.mocked(commandBus.execute).mockResolvedValueOnce({
      memory_id: 'mem_new',
    });
    const { client, close } = await connectClient(recorder);

    await client.callTool({
      name: 'remember',
      arguments: { content: 'a fact' },
    });
    await flush();
    await close();

    const toolCalls = events().filter((e) => e.eventType === 'mcp_tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.metadata).toEqual({ tool: 'remember' });
  });
});
