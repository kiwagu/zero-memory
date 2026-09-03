/**
 * The provenance panel is the one screen that prints whatever the ingest path
 * put into `source`. These specs pin the property that keeps a machine's
 * directory layout off a shared screen: a path shows as its file name, and the
 * full value is still carried for the tooltip.
 */
import { describe, expect, it } from 'vitest';

import {
  memoryThreadToken,
  pathBasename,
  provenanceEntries,
} from './provenance-view';

describe('pathBasename', () => {
  it.each([
    ['/var/log/zm/session.jsonl', 'session.jsonl'],
    ['C:\\Users\\me\\notes\\design.md', 'design.md'],
    ['notes/design.md', 'design.md'],
    ['design.md', 'design.md'],
    ['/trailing/slash/', 'slash'],
  ])('reduces %s to %s', (input, expected) => {
    expect(pathBasename(input)).toBe(expected);
  });
});

describe('provenanceEntries', () => {
  it('shows a path by its file name and keeps the full value for the tooltip', () => {
    const [entry] = provenanceEntries({
      path: '/home/someone/private/notes/design.md',
    });

    expect(entry).toEqual({
      key: 'path',
      display: 'design.md',
      full: '/home/someone/private/notes/design.md',
    });
  });

  it('leaves non-path fields exactly as they are', () => {
    // The audit story lives in these: which tool, which session, which hash.
    const entries = provenanceEntries({
      kind: 'transcript',
      client: 'claude-code-stop-hook',
      session: 'ses_abc123',
      hash: 'sha256:deadbeef',
    });

    expect(entries.map((entry) => entry.display)).toEqual([
      'transcript',
      'claude-code-stop-hook',
      'ses_abc123',
      'sha256:deadbeef',
    ]);
    expect(entries.every((entry) => entry.full === undefined)).toBe(true);
  });

  it('adds no tooltip when the path is already a bare file name', () => {
    expect(provenanceEntries({ path: 'design.md' })).toEqual([
      { key: 'path', display: 'design.md' },
    ]);
  });

  it('renders a nested value instead of dropping it', () => {
    const [entry] = provenanceEntries({ routing: { reason: 'project-hint' } });

    expect(entry?.display).toBe('{"reason":"project-hint"}');
  });
});

describe('memoryThreadToken', () => {
  it('reads the conversation a memory was born in', () => {
    expect(
      memoryThreadToken({ thread: 'thr_000000000000000a.0000000000' })
    ).toBe('thr_000000000000000a.0000000000');
  });

  it('is null for a memory written outside any conversation', () => {
    // Import, bootstrap, terminal capture, and everything stored before the
    // marker existed: no conversation to point at.
    expect(memoryThreadToken({ client: 'zm-import' })).toBeNull();
    expect(memoryThreadToken(null)).toBeNull();
  });

  it('ignores a value that is not a thread token', () => {
    // The panel prints whatever `source` holds; only a well-formed token may
    // drive a query for "other facts from this session".
    expect(memoryThreadToken({ thread: 'ses_abc123' })).toBeNull();
    expect(memoryThreadToken({ thread: 42 })).toBeNull();
  });
});
