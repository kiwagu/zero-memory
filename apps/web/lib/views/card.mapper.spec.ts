import type { WebTranslator } from '@workspace/i18n-catalogs/web';
import { describe, expect, it } from 'vitest';

import { cardViewSchema, type CardView } from '../board';
import { cardMentionNumbers, toCardViewData } from './card.mapper';

/** Key-echoing translator: asserts keys, not copy. */
const t: WebTranslator = (key, vars) =>
  vars ? `${key}${JSON.stringify(vars)}` : key;

const BOARD = 'proj.usr_a.relay';
const AT = '2026-09-20T10:00:00Z';

const card = {
  id: 'crd_main',
  scope: BOARD,
  number: 5,
  title: 'Ship the relay',
  body: '',
  state: 'active',
  revision: 1,
  origin_loop_id: null,
  created_by: 'usr_a',
  created_at: AT,
  updated_at: AT,
  archived_at: null,
};

const event = (seq: number, fields: Record<string, unknown>) => ({
  id: `cev_${seq}`,
  seq,
  type: 'noted',
  actor_id: 'usr_a',
  agent_label: null,
  thread: null,
  from_state: null,
  to_state: null,
  reason: null,
  revision: null,
  text: null,
  reply_to: null,
  relation: null,
  ref_kind: null,
  ref_target: null,
  created_at: AT,
  ...fields,
});

const link = (number: number, fields: Record<string, unknown>) => ({
  card_id: `crd_${number}`,
  number,
  title: `Card ${number}`,
  state: 'idea',
  scope: BOARD,
  archived: false,
  relation: 'relates_to',
  reason: `why ${number}`,
  declared: true,
  created_at: AT,
  ...fields,
});

/** What `card_get` answers, through the same schema the loader parses it with. */
const viewOf = (fields: Record<string, unknown> = {}): CardView =>
  cardViewSchema.parse({ card, ...fields });

const detailOf = (
  view: CardView,
  extras: Partial<Parameters<typeof toCardViewData>[1]> = {}
) => toCardViewData(view, { feed: null, mentions: [], ...extras }, t).detail;

