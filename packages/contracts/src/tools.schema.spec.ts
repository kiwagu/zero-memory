import { describe, expect, it } from 'vitest';

import {
  buildContextInputSchema,
  buildContextOutputSchema,
  entitiesOutputSchema,
  extractableMemoryKindSchema,
  linkInputSchema,
  memorySearchHitSchema,
  recallInputSchema,
  recallOutputSchema,
  rememberInputSchema,
} from './index.js';

describe('tool contracts', () => {
  it('accepts an optional verbatim idiom anchor on remember', () => {
    const parsed = rememberInputSchema.parse({
      content: 'the user prefers single-line commit messages',
      verbatim: '一行コミット、本文なし',
    });
    expect(parsed.verbatim).toBe('一行コミット、本文なし');
    // Still optional: omitting it stays valid, empty string is rejected.
    expect(
      rememberInputSchema.parse({ content: 'x' }).verbatim
    ).toBeUndefined();
    expect(() =>
      rememberInputSchema.parse({ content: 'x', verbatim: '' })
    ).toThrow();
  });

  it('steers recall/build_context queries to English (canonical-content contract)', () => {
    // The search side must be English because stored content is canonical
    // English; the field descriptions carry that contract to the agent.
    expect(recallInputSchema.shape.query.description).toMatch(/English/);
    expect(buildContextInputSchema.shape.topic.description).toMatch(/English/);
  });

  it('parses a minimal remember input and applies no hidden defaults', () => {
    const parsed = rememberInputSchema.parse({ content: 'a fact' });
    expect(parsed).toEqual({ content: 'a fact' });
    expect(() => rememberInputSchema.parse({ content: '' })).toThrow();
    expect(() => rememberInputSchema.parse({})).toThrow();
  });

  it('parses a full remember input', () => {
    const parsed = rememberInputSchema.parse({
      content: 'chose supabase because self-hosting is easy',
      kind: 'decision',
      scope: 'proj.zero_memory',
      entities: [{ name: 'supabase', type: 'service' }, { name: 'hosting' }],
      links: [{ dst: 'mem_0000000000000002.0000000000', type: 'derived_from' }],
    });
    expect(parsed.kind).toBe('decision');
    expect(parsed.entities?.[1]?.type).toBeUndefined();
    expect(() =>
      rememberInputSchema.parse({ content: 'x', kind: 'unknown-kind' })
    ).toThrow();
    expect(() =>
      rememberInputSchema.parse({
        content: 'x',
        entities: [{ name: 'supabase', type: 'unknown-type' }],
      })
    ).toThrow();
    expect(() =>
      rememberInputSchema.parse({
        content: 'x',
        links: [{ dst: 'mem_0000000000000002.0000000000', type: 'supports' }],
      })
    ).toThrow();
  });

  it('refuses an unknown edge type on link, and parses an entities listing', () => {
    expect(
      linkInputSchema.parse({ src: 'alpha', dst: 'postgres', type: 'uses' })
        .type
    ).toBe('uses');
    expect(() =>
      linkInputSchema.parse({ src: 'a', dst: 'b', type: 'likes' })
    ).toThrow();

    // No e2e calls the entities tool, so this parse is the only check that a
    // well-formed listing still satisfies its output schema.
    expect(
      entitiesOutputSchema.parse({
        entities: [
          {
            id: 'ent_0000000000000001.0000000000',
            name: 'alpha',
            type: 'project',
            scope: 'user.abc',
            created_at: '2026-07-03T00:00:00Z',
          },
        ],
      }).entities
    ).toHaveLength(1);
  });

  it('parses recall input and rejects bad k / kinds', () => {
    const parsed = recallInputSchema.parse({
      query: 'bun gotchas',
      kinds: ['gotcha'],
      k: 5,
    });
    expect(parsed.k).toBe(5);
    expect(() => recallInputSchema.parse({ query: 'q', k: 0 })).toThrow();
    expect(() =>
      recallInputSchema.parse({ query: 'q', kinds: ['nope'] })
    ).toThrow();
  });

  it('parses the briefing kind: optional, and only a known one', () => {
    const bare = buildContextInputSchema.parse({ topic: 't' });
    expect(bare.briefing_kind).toBeUndefined();

    const task = buildContextInputSchema.parse({
      topic: 't',
      briefing: true,
      briefing_kind: 'task',
    });
    expect(task.briefing_kind).toBe('task');

    expect(() =>
      buildContextInputSchema.parse({ topic: 't', briefing_kind: 'weekly' })
    ).toThrow();
  });

  it('parses recall output hits', () => {
    const hit = {
      id: 'mem_0000000000000001.0000000000',
      content: 'text',
      kind: 'fact',
      scope: 'user.abc',
      visibility: 'private',
      created_at: '2026-07-03T00:00:00Z',
      score: 0.03,
    };
    const parsed = memorySearchHitSchema.parse(hit);
    expect(parsed.score).toBeCloseTo(0.03);
    // Quality signals default for rows from older function bodies.
    expect(parsed.similarity).toBeNull();
    expect(parsed.fts_matched).toBe(false);
    expect(
      memorySearchHitSchema.parse({
        ...hit,
        similarity: 0.87,
        fts_matched: true,
      }).similarity
    ).toBeCloseTo(0.87);
    expect(recallOutputSchema.parse({ memories: [hit] }).memories).toHaveLength(
      1
    );
    expect(() =>
      memorySearchHitSchema.parse({ ...hit, visibility: 'public' })
    ).toThrow();
  });

  it('carries the additive pack-hygiene fields and tolerates their absence', () => {
    const pack = buildContextOutputSchema.parse({
      memories: [],
      entities: [
        {
          id: 'ent_0000000000000001.0000000000',
          name: 'alpha',
          type: 'project',
          types: ['project', 'repo'],
          count: 3,
        },
        // Pre-v2 shape: no collapse metadata.
        {
          id: 'ent_0000000000000002.0000000000',
          name: 'beta',
          type: 'tool',
        },
      ],
      edges: [],
      linked_memories: [
        {
          id: 'mem_0000000000000002.0000000000',
          content: 'capped head of an over-long memory',
          kind: 'decision',
          scope: 'user.abc',
          created_at: '2026-07-10T00:00:00Z',
          score: 0.021,
          truncated: true,
        },
      ],
    });
    expect(pack.entities[0]?.types).toEqual(['project', 'repo']);
    expect(pack.entities[0]?.count).toBe(3);
    expect(pack.entities[1]?.types).toBeUndefined();
    expect(pack.linked_memories[0]?.truncated).toBe(true);
    expect(() =>
      buildContextOutputSchema.parse({
        memories: [],
        entities: [
          {
            id: 'ent_0000000000000003.0000000000',
            name: 'gamma',
            type: 'tool',
            count: 0,
          },
        ],
        edges: [],
        linked_memories: [],
      })
    ).toThrow();
  });

  it('defaults open-loop fields on a briefing pack from an older server', () => {
    const legacy = buildContextOutputSchema.parse({
      memories: [],
      entities: [],
      edges: [],
      linked_memories: [],
    });
    expect(legacy.open_loops).toEqual([]);
    expect(legacy.open_loops_total).toBe(0);
    // The recency leg defaults the same way for pre-recency servers.
    expect(legacy.recent).toEqual([]);

    const withLoops = buildContextOutputSchema.parse({
      memories: [],
      entities: [],
      edges: [],
      linked_memories: [],
      open_loops: [
        {
          id: 'mem_0000000000000009.0000000000',
          content: 'check the watcher log on machine B',
          kind: 'task',
          scope: 'proj.alpha',
          created_at: '2026-07-10T00:00:00Z',
        },
      ],
      open_loops_total: 4,
    });
    expect(withLoops.open_loops[0]?.kind).toBe('task');
    expect(withLoops.open_loops_total).toBe(4);
  });

  it('excludes open-loop kinds from the extractable vocabulary', () => {
    expect(extractableMemoryKindSchema.options).not.toContain('task');
    expect(extractableMemoryKindSchema.options).not.toContain('open-question');
    expect(extractableMemoryKindSchema.options).toContain('fact');
  });
});
