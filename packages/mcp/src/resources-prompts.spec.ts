import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ResourceLink } from '@modelcontextprotocol/sdk/types.js';
import {
  ZM_MEMORY_URI_TEMPLATE,
  ZM_RULES_URI,
  zmMemoryUri,
  type ContextRule,
  type ExportedMemory,
} from '@workspace/contracts';
import type { ICommandBus, IQueryBus } from '@workspace/cqrs';
import { BuildContextQuery, GetMemoryQuery } from '@workspace/queries';
import { describe, expect, it } from 'vitest';

import { buildMcpServer, resourceLinksForClient } from './mcp-server.js';

/**
 * The resources/prompts plane is asserted through a real client over a linked
 * in-memory transport — same rationale as the annotations spec: what matters
 * is the wire shape a client receives, not the server object's internals.
 */

const MEMORY_ID = 'mem_0123456789abcdef.0123456789';

const FIXTURE_MEMORY: ExportedMemory = {
  id: MEMORY_ID as ExportedMemory['id'],
  content: 'Full untruncated content of the fixture memory.',
  content_original: null,
  content_lang: null,
  kind: 'fact',
  scope: 'core',
  visibility: 'private',
  author_kind: 'agent',
  agent_name: null,
  source: null,
  superseded_by: null,
  invalidated_at: null,
  created_at: '2026-07-28T00:00:00Z',
};

const FIXTURE_RULES: ContextRule[] = [
  { text: 'Always the pinned rule first.', pinned: true },
  { text: 'Then the rest.', pinned: false },
];

const RECALL_FIXTURE = {
  memories: [
    {
      id: MEMORY_ID,
      content: 'hit',
      kind: 'fact',
      scope: 'core',
      visibility: 'private',
      created_at: '2026-07-28T00:00:00Z',
      score: 0.02,
      disputed: false,
      dispute_id: null,
      dispute_with: null,
      similarity: null,
      fts_matched: false,
    },
  ],
};

const BUILD_CONTEXT_FIXTURE = {
  memories: RECALL_FIXTURE.memories,
  entities: [],
  edges: [],
  linked_memories: [],
  recent: [],
  rules: [],
  open_loops: [],
  open_loops_total: 0,
};