describe('toCardViewData', () => {
  it('groups relations by side in reading order, and marks the ones worth a second look', () => {
    const { links } = detailOf(
      viewOf({
        links: [
          link(3, { relation: 'relates_to', declared: false }),
          link(8, { relation: 'blocked_by' }),
          link(9, { relation: 'child_of', archived: true }),
          link(4, { relation: 'relates_to', scope: 'proj.usr_a.other_board' }),
        ],
      })
    );

    const side = (key: string) =>
      links.groups.find((group) => group.key === key)?.items ?? [];
    expect(links.groups.map((group) => group.key)).toEqual([
      'above',
      'below',
      'related',
      'duplicates',
    ]);
    // Above: the parent before what blocks the card, whatever order the store
    // sent them in.
    expect(side('above').map((item) => item.numberLabel)).toEqual([
      'ZM-9',
      'ZM-8',
    ]);
    expect(side('above')[0]).toMatchObject({
      relationLabel: 'board.link.child_of',
      archivedLabel: 'board.archived',
      href: '/board/crd_9',
    });
    expect(side('above')[1]).not.toHaveProperty('archivedLabel');

    const [undeclared, elsewhere] = side('related');
    // A relation carried over from an attachment says nobody typed it.
    expect(undeclared).toMatchObject({
      numberLabel: 'ZM-3',
      undeclaredLabel: 'board.linkUndeclared',
    });
    // A number alone names a card of this board; one on another board says
    // which.
    expect(undeclared).not.toHaveProperty('boardLabel');
    expect(elsewhere).toMatchObject({
      numberLabel: 'ZM-4',
      boardLabel: 'other_board',
    });
    expect(elsewhere).not.toHaveProperty('undeclaredLabel');
  });

  it('names an attached memory by its kind, and keeps a hidden one in place without its content', () => {
    const { refs } = detailOf(
      viewOf({
        refs: [
          {
            kind: 'memory',
            target: 'mem_visible',
            attached_at: AT,
            available: true,
            preview: 'the relay drops frames',
            memory_kind: 'decision',
          },
          {
            kind: 'memory',
            target: 'mem_hidden',
            attached_at: AT,
            available: false,
            preview: null,
          },
        ],
      })
    );

    expect(refs.items).toEqual([
      {
        type: 'kind.decision',
        href: '/memory/mem_visible',
        preview: 'the relay drops frames',
      },
      { type: 'memory' },
    ]);
  });

  it('shows where a branch landed, and only the landings before the latest as earlier', () => {
    const branch = (landings: string[]) => ({
      repo: 'acme/relay',
      branch: 'feature/relay',
      state: 'landed',
      squash_sha: landings.at(-1),
      target: 'main',
      landed_at: AT,
      attached_at: AT,
      landings: landings.map((squash_sha) => ({
        squash_sha,
        target: 'main',
        landed_at: AT,
      })),
    });

    const once = detailOf(viewOf({ branches: [branch(['4f11a55'])] }));
    expect(once.branches.items).toEqual([
      {
        key: 'acme/relay:feature/relay',
        name: 'feature/relay',
        repo: 'acme/relay',
        stateLabel: 'board.branch.landed{"sha":"4f11a55","target":"main"}',
        earlierLabel: null,
        landed: true,
      },
    ]);

    const again = detailOf(
      viewOf({ branches: [branch(['aaaaaaa1111', 'bbbbbbb2222'])] })
    );
    expect(again.branches.items[0]?.stateLabel).toContain('bbbbbbb');
    expect(again.branches.items[0]?.earlierLabel).toBe(
      'board.branch.earlier{"shas":"aaaaaaa"}'
    );
  });

  it('badges the newest release that carried the card, and a blocked card', () => {
    const { badges } = detailOf(
      viewOf({
        releases: [
          {
            version: '1.4.0',
            build: 'abc1234',
            release_commit: '6f33c77',
            released_at: AT,
          },
          {
            version: '1.3.0',
            build: null,
            release_commit: '5e22b66',
            released_at: AT,
          },
        ],
        blocked: true,
      })
    );

    expect(badges[0]).toMatchObject({
      label: 'board.state.active',
      testId: 'card-state',
    });
    expect(badges).toContainEqual({
      label: 'board.releasedIn{"version":"1.4.0"}',
      variant: 'green',
    });
    expect(badges.some((badge) => badge.label.includes('1.3.0'))).toBe(false);
    expect(badges.at(-1)).toEqual({
      label: 'board.blocked',
      variant: 'destructive',
      testId: 'card-blocked',
    });
  });

  it("names what each history entry points at, from this card's side", () => {
    const { history } = detailOf(
      viewOf({
        events: [
          event(1, {
            type: 'linked',
            link_type: 'blocks',
            link_direction: 'in',
            ref_number: 8,
            ref_target: 'crd_8',
          }),
          event(2, {
            type: 'landed',
            ref_target: 'feature/relay',
            target_branch: 'main',
            squash_sha: '4f11a55deadbeef',
          }),
          event(3, {
            type: 'released',
            release_version: '1.4.0',
            release_build: 'abc1234',
          }),
          event(4, { type: 'attached', ref_kind: 'url', ref_target: 'x' }),
        ],
      })
    );

    expect(history.entries.map((entry) => entry.refLabel)).toEqual([
      // Stored as "8 blocks 5", read on card 5: it is blocked by ZM-8.
      'board.link.blocked_by ZM-8',
      'feature/relay → main (4f11a55)',
      'v1.4.0 (build abc1234)',
      'url: x',
    ]);
  });

  it('links the mentioned cards the reader may see, and lists the card feed', () => {
    const view = viewOf({
      card: { ...card, body: 'After ZM-5, ZM-7 and ZM-8.' },
      events: [event(1, { text: 'waits on ZM-9' })],
    });
    // The card's own label is not resolved: it would only open the card again.
    expect(cardMentionNumbers(view)).toEqual([7, 8, 9]);

    const detail = detailOf(view, {
      // ZM-8 is not among them: the reader may not see it, so it stays text.
      mentions: [
        { id: 'crd_seven', number: 7 },
        { id: 'crd_nine', number: 9 },
      ],
      feed: {
        feed: [
          {
            memory_id: 'mem_born',
            kind: 'gotcha',
            preview: 'frames drop under load',
            thread: 'thr_x',
            created_at: AT,
          },
        ],
        has_more: true,
        next_before: null,
      },
    });
    expect(detail.cardLinks).toEqual({
      '7': '/board/crd_seven',
      '9': '/board/crd_nine',
    });
    expect(detail.feed.items).toEqual([
      {
        type: 'kind.gotcha',
        href: '/memory/mem_born',
        preview: 'frames drop under load',
      },
    ]);
    expect(detail.feed.moreLabel).toBe('board.moreFeed');
  });

  it('carries the severity to the header, and names the levels a severity edit moved between', () => {
    const detail = detailOf(
      viewOf({
        card: { ...card, severity: 5 },
        events: [
          event(1, {
            type: 'edited',
            revision: 2,
            from_severity: 3,
            to_severity: 5,
          }),
          event(2, { type: 'edited', revision: 3 }),
        ],
      })
    );

    expect(detail.severity).toEqual({
      level: 5,
      hint: 'board.severity.hint{"level":5,"label":"board.severity.5"}',
    });
    expect(detail.history.entries[0]).toMatchObject({
      typeLabel: 'board.event.edited',
      transitionLabel:
        'board.severity.change{"from":"board.severity.3","to":"board.severity.5"}',
    });
    expect(detail.history.entries[1]?.transitionLabel).toBeUndefined();
  });
});
