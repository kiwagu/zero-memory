import { describe, expect, it } from 'vitest';

import {
  boardCardSchema,
  briefingWorkCardSchema,
  briefingWorkSchema,
  cardBranchViewSchema,
  cardEventSchema,
  cardSeveritySchema,
  cardTypeSchema,
  CARD_SEVERITY_DEFAULT,
  formatBoardName,
  formatBranchRef,
  formatCardLabel,
  gitCommitShaSchema,
  isGitBranchName,
  parseBranchRef,
  cardWorkStepSchema,
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
});

describe('briefingWorkSchema continuation', () => {
  it('reads the card a new session is offered, and a server that sends none', () => {
    const base = { bound_card: null, active: 1, waiting: 0, lead: [] };
    expect(briefingWorkSchema.parse(base).continuation).toBeUndefined();
    const offered = briefingWorkSchema.parse({
      ...base,
      continuation: {
        card: {
          id: 'crd_0000000000000030.0000000000',
          number: 30,
          title: 'Continue',
          state: 'active',
          state_reason: 'picked up',
          blocked_by: [],
          above: [
            {
              number: 1,
              title: 'North star',
              state: 'active',
              relation: 'child_of',
            },
          ],
          links_assessed: true,
        },
        last: [
          {
            type: 'noted',
            from_state: null,
            to_state: null,
            text: 'x',
            created_at: '2026-09-25T17:58:00+00:00',
          },
        ],
        last_session: {
          number: 29,
          title: 'Relations',
          type: 'moved',
          to_state: 'waiting',
        },
        thread: 'thr_0000000000000001.0000000000',
      },
    });
    expect(offered.continuation?.card?.number).toBe(30);
    expect(offered.continuation?.card?.above?.[0]?.relation).toBe('child_of');
    expect(offered.continuation?.last_session?.to_state).toBe('waiting');
  });
});

describe('the cards I worked on', () => {
  const row = {
    id: 'crd_0000000000000031.0000000000',
    scope: 'proj.usr_0000000000000001_0000000000.acme',
    number: 31,
    title: 'Mine',
    state: 'active',
    updated_at: '2026-09-26T06:39:00+00:00',
    archived_at: null,
    refs: 1,
    last_event: null,
  };

  it('reads my latest step and the horizon mark, and a row without them', () => {
    const step = {
      type: 'moved',
      from_state: 'idea',
      to_state: 'active',
      text: 'picked up',
      created_at: '2026-09-26T06:39:00+00:00',
    };
    const mine = boardCardSchema.parse({
      ...row,
      my_last: step,
      past_horizon: false,
    });
    expect(mine.my_last).toEqual(cardWorkStepSchema.parse(step));
    expect(mine.past_horizon).toBe(false);
    const plain = boardCardSchema.parse(row);
    expect(plain.my_last).toBeUndefined();
    expect(plain.past_horizon).toBeUndefined();
  });
});

describe('a card carries a severity', () => {
  it('reads one level from 1 to 5, and refuses anything else', () => {
    expect(cardSeveritySchema.parse(1)).toBe(1);
    expect(cardSeveritySchema.parse(5)).toBe(5);
    for (const level of [0, 6, 2.5, '3', null]) {
      expect(cardSeveritySchema.safeParse(level).success).toBe(false);
    }
    expect(CARD_SEVERITY_DEFAULT).toBe(3);
  });

  it('reads a board row from a server that predates severity as normal', () => {
    const row = {
      id: 'crd_0000000000000044.0000000000',
      scope: 'proj.usr_0000000000000001_0000000000.acme',
      number: 44,
      title: 'Hotfix',
      state: 'active',
      updated_at: '2026-09-29T17:00:00+00:00',
      archived_at: null,
      refs: 0,
      last_event: null,
    };
    expect(boardCardSchema.parse(row).severity).toBe(3);
    expect(boardCardSchema.parse({ ...row, severity: 5 }).severity).toBe(5);
    expect(boardCardSchema.safeParse({ ...row, severity: 9 }).success).toBe(
      false
    );
  });

  it('reads which levels an edit moved between, and an edit that moved none', () => {
    const event = {
      id: 'cev_0000000000000002.0000000000',
      seq: 2,
      type: 'edited',
      actor_id: 'usr_0000000000000001.0000000000',
      agent_label: null,
      thread: null,
      from_state: null,
      to_state: null,
      reason: null,
      revision: 2,
      text: null,
      reply_to: null,
      relation: null,
      ref_kind: null,
      ref_target: null,
      created_at: '2026-09-29T17:00:00+00:00',
    };
    const moved = cardEventSchema.parse({
      ...event,
      from_severity: 3,
      to_severity: 5,
    });
    expect([moved.from_severity, moved.to_severity]).toEqual([3, 5]);
    const plain = cardEventSchema.parse(event);
    expect([plain.from_severity, plain.to_severity]).toEqual([null, null]);
  });
});

describe('a card carries a type', () => {
  it('reads one of story, bug, task or spike, and refuses anything else', () => {
    for (const type of ['story', 'bug', 'task', 'spike']) {
      expect(cardTypeSchema.parse(type)).toBe(type);
    }
    for (const type of ['Bug', 'epic', 'subtask', '', null, 1]) {
      expect(cardTypeSchema.safeParse(type).success).toBe(false);
    }
  });

  it('reads a card from a server that predates types as not declared', () => {
    const row = {
      id: 'crd_0000000000000045.0000000000',
      scope: 'proj.usr_0000000000000001_0000000000.acme',
      number: 45,
      title: 'Card types',
      state: 'active',
      updated_at: '2026-09-30T17:00:00+00:00',
      archived_at: null,
      refs: 0,
      last_event: null,
    };
    expect(boardCardSchema.parse(row).type).toBeNull();
    expect(boardCardSchema.parse({ ...row, type: 'bug' }).type).toBe('bug');
    expect(boardCardSchema.safeParse({ ...row, type: 'epic' }).success).toBe(
      false
    );
    const named = {
      id: row.id,
      number: 45,
      title: 'Card types',
      state: 'active',
    };
    expect(briefingWorkCardSchema.parse(named).type).toBeUndefined();
    expect(
      briefingWorkCardSchema.parse({ ...named, type: null }).type
    ).toBeNull();
  });

  it('reads the types an edit or a move declared, and a step that set none', () => {
    const event = {
      id: 'cev_0000000000000003.0000000000',
      seq: 3,
      type: 'moved',
      actor_id: 'usr_0000000000000001.0000000000',
      agent_label: null,
      thread: null,
      from_state: 'idea',
      to_state: 'active',
      reason: 'picked up',
      revision: null,
      text: null,
      reply_to: null,
      relation: null,
      ref_kind: null,
      ref_target: null,
      created_at: '2026-09-30T17:00:00+00:00',
    };
    const declared = cardEventSchema.parse({
      ...event,
      from_card_type: null,
      to_card_type: 'task',
    });
    expect([declared.from_card_type, declared.to_card_type]).toEqual([
      null,
      'task',
    ]);
    const plain = cardEventSchema.parse(event);
    expect([plain.from_card_type, plain.to_card_type]).toEqual([null, null]);
  });
});
