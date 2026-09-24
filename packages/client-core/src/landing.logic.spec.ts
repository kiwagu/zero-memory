import { describe, expect, it } from 'vitest';

import {
  escapeGitRegex,
  isLandingRecorded,
  parseSquashTrailers,
  renderLandingDrift,
  renderLandingReminder,
  repoIdentityFromRemote,
} from './landing.logic.js';

describe('parseSquashTrailers', () => {
  it('reads the branch, its tip and the cards of a squash', () => {
    expect(
      parseSquashTrailers(
        'feat(board): cards know their branches\n\n' +
          'Squashed-from: feature/card-branches (1a2b3c4) ZM-19 ZM-20\n'
      )
    ).toEqual([
      { branch: 'feature/card-branches', tipSha: '1a2b3c4', cards: [19, 20] },
    ]);
  });

  it('understands the earlier #N form', () => {
    expect(
      parseSquashTrailers('x\n\nSquashed-from: fix/window (7495563) #14')
    ).toEqual([{ branch: 'fix/window', tipSha: '7495563', cards: [14] }]);
  });

  it('keeps a squash that names no card, with no cards to check', () => {
    expect(
      parseSquashTrailers('x\n\nSquashed-from: feature/a (abcdef1)')
    ).toEqual([{ branch: 'feature/a', tipSha: 'abcdef1', cards: [] }]);
  });

  it('ignores a trailer quoted mid-line or malformed', () => {
    expect(
      parseSquashTrailers('docs: explain `Squashed-from: x (abcdef1) ZM-1`')
    ).toEqual([]);
    expect(
      parseSquashTrailers('Squashed-from: feature/a (not-a-sha) ZM-1')
    ).toEqual([]);
  });
});

describe('repoIdentityFromRemote', () => {
  it.each([
    ['git@github.com:kiwagu/zero-memory.git', 'kiwagu/zero-memory'],
    ['https://github.com/kiwagu/zero-memory', 'kiwagu/zero-memory'],
    ['https://github.com/kiwagu/zero-memory.git/', 'kiwagu/zero-memory'],
    ['ssh://git@gitlab.example.com:2222/group/sub/repo.git', 'sub/repo'],
    ['/srv/git/team/tools.git', 'team/tools'],
  ])('names %s as %s', (url, identity) => {
    expect(repoIdentityFromRemote(url)).toBe(identity);
  });

  it('gives up on a url with nothing to name it by', () => {
    expect(repoIdentityFromRemote('')).toBeNull();
    expect(repoIdentityFromRemote('tools.git')).toBeNull();
  });
});

describe('escapeGitRegex', () => {
  it('makes a branch name match only itself', () => {
    const pattern = new RegExp(`^${escapeGitRegex('release/1.2+fix')}$`, 'u');
    expect(pattern.test('release/1.2+fix')).toBe(true);
    expect(pattern.test('release/1x2+fix')).toBe(false);
  });
});

describe('isLandingRecorded', () => {
  const landed = [
    {
      repo: 'o/n',
      branch: 'feature/x',
      state: 'landed' as const,
      squash_sha: 'abcdef1',
    },
  ];

  it('matches a short and a full sha either way round', () => {
    expect(
      isLandingRecorded(landed, 'o/n', 'feature/x', 'abcdef1234567890')
    ).toBe(true);
    expect(
      isLandingRecorded(
        [{ ...landed[0]!, squash_sha: 'abcdef1234567890' }],
        'o/n',
        'feature/x',
        'ABCDEF1'
      )
    ).toBe(true);
  });

  it('counts every landing of a branch that landed more than once', () => {
    const relanded = [
      {
        ...landed[0]!,
        squash_sha: 'bbbbbbb',
        landings: [{ squash_sha: 'abcdef1' }, { squash_sha: 'bbbbbbb' }],
      },
    ];
    // The earlier squash, by a full sha, is on record too.
    expect(
      isLandingRecorded(relanded, 'o/n', 'feature/x', 'abcdef1234567890')
    ).toBe(true);
    expect(isLandingRecorded(relanded, 'o/n', 'feature/x', 'bbbbbbb')).toBe(
      true
    );
    expect(isLandingRecorded(relanded, 'o/n', 'feature/x', '1234567')).toBe(
      false
    );
    // A server that sends no landings: only the latest counts, as before.
    expect(
      isLandingRecorded(
        [{ ...landed[0]!, squash_sha: 'bbbbbbb' }],
        'o/n',
        'feature/x',
        'abcdef1'
      )
    ).toBe(false);
  });

  it('does not take an open branch, another commit or another repository for a landing', () => {
    expect(
      isLandingRecorded(
        [{ ...landed[0]!, state: 'open', squash_sha: null }],
        'o/n',
        'feature/x',
        'abcdef1'
      )
    ).toBe(false);
    expect(isLandingRecorded(landed, 'o/n', 'feature/x', '1234567')).toBe(
      false
    );
    expect(isLandingRecorded(landed, 'o/other', 'feature/x', 'abcdef1')).toBe(
      false
    );
  });
});

describe('the landing lines', () => {
  const facts = {
    cardId: 'crd_0000000000000019.0000000000',
    cardNumber: 19,
    repo: 'kiwagu/zero-memory',
    branch: 'feature/card-branches',
    squashSha: '1a2b3c4d5e6f',
    target: 'main',
  };

  it('tells the agent exactly what to record, on one line', () => {
    const line = renderLandingReminder(facts);
    expect(line).not.toContain('\n');
    expect(line).toContain('card ZM-19');
    expect(line).not.toContain('#19');
    expect(line).toContain('"action":"land"');
    expect(line).toContain('"card_id":"crd_0000000000000019.0000000000"');
    expect(line).toContain(
      '"branch":{"repo":"kiwagu/zero-memory","name":"feature/card-branches"}'
    );
    expect(line).toContain('"squash_sha":"1a2b3c4"');
    expect(line).toContain('"target":"main"');
  });

  it('names the drift a briefing found', () => {
    const line = renderLandingDrift({ ...facts, state: 'active' });
    expect(line).toMatch(/^- ZM-19 \[active\]: /u);
    expect(line).toContain('feature/card-branches landed as 1a2b3c4 on main');
    expect(line).toContain('card land');
  });
});
