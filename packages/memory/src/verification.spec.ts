import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VERIFICATION_TTL,
  isFastLayer,
  staleDays,
} from './verification.js';

const NOW = new Date('2026-07-29T00:00:00.000Z');
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const CORE = 'user.usr_abc_0123456789.core';
const PROJECT = 'proj.usr_abc_0123456789.zero_memory';

describe('isFastLayer', () => {
  it('admits core-scope facts and references', () => {
    expect(isFastLayer({ scope: CORE, kind: 'fact' })).toBe(true);
    expect(isFastLayer({ scope: CORE, kind: 'reference' })).toBe(true);
  });

  it('excludes the slow layer even in core scope', () => {
    // Conventions and preferences answer to the owner, not to a document —
    // a timer must never call them stale.
    expect(isFastLayer({ scope: CORE, kind: 'convention' })).toBe(false);
    expect(isFastLayer({ scope: CORE, kind: 'preference' })).toBe(false);
    expect(isFastLayer({ scope: CORE, kind: 'decision' })).toBe(false);
  });

  it('excludes project scopes whatever the kind', () => {
    // A project fact is about the project's own reality; it is never checked
    // against the outside world, and its content must not travel there.
    expect(isFastLayer({ scope: PROJECT, kind: 'fact' })).toBe(false);
    expect(isFastLayer({ scope: PROJECT, kind: 'reference' })).toBe(false);
  });

  it('does not mistake a scope merely containing "core" for the core scope', () => {
    expect(
      isFastLayer({ scope: 'proj.usr_x.core_banking', kind: 'fact' })
    ).toBe(false);
  });
});

describe('staleDays', () => {
  it('is null inside the budget', () => {
    expect(
      staleDays({ scope: CORE, kind: 'fact', created_at: daysAgo(10) }, NOW)
    ).toBeNull();
  });

  it('counts from creation when the memory was never checked', () => {
    // Unverified is not fresh — it is merely young.
    const days = staleDays(
      { scope: CORE, kind: 'fact', created_at: daysAgo(200) },
      NOW
    );
    expect(days).toBe(200);
    expect(days).toBeGreaterThan(DEFAULT_VERIFICATION_TTL.fact);
  });

  it('counts from the last check once one exists', () => {
    expect(
      staleDays(
        {
          scope: CORE,
          kind: 'fact',
          created_at: daysAgo(500),
          last_verified_at: daysAgo(20),
        },
        NOW
      )
    ).toBeNull();
  });

  it('holds references to a tighter budget than facts', () => {
    const age = { created_at: daysAgo(120) };
    expect(staleDays({ scope: CORE, kind: 'reference', ...age }, NOW)).toBe(
      120
    );
    expect(staleDays({ scope: CORE, kind: 'fact', ...age }, NOW)).toBeNull();
  });

  it('never marks the slow layer or project scopes', () => {
    const ancient = { created_at: daysAgo(9999) };
    expect(
      staleDays({ scope: CORE, kind: 'convention', ...ancient }, NOW)
    ).toBeNull();
    expect(
      staleDays({ scope: PROJECT, kind: 'fact', ...ancient }, NOW)
    ).toBeNull();
  });

  it('leaves an unparseable timestamp unmarked rather than guessing', () => {
    expect(
      staleDays({ scope: CORE, kind: 'fact', created_at: 'not-a-date' }, NOW)
    ).toBeNull();
  });
});
