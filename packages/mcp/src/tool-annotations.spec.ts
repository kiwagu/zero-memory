import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ICommandBus, IQueryBus } from '@workspace/cqrs';
import { RULE_DELIVERY } from '@workspace/db';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildMcpServer, TOOL_ANNOTATIONS } from './mcp-server.js';

/**
 * ToolAnnotations are asserted through a REAL client over a linked in-memory
 * transport, mirroring the contract-capability spec: what matters is the wire
 * shape a client's permission layer actually receives on tools/list, not what
 * the server object holds. The spec's defaults for an un-annotated tool are
 * maximally conservative (`destructiveHint: true`, `openWorldHint: true`), so
 * a tool that ships without annotations presents as a destructive, open-world
 * call — the exact misclassification these annotations exist to prevent for
 * the read tools. Tool lists below are spelled out independently of the
 * implementation map so a tool silently reclassified there still fails here.
 */

/** Tools verified to be pure lookups — the read contract is exact. */
const READ_TOOLS = [
  'recall',
  'build_context',
  'entities',
  'list_conflicts',
  'get_conflict',
  'session_receipt',
  'export_metrics',
  'export_memories',
] as const;

/** Tools that invalidate or erase user-visible data — review-worthy. */
const DESTRUCTIVE_TOOLS = [
  'forget',
  'resolve_conflict',
  'resolve_conflicts',
  'delete_account',
] as const;

describe('tool annotations', () => {
  let server: ReturnType<typeof buildMcpServer>;
  let client: Client;
  let listed: Awaited<ReturnType<Client['listTools']>>['tools'];

  beforeAll(async () => {
    const noop = { execute: () => Promise.resolve(undefined) };
    server = buildMcpServer({
      commandBus: noop as unknown as ICommandBus,
      queryBus: noop as unknown as IQueryBus,
      runInToolContext: (fn) => fn(),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'annotations-spec', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    listed = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('annotates every registered tool — none is left at the spec defaults', () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const tool of listed) {
      expect(
        tool.annotations,
        `tool "${tool.name}" has no annotations`
      ).toBeDefined();
      // Every hint is declared explicitly: an absent field falls back to the
      // client's own default, which is the ambiguity being eliminated.
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf('boolean');
      expect(tool.annotations?.destructiveHint, tool.name).toBeTypeOf(
        'boolean'
      );
      expect(tool.annotations?.idempotentHint, tool.name).toBeTypeOf('boolean');
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it('keeps the registered set and the annotations map in lockstep', () => {
    const listedNames = listed.map((tool) => tool.name).sort();
    expect(listedNames).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
  });

  it('marks the read tools with the exact read-only contract', () => {
    for (const name of READ_TOOLS) {
      const tool = listed.find((candidate) => candidate.name === name);
      expect(tool, `read tool "${name}" is not registered`).toBeDefined();
      expect(tool?.annotations, name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('keeps destructive review on the tools that invalidate or erase', () => {
    for (const name of DESTRUCTIVE_TOOLS) {
      const tool = listed.find((candidate) => candidate.name === name);
      expect(
        tool,
        `destructive tool "${name}" is not registered`
      ).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it('never lets a write tool claim the read-only hint', () => {
    for (const tool of listed) {
      const isRead = (READ_TOOLS as readonly string[]).includes(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(isRead);
    }
  });

  it('keeps every description inside the client-visible budget', () => {
    // Claude Code silently truncates each tool description at 2KB, cutting
    // the tail mid-sentence — and descriptions accrete a clause per feature
    // epic, so the newest guidance is what gets eaten. This assertion is the
    // backstop: growth past the budget fails here instead of shipping broken.
    for (const tool of listed) {
      expect(
        (tool.description ?? '').length,
        `description of "${tool.name}" exceeds the client-visible budget`
      ).toBeLessThanOrEqual(RULE_DELIVERY.descriptionVisibleBudget);
    }
  });
});