const connect = async (options: {
  withRules: boolean;
  clientName?: string;
}) => {
  const noop = { execute: () => Promise.resolve(undefined) };
  const queryBus = {
    execute: (query: unknown) =>
      Promise.resolve(
        query instanceof GetMemoryQuery
          ? query.memoryId === MEMORY_ID
            ? FIXTURE_MEMORY
            : null
          : query instanceof BuildContextQuery
            ? BUILD_CONTEXT_FIXTURE
            : RECALL_FIXTURE
      ),
  };
  const server = buildMcpServer({
    commandBus: noop as unknown as ICommandBus,
    queryBus: queryBus as unknown as IQueryBus,
    runInToolContext: (fn) => fn(),
    ...(options.withRules
      ? { readPromotedRules: () => Promise.resolve(FIXTURE_RULES) }
      : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: options.clientName ?? 'resources-spec',
    version: '0.0.0',
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

describe('resources', () => {
  it('lists the memory template, and the rules resource only when readable', async () => {
    const withRules = await connect({ withRules: true });
    try {
      const templates = await withRules.client.listResourceTemplates();
      expect(
        templates.resourceTemplates.map((template) => template.uriTemplate)
      ).toContain(ZM_MEMORY_URI_TEMPLATE);

      const resources = await withRules.client.listResources();
      const rules = resources.resources.find(
        (resource) => resource.uri === ZM_RULES_URI
      );
      expect(rules).toBeDefined();
      expect(rules?.annotations?.priority).toBe(1);
      expect(rules?.annotations?.audience).toEqual(['assistant']);
    } finally {
      await withRules.close();
    }

    // Without the transport hook the rules resource must not be advertised —
    // a listed resource whose every read fails is worse than honest absence.
    const withoutRules = await connect({ withRules: false });
    try {
      const resources = await withoutRules.client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).not.toContain(
        ZM_RULES_URI
      );
    } finally {
      await withoutRules.close();
    }
  });

  it('serves one full memory at zm://memory/{id} and errors on unknown ids', async () => {
    const { client, close } = await connect({ withRules: true });
    try {
      const read = await client.readResource({ uri: zmMemoryUri(MEMORY_ID) });
      const first = read.contents[0];
      expect(first?.mimeType).toBe('application/json');
      const text = first && 'text' in first ? first.text : '';
      expect(JSON.parse(String(text))).toEqual(FIXTURE_MEMORY);

      await expect(
        client.readResource({
          uri: zmMemoryUri('mem_ffffffffffffffff.0123456789'),
        })
      ).rejects.toThrow(/not found/i);

      await expect(
        client.readResource({ uri: zmMemoryUri('not-an-id') })
      ).rejects.toThrow(/not a memory id/i);
    } finally {
      await close();
    }
  });

  it('serves the promoted rules at zm://rules', async () => {
    const { client, close } = await connect({ withRules: true });
    try {
      const read = await client.readResource({ uri: ZM_RULES_URI });
      const first = read.contents[0];
      const text = first && 'text' in first ? first.text : '';
      expect(JSON.parse(String(text))).toEqual({
        rules: FIXTURE_RULES,
      });
    } finally {
      await close();
    }
  });
});

describe('resource links in read-tool results', () => {
  it('temporarily rounds only Codex fractional priorities without dropping links', () => {
    const links: ResourceLink[] = [
      {
        type: 'resource_link',
        uri: 'zm://memory/high',
        name: 'high',
        annotations: { audience: ['assistant'], priority: 0.9 },
      },
      {
        type: 'resource_link',
        uri: 'zm://memory/low',
        name: 'low',
        annotations: { audience: ['assistant'], priority: 0.2 },
      },
    ];

    expect(resourceLinksForClient(links, 'other-client')).toBe(links);
    const adapted = resourceLinksForClient(links, 'OpenAI Codex app-server');
    expect(adapted).toHaveLength(2);
    expect(adapted.map((link) => link.annotations?.priority)).toEqual([1, 0]);
    expect(adapted.map((link) => link.annotations?.audience)).toEqual([
      ['assistant'],
      ['assistant'],
    ]);
    expect(links.map((link) => link.annotations?.priority)).toEqual([0.9, 0.2]);
  });

  it('recall results carry a dereferenceable resource_link per hit', async () => {
    const { client, close } = await connect({ withRules: true });
    try {
      const result = await client.callTool({
        name: 'recall',
        arguments: { query: 'anything' },
      });
      const content = result.content as Array<{
        type: string;
        uri?: string;
        annotations?: { priority?: number; audience?: string[] };
      }>;
      const links = content.filter((block) => block.type === 'resource_link');
      expect(links).toHaveLength(1);
      expect(links[0]?.uri).toBe(zmMemoryUri(MEMORY_ID));
      // Rank-based priority: the top hit is 1.0 by contract.
      expect(links[0]?.annotations?.priority).toBe(1);
      expect(links[0]?.annotations?.audience).toEqual(['assistant']);
    } finally {
      await close();
    }
  });

  it.each(['codex', 'codex-vscode', 'OpenAI Codex app-server'])(
    'keeps standard resource links usable for %s',
    async (clientName) => {
      const { client, close } = await connect({
        withRules: true,
        clientName,
      });
      try {
        for (const call of [
          { name: 'recall', arguments: { query: 'anything' } },
          { name: 'build_context', arguments: { topic: 'anything' } },
        ]) {
          const result = await client.callTool(call);
          const content = result.content as Array<{
            type: string;
            annotations?: { priority?: number; audience?: string[] };
          }>;
          const links = content.filter(
            (block) => block.type === 'resource_link'
          );
          expect(links).toHaveLength(1);
          expect(links[0]?.annotations?.priority).toBe(1);
          expect(links[0]?.annotations?.audience).toEqual(['assistant']);
          expect(content[0]?.type).toBe('text');
          expect(result.structuredContent).toMatchObject(
            call.name === 'recall' ? RECALL_FIXTURE : BUILD_CONTEXT_FIXTURE
          );
        }
      } finally {
        await close();
      }
    }
  );
});

describe('prompts', () => {
  it('lists brief/receipt/triage and renders brief with a topic', async () => {
    const { client, close } = await connect({ withRules: true });
    try {
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
        'brief',
        'receipt',
        'triage',
      ]);

      const brief = await client.getPrompt({
        name: 'brief',
        arguments: { topic: 'deployment epic' },
      });
      const text = brief.messages[0]?.content;
      expect(text?.type).toBe('text');
      expect(String((text as { text: string }).text)).toContain(
        '"deployment epic"'
      );
    } finally {
      await close();
    }
  });
});
