import { describe, expect, it } from 'vitest';

import {
  cardBranchViewSchema,
  cardInputSchema,
  cardRefSchema,
  formatBoardName,
  formatBranchRef,
  formatCardLabel,
  gitCommitShaSchema,
  isGitBranchName,
  parseBranchRef,
} from './card.schema.js';

describe('git names on a card', () => {
  it.each(['main', 'feature/card-branches', 'release/1.2', 'fix/a+b'])(
    'accepts the branch %s',
    (name) => expect(isGitBranchName(name)).toBe(true)
  );

  it.each([
    '',
    'has space',
    'a..b',
    '-lead',
    'trail/',
    'x:y',
    'a~1',
    'a^',
    'a?',
    'a*',
    'a[b',
    'a\\b',
  ])('refuses the branch %j', (name) =>
    expect(isGitBranchName(name)).toBe(false)
  );

  it('keeps a sha lower-case and refuses what is not one', () => {
    expect(gitCommitShaSchema.parse('ABCDEF1')).toBe('abcdef1');
    expect(gitCommitShaSchema.safeParse('abc').success).toBe(false);
    expect(gitCommitShaSchema.safeParse('xyz1234').success).toBe(false);
  });

  it('writes a branch as <repo>:<branch> and reads it back at the first colon', () => {
    const branch = { repo: 'kiwagu/zero-memory', name: 'feature/x' };
    expect(formatBranchRef(branch)).toBe('kiwagu/zero-memory:feature/x');
    expect(parseBranchRef('kiwagu/zero-memory:feature/x')).toEqual(branch);
    expect(parseBranchRef('no-colon')).toBeNull();
    expect(parseBranchRef('a b:feature/x')).toBeNull();
    expect(parseBranchRef('owner/name:')).toBeNull();
  });

  it('reads every landing of a branch, and a server that sends none', () => {
    const branch = {
      repo: 'o/n',
      branch: 'feature/x',
      state: 'landed',
      squash_sha: 'bbbbbbb',
      target: 'main',
      landed_at: '2026-09-23T15:00:00Z',
      attached_at: '2026-09-23T12:00:00Z',
    };
    const landings = [
      {
        squash_sha: 'aaaaaaa',
        target: 'main',
        landed_at: '2026-09-23T13:00:00Z',
      },
      {
        squash_sha: 'bbbbbbb',
        target: 'main',
        landed_at: '2026-09-23T15:00:00Z',
      },
    ];
    expect(
      cardBranchViewSchema
        .parse({ ...branch, landings })
        .landings.map((l) => l.squash_sha)
    ).toEqual(['aaaaaaa', 'bbbbbbb']);
    expect(cardBranchViewSchema.parse(branch).landings).toEqual([]);
  });

  it('labels a card ZM-N, the one name it has everywhere', () => {
    expect(formatCardLabel(21)).toBe('ZM-21');
  });

  it("names a card's board by its slug, never by the owner segment", () => {
    expect(formatBoardName('proj.usr_ab12_01k.acme')).toBe('acme');
    expect(formatBoardName('user.usr_ab12_01k.core')).toBe('core');
    expect(formatBoardName('usr_ab12_01k')).toBe('usr_ab12_01k');
  });

  it('knows a branch reference and the land action', () => {
    expect(
      cardRefSchema.safeParse({ kind: 'branch', repo: 'o/n', name: 'main' })
        .success
    ).toBe(true);
    expect(
      cardInputSchema.safeParse({
        action: 'land',
        card_id: 'crd_0000000000000000.0000000000',
        branch: { repo: 'o/n', name: 'feature/x' },
        squash_sha: 'abcdef1',
        target: 'main',
        reason: 'gate green',
      }).success
    ).toBe(true);
  });
});
