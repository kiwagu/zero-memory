import type { WebTranslator } from '@workspace/i18n-catalogs/web';
import { CROCKFORD_CANONICAL_CLASS } from 'entity-id';
import { describe, expect, it } from 'vitest';

import {
  annotateFacetOptions,
  facetCountIndex,
  facetTotal,
  matchesFeedStatus,
  MEM_ID_QUERY_RE,
  memoryBadges,
  memoryClient,
  memoryIdSearchPrefix,
  parseFeedStatus,
  sharingBadge,
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

describe('matchesFeedStatus', () => {
  const live = { invalidated_at: null, superseded_by: null };
  // Retired WITH a successor: a historical version, its content lives on.
  const historical = {
    invalidated_at: '2026-07-27T10:00:00Z',
    superseded_by: 'mem_new',
  };
  // Retired with NOTHING replacing it: a forget, a conflict resolution, or a
  // hygiene auto-invalidation — possibly a false one.
  const lone = { invalidated_at: '2026-07-27T10:00:00Z', superseded_by: null };

  it('the default view hides historical versions only', () => {
    expect(matchesFeedStatus(live, 'active')).toBe(true);
    expect(matchesFeedStatus(historical, 'active')).toBe(false);
    // The point of the whole filter: a disappearance without a successor stays
    // observable, so a false invalidation cannot hide behind "history".
    expect(matchesFeedStatus(lone, 'active')).toBe(true);
  });

  it('"superseded" is exactly the hidden set', () => {
    expect(matchesFeedStatus(historical, 'superseded')).toBe(true);
    expect(matchesFeedStatus(live, 'superseded')).toBe(false);
    expect(matchesFeedStatus(lone, 'superseded')).toBe(false);
  });

  it('"invalidated" is the lone retirements, without the version history', () => {
    expect(matchesFeedStatus(lone, 'invalidated')).toBe(true);
    expect(matchesFeedStatus(historical, 'invalidated')).toBe(false);
    expect(matchesFeedStatus(live, 'invalidated')).toBe(false);
  });

  it('"live" drops the lone invalidations too — the open-loop reading', () => {
    expect(matchesFeedStatus(live, 'live')).toBe(true);
    expect(matchesFeedStatus(lone, 'live')).toBe(false);
    expect(matchesFeedStatus(historical, 'live')).toBe(false);
  });

  it('"all" hides nothing', () => {
    for (const memory of [live, historical, lone]) {
      expect(matchesFeedStatus(memory, 'all')).toBe(true);
    }
  });
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
