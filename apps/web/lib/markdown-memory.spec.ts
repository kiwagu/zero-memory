import { describe, expect, it } from 'vitest';

import {
  memoryFilePath,
  memorySlug,
  parseMemoryFile,
  renderMemoryFile,
  type RenderableMemory,
} from './markdown-memory';

/** A minimal, fully-populated row; individual tests override what they probe. */
function row(overrides: Partial<RenderableMemory> = {}): RenderableMemory {
  return {
    id: 'mem_abc123def456ghij.0000000001',
    content: 'Token price is a constant by default.',
    content_original: null,
    content_lang: 'en',
    kind: 'decision',
    scope: 'user.usr_test',
    visibility: 'private',
    author_kind: 'agent',
    agent_name: 'claude-code',
    source: null,
    invalidated_at: null,
    superseded_by: null,
    created_at: '2026-07-10T07:40:50.773+00:00',
    ...overrides,
  };
}

describe('memorySlug', () => {
  it('is a content hint joined to the stable id body', () => {
    expect(memorySlug(row())).toBe(
      'token-price-is-a-constant-by--abc123def456ghij'
    );
  });

  it('falls back to the id body when the content has no word chars', () => {
    expect(memorySlug(row({ content: '!!! ???' }))).toBe('abc123def456ghij');
  });

  it('is stable for an unchanged memory', () => {
    expect(memorySlug(row())).toBe(memorySlug(row()));
  });
});

describe('memoryFilePath', () => {
  it('groups active memories under their scope', () => {
    expect(memoryFilePath(row({ scope: 'proj.zero_memory' }))).toBe(
      'proj.zero_memory/token-price-is-a-constant-by--abc123def456ghij.md'
    );
  });

  it('moves superseded memories under archive/', () => {
    expect(memoryFilePath(row({ superseded_by: 'mem_newer.0002' }))).toContain(
      'archive/user.usr_test/'
    );
  });

  it('moves invalidated memories under archive/', () => {
    expect(
      memoryFilePath(row({ invalidated_at: '2026-07-11T00:00:00Z' }))
    ).toContain('archive/');
  });
});

describe('renderMemoryFile', () => {
  it('renders deterministic frontmatter and body', () => {
    expect(renderMemoryFile(row())).toBe(
      [
        '---',
        'id: mem_abc123def456ghij.0000000001',
        'kind: decision',
        'scope: user.usr_test',
        'visibility: private',
        'lang: en',
        'created_at: 2026-07-10T07:40:50.773+00:00',
        'author_kind: agent',
        'agent_name: claude-code',
        '---',
        '',
        'Token price is a constant by default.',
        '',
      ].join('\n')
    );
  });

  it('is byte-identical across renders (empty git diff)', () => {
    expect(renderMemoryFile(row())).toBe(renderMemoryFile(row()));
  });

  it('sorts jsonb source keys for a stable render', () => {
    const a = renderMemoryFile(row({ source: { b: 1, a: 2 } as never }));
    const b = renderMemoryFile(row({ source: { a: 2, b: 1 } as never }));
    expect(a).toBe(b);
    expect(a).toContain('source: {"a":2,"b":1}');
  });

  it('carries the session marker out with the rest of the provenance', () => {
    const rendered = renderMemoryFile(
      row({
        source: {
          client_session_id: 'c29b855e-1ea0-4ac4-8091-cddfd0ab5f9c',
          thread: 'thr_000000000000000a.0000000000',
        } as never,
      })
    );

    // The marker needs no export field of its own — it rides the provenance
    // container on stable, sorted keys. An export therefore says which
    // conversation each fact came from, while still carrying none of it.
    expect(rendered).toContain(
      'source: {"client_session_id":"c29b855e-1ea0-4ac4-8091-cddfd0ab5f9c",' +
        '"thread":"thr_000000000000000a.0000000000"}'
    );
  });

  it('appends the original-language section behind a marker', () => {
    const rendered = renderMemoryFile(
      row({
        content_original: 'トークンの価格は一定です。',
        content_lang: 'ja',
      })
    );
    expect(rendered).toContain('<!-- zm:original lang=ja -->');
    expect(rendered).toContain('トークンの価格は一定です。');
  });
});

describe('parseMemoryFile (round-trip)', () => {
  it('recovers frontmatter and canonical content', () => {
    const parsed = parseMemoryFile(renderMemoryFile(row()));
    expect(parsed.frontmatter.kind).toBe('decision');
    expect(parsed.frontmatter.scope).toBe('user.usr_test');
    expect(parsed.content).toBe('Token price is a constant by default.');
    expect(parsed.original).toBeUndefined();
  });

  it('splits the original-language section back out', () => {
    const parsed = parseMemoryFile(
      renderMemoryFile(
        row({
          content_original: 'トークンの価格は一定です。',
          content_lang: 'ja',
        })
      )
    );
    expect(parsed.content).toBe('Token price is a constant by default.');
    expect(parsed.original).toEqual({
      text: 'トークンの価格は一定です。',
      lang: 'ja',
    });
  });

  it('treats a file with no frontmatter as all body', () => {
    const parsed = parseMemoryFile('just a plain note');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.content).toBe('just a plain note');
  });
});
