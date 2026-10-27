import type { WebTranslator } from '@workspace/i18n-catalogs/web';
import { CROCKFORD_CANONICAL_CLASS } from 'entity-id';
import { describe, expect, it } from 'vitest';

import {
  annotateFacetOptions,
  facetCountIndex,
  facetTotal,
  FEED_STATUSES,
  filterFeedStatus,
  MEM_ID_QUERY_RE,
  memoryBadges,
  memoryClient,
  memoryIdSearchPrefix,
  parseFeedStatus,
  sharingBadge,
  type FeedStatus,
  type MemoryRow,
} from './memory';

/** Only agent_name + source are read; the rest is padding for the type. */
const row = (agent_name: string | null, source: unknown): MemoryRow =>
  ({ agent_name, source }) as unknown as MemoryRow;

/** Key-echoing translator: asserts keys, not copy. */
const t: WebTranslator = (key, vars) =>
  vars ? `${key}${JSON.stringify(vars)}` : key;

describe('memoryClient', () => {
  it('normalizes a direct-write agent_name (clientInfo.name) to a brand', () => {
    expect(memoryClient(row('claude-code', null))).toBe('Claude Code');
    expect(memoryClient(row('cursor-vscode', null))).toBe('Cursor');
    expect(memoryClient(row('codex-cli', null))).toBe('Codex');
  });

  it('reads the ingest client from source.client when agent_name is generic', () => {
    expect(memoryClient(row('watcher', { client: 'cursor-stop-hook' }))).toBe(
      'Cursor'
    );
    expect(memoryClient(row('watcher', { client: 'codex-stop-hook' }))).toBe(
      'Codex'
    );
    expect(
      memoryClient(row('watcher', { client: 'claude-code-stop-hook' }))
    ).toBe('Claude Code');
  });

  it('falls back to the generic agent_name when there is no source client', () => {
    expect(memoryClient(row('watcher', null))).toBe('watcher');
    expect(memoryClient(row('bootstrap', { kind: 'bootstrap' }))).toBe(
      'bootstrap'
    );
  });

  it('is null for an authoritative import (no agent_name, no client)', () => {
    expect(memoryClient(row(null, { kind: 'import' }))).toBeNull();
  });

  it('passes an unknown identifier through unchanged', () => {
    expect(memoryClient(row('some-other-tool', null))).toBe('some-other-tool');
  });
});

describe('sharingBadge', () => {
  it('a private memory reads "private"', () => {
    expect(sharingBadge('private', undefined, t)).toEqual({
      label: 'visibility.private',
      variant: 'secondary',
      testId: 'memory-visibility-badge',
    });
  });

  it('a shareable scope with only the owner reads "sharable"', () => {
    for (const count of [0, 1]) {
      expect(sharingBadge('shared', count, t)).toEqual({
        label: 'visibility.sharable',
        variant: 'secondary',
        testId: 'memory-visibility-badge',
      });
    }
  });

  it('a scope with members beyond the owner reads "shared"', () => {
    expect(sharingBadge('shared', 2, t)).toEqual({
      label: 'visibility.shared',
      variant: 'green',
      testId: 'memory-visibility-badge',
    });
  });

  it('an unknown count degrades to "shared" rather than understating', () => {
    expect(sharingBadge('shared', undefined, t)).toEqual({
      label: 'visibility.shared',
      variant: 'green',
      testId: 'memory-visibility-badge',
    });
  });
});

describe('parseFeedStatus', () => {
  it('defaults to active for an absent or unknown param', () => {
    expect(parseFeedStatus(undefined)).toBe('active');
    expect(parseFeedStatus('')).toBe('active');
    expect(parseFeedStatus('retired')).toBe('active');
  });

  it('passes the known statuses through', () => {
    for (const status of [
      'active',
      'live',
      'superseded',
      'invalidated',
      'all',
    ]) {
      expect(parseFeedStatus(status)).toBe(status);
    }
  });
});

type Lifecycle = Pick<MemoryRow, 'invalidated_at' | 'superseded_by'>;
type LifecycleColumn = keyof Lifecycle;

/**
 * Stands in for the PostgREST builder: it evaluates the conditions the feed
 * query is given against one row, with the database's null semantics. A
 * condition it does not recognise fails the test instead of passing it.
 */
class RowQuery {
  admitted = true;

  constructor(private readonly row: Lifecycle) {}

  or(filters: string): RowQuery {
    const any = filters.split(',').map((filter) => {
      const match = /^(invalidated_at|superseded_by)\.(not\.)?is\.null$/.exec(
        filter
      );
      if (!match) {
        throw new Error(`unexpected or() filter: ${filter}`);
      }
      const isNull = this.row[match[1] as LifecycleColumn] === null;
      return match[2] ? !isNull : isNull;
    });
    this.admitted = this.admitted && any.some(Boolean);
    return this;
  }

  is(column: LifecycleColumn, value: null): RowQuery {
    this.admitted = this.admitted && this.row[column] === value;
    return this;
  }

  not(column: LifecycleColumn, operator: 'is', value: null): RowQuery {
    expect(operator).toBe('is');
    this.admitted = this.admitted && this.row[column] !== value;
    return this;
  }
}

