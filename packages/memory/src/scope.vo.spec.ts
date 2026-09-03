import { describe, expect, it } from 'vitest';

import { Scope } from './scope.vo.js';

describe('Scope', () => {
  it('accepts rooted ltree paths', () => {
    for (const path of [
      'user.abc',
      'user.abc.core',
      'proj.zero_memory',
      'proj.acme.api_v2',
      'team.usr_a.acme',
    ]) {
      const result = Scope.create(path);
      expect(result.isOk(), path).toBe(true);
      expect(result.unwrap().path).toBe(path);
    }
  });

  it('rejects invalid paths', () => {
    for (const path of [
      '',
      'User.abc',
      'proj.acme-api',
      '.proj',
      'proj.',
      'proj..api',
      'proj acme',
      'プロジェクト.acme',
    ]) {
      expect(Scope.create(path).isErr(), JSON.stringify(path)).toBe(true);
    }
  });

  it('rejects bare and unrooted labels with a hint', () => {
    // Bare slugs ('ulearn') and placeholder literals ('user', 'project')
    // pass the ltree pattern but land outside every read set.
    for (const path of ['ulearn', 'user', 'proj', 'project', 'a.b.c.d']) {
      const result = Scope.create(path);
      expect(result.isErr(), path).toBe(true);
    }
    expect(Scope.create('ulearn').unwrapErr()).toContain('rooted ltree path');
  });

  it('reconstitutes legacy stored scopes leniently', () => {
    // Rows written before creation was hardened must keep reading.
    expect(Scope.fromStored('ulearn').isOk()).toBe(true);
    expect(Scope.fromStored('proj.zero_memory').isOk()).toBe(true);
    expect(Scope.fromStored('Not Ltree!').isErr()).toBe(true);
  });

  it('builds a personal scope from a uuid (hyphens become underscores)', () => {
    const scope = Scope.user('6F9A1E52-0B45-4B0E-9C1D-2A9B8C7D6E5F');
    expect(scope.path).toBe('user.6f9a1e52_0b45_4b0e_9c1d_2a9b8c7d6e5f');
  });

  it('builds a personal scope from a usr_ id (the dot becomes an underscore)', () => {
    const scope = Scope.user('usr_000000000000000a.0000000000');
    expect(scope.path).toBe('user.usr_000000000000000a_0000000000');
  });

  it('builds a per-owner project scope from an owner id and a slug', () => {
    expect(
      Scope.project('usr_000000000000000a.0000000000', 'Zero-Memory').path
    ).toBe('proj.usr_000000000000000a_0000000000.zero_memory');
  });

  it('keeps two owners with the same slug in separate project scopes', () => {
    const a = Scope.project('usr_000000000000000a.0000000000', 'api');
    const b = Scope.project('usr_000000000000000b.0000000000', 'api');
    expect(a.path).not.toBe(b.path);
    expect(a.isShareable).toBe(true);
  });

  it('builds a personal core scope as a child of the personal scope', () => {
    const scope = Scope.core('usr_000000000000000a.0000000000');
    expect(scope.path).toBe('user.usr_000000000000000a_0000000000.core');
    expect(scope.isPersonal).toBe(true);
    expect(scope.isShareable).toBe(false);
  });

  it('compares by value', () => {
    expect(
      Scope.create('proj.a').unwrap().equals(Scope.create('proj.a').unwrap())
    ).toBe(true);
  });
});
