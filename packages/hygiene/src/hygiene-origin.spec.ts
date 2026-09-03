import { describe, expect, it } from 'vitest';

import { crossProjectPair, type OriginSide } from './hygiene-origin.js';

const USER_SCOPE = 'user.usr_abc_123';
const proj = (name: string): OriginSide => ({
  scope: `proj.${name}`,
  source: null,
});
const imported = (flatDir: string): OriginSide => ({
  scope: USER_SCOPE,
  source: {
    kind: 'import',
    path: `/home/u/.claude/projects/${flatDir}/memory/rule.md`,
  },
});
const personal = (): OriginSide => ({ scope: USER_SCOPE, source: null });

describe('crossProjectPair', () => {
  it('two different proj scopes provably differ', () => {
    expect(crossProjectPair(proj('zero_memory'), proj('alpha'))).toBe(true);
    expect(crossProjectPair(proj('zero_memory'), proj('zero_memory'))).toBe(
      false
    );
  });

  it('scope generations of one project pair; owner segment namespaces', () => {
    const OWNER = 'usr_abc_123';
    const perOwner = (owner: string, slug: string): OriginSide => ({
      scope: `proj.${owner}.${slug}`,
      source: null,
    });
    // Legacy proj.<slug> vs per-owner proj.<owner>.<slug> of the SAME project:
    // identity is the slug, so the generations keep pairing (the blind spot
    // that silently skipped same-codebase pairs after the namespace migration).
    expect(
      crossProjectPair(proj('zero_memory'), perOwner(OWNER, 'zero_memory'))
    ).toBe(false);
    // Same owner, different slugs: provably different projects.
    expect(
      crossProjectPair(
        perOwner(OWNER, 'ulearn'),
        perOwner(OWNER, 'zero_memory')
      )
    ).toBe(true);
    // Same slug under DIFFERENT owner segments: the owner is a namespace, so
    // two customers' same-named projects never pair.
    expect(
      crossProjectPair(perOwner(OWNER, 'api'), perOwner('usr_other_9', 'api'))
    ).toBe(true);
    // Two per-owner scopes of one project are the same project.
    expect(
      crossProjectPair(
        perOwner(OWNER, 'zero_memory'),
        perOwner(OWNER, 'zero_memory')
      )
    ).toBe(false);
    // Per-owner scope vs the project's imported knowledge still matches on
    // the slug boundary.
    expect(
      crossProjectPair(
        perOwner(OWNER, 'zero_memory'),
        imported('-home-u-repos-zero-memory')
      )
    ).toBe(false);
    expect(
      crossProjectPair(
        perOwner(OWNER, 'zero_memory'),
        imported('-home-u-repos-1-alpha')
      )
    ).toBe(true);
  });

  it('a bare-slug scope (no proj. root) stays unknown and never blocks', () => {
    const bare: OriginSide = { scope: 'ulearn', source: null };
    expect(crossProjectPair(bare, proj('zero_memory'))).toBe(false);
    expect(crossProjectPair(bare, bare)).toBe(false);
  });

  it('two imports differ only when their origin dirs differ', () => {
    expect(
      crossProjectPair(
        imported('-home-u-repos-1-alpha'),
        imported('-home-u-repos-1-alpha')
      )
    ).toBe(false);
    expect(
      crossProjectPair(
        imported('-home-u-repos-1-alpha'),
        imported('-home-u-repos-zero-memory')
      )
    ).toBe(true);
  });

  it('proj scope vs import matches on the repo-name boundary suffix', () => {
    // another project's rule imported into the personal scope vs this project.
    expect(
      crossProjectPair(proj('zero_memory'), imported('-home-u-repos-1-alpha'))
    ).toBe(true);
    // zero-memory's own imported knowledge pairs with its project scope
    // (underscore in the scope name maps to the dash in the repo dir).
    expect(
      crossProjectPair(
        proj('zero_memory'),
        imported('-home-u-repos-zero-memory')
      )
    ).toBe(false);
    // no false boundary match on a name that merely ends with the same word
    expect(
      crossProjectPair(proj('alpha'), imported('-home-u-repos-myalpha'))
    ).toBe(true);
  });

  it('unknown origin never blocks a pair (personal notes, no provenance)', () => {
    // A queued-task brief in the personal scope vs its project's completion
    // report — the dominant legit cross-scope supersedes — must keep pairing.
    expect(crossProjectPair(personal(), proj('zero_memory'))).toBe(false);
    expect(
      crossProjectPair(personal(), imported('-home-u-repos-1-alpha'))
    ).toBe(false);
    expect(crossProjectPair(personal(), personal())).toBe(false);
  });

  it('non-import or malformed provenance stays unknown', () => {
    const oddSource: OriginSide = {
      scope: USER_SCOPE,
      source: { kind: 'transcript', path: '/somewhere/else' },
    };
    expect(crossProjectPair(oddSource, proj('alpha'))).toBe(false);
    const noPath: OriginSide = {
      scope: USER_SCOPE,
      source: { kind: 'import' },
    };
    expect(crossProjectPair(noPath, proj('alpha'))).toBe(false);
  });
});