describe('the feed status filter', () => {
  const memories = {
    live: { invalidated_at: null, superseded_by: null },
    // Retired WITH a successor: a historical version, its content lives on.
    historical: {
      invalidated_at: '2026-07-27T10:00:00Z',
      superseded_by: 'mem_new',
    },
    // Retired with NOTHING replacing it: a forget, a conflict resolution, or
    // a hygiene auto-invalidation — possibly a false one.
    lone: { invalidated_at: '2026-07-27T10:00:00Z', superseded_by: null },
  } satisfies Record<string, Lifecycle>;

  /** What each status shows: the one table the query and the live feed answer to. */
  const shows: Record<FeedStatus, (keyof typeof memories)[]> = {
    // The default hides historical versions only: a disappearance without a
    // successor stays observable, so a false invalidation cannot hide
    // behind "history".
    active: ['live', 'lone'],
    // The open-loop reading drops the lone invalidations too.
    live: ['live'],
    superseded: ['historical'],
    invalidated: ['lone'],
    all: ['live', 'historical', 'lone'],
  };

  it.each(FEED_STATUSES)(
    '"%s" shows exactly its memories in the feed query',
    (status) => {
      for (const [name, memory] of Object.entries(memories)) {
        const expected = shows[status].includes(name as keyof typeof memories);
        expect(
          filterFeedStatus(new RowQuery(memory), status).admitted,
          `${name} in the feed query`
        ).toBe(expected);
      }
    }
  );
});

describe('facet availability', () => {
  const counts = facetCountIndex([
    { facet: 'kind', value: 'decision', total: 12 },
    { facet: 'kind', value: 'task', total: 3 },
    { facet: 'status', value: 'invalidated', total: 6 },
  ]);
  const kinds = [
    { value: 'decision', label: 'Decision' },
    { value: 'task', label: 'Task' },
    // Absent from the counts: nothing to show under the current selection.
    { value: 'episode', label: 'Episode' },
  ];

  it('annotates every option and disables the empty ones', () => {
    const options = annotateFacetOptions(kinds, 'kind', counts, '');
    expect(options).toEqual([
      { value: 'decision', label: 'Decision', count: 12, disabled: false },
      { value: 'task', label: 'Task', count: 3, disabled: false },
      { value: 'episode', label: 'Episode', count: 0, disabled: true },
    ]);
  });

  it('never disables the applied value, so it can be switched away from', () => {
    const options = annotateFacetOptions(kinds, 'kind', counts, 'episode');
    expect(options[2]).toEqual({
      value: 'episode',
      label: 'Episode',
      count: 0,
      disabled: false,
    });
  });

  it('reads a facet it has no rows for as all-zero', () => {
    const options = annotateFacetOptions(
      [{ value: 'private', label: 'Private' }],
      'visibility',
      counts,
      ''
    );
    expect(options[0]?.count).toBe(0);
    expect(options[0]?.disabled).toBe(true);
  });

  it('sums a facet for its "any value" placeholder, per facet', () => {
    expect(facetTotal(counts, 'kind')).toBe(15);
    expect(facetTotal(counts, 'status')).toBe(6);
    expect(facetTotal(counts, 'visibility')).toBe(0);
  });
});

describe('memoryBadges', () => {
  const shared = (visibility: string): MemoryRow =>
    ({
      kind: 'decision',
      scope: 'proj.zero_memory',
      visibility,
      author_kind: 'agent',
      agent_name: 'claude',
      source: null,
      invalidated_at: null,
    }) as unknown as MemoryRow;

  it('places the sharing badge second and honours the member count', () => {
    const sharable = memoryBadges(shared('shared'), t, 1);
    expect(sharable[1]).toEqual({
      label: 'visibility.sharable',
      variant: 'secondary',
      testId: 'memory-visibility-badge',
    });

    const trulyShared = memoryBadges(shared('shared'), t, 3);
    expect(trulyShared[1]?.label).toBe('visibility.shared');
    expect(trulyShared[1]?.variant).toBe('green');
  });

  it('names the dashboard rather than showing its internal identifier', () => {
    // A memory the owner typed into the merge form: the first provenance a
    // reader sees that is NOT an agent's, so neither half may read as jargon.
    const typedByTheOwner = {
      kind: 'decision',
      scope: 'proj.zero_memory',
      visibility: 'private',
      author_kind: 'human',
      agent_name: 'zm-web',
      source: null,
      invalidated_at: null,
    } as unknown as MemoryRow;

    expect(memoryBadges(typedByTheOwner, t)[3]?.label).toBe(
      'human · Dashboard'
    );
  });
});

/**
 * The id-search prefilter hand-copies the Crockford character class, because
 * web cannot import `@workspace/contracts` (its NodeNext `.js` internals do not
 * resolve under Turbopack). A copy with no test drifts silently the day the
 * canonical class changes, so this pins the two together.
 *
 * The test can import `entity-id` even though the app cannot import contracts:
 * vitest resolves normally, and the constant is a plain string with no runtime
 * dependency. It never reaches the browser bundle.
 */
describe('memoryIdSearchPrefix mirrors the canonical id alphabet', () => {
  it('uses the same character class as the entity-id package', () => {
    // Both segments, not just one: a `toContain` check passes while half the
    // pattern has drifted, because the other half still holds the class.
    const occurrences =
      MEM_ID_QUERY_RE.source.split(CROCKFORD_CANONICAL_CLASS).length - 1;
    expect(occurrences).toBe(2);
  });

  it('accepts a full id and any copied fragment of one', () => {
    expect(memoryIdSearchPrefix('mem_a1b2c3d4e5f6g7h8.01jd8x2p4q')).toBe(
      'mem_a1b2c3d4e5f6g7h8.01jd8x2p4q'
    );
    expect(memoryIdSearchPrefix('  MEM_A1B2  ')).toBe('mem_a1b2');
  });

  it('falls through to content search for a non-id query', () => {
    // `i`, `l`, `o` and `u` are excluded from Crockford base32, so a word
    // containing them is prose, not a truncated id.
    expect(memoryIdSearchPrefix('mem_hello')).toBeNull();
    expect(memoryIdSearchPrefix('postgres')).toBeNull();
  });
});
