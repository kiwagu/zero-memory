import {
  entityIdSchemas,
  newCardId,
  newMemoryId,
  type CardRef,
} from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { Card } from './card.do.js';

const SCOPE = 'proj.usr_test.board';

const makeCard = (title = 'Ship the board'): Card => {
  const created = Card.create({ scope: SCOPE, number: 42, title });
  if (created.isErr()) {
    throw new Error(created.unwrapErr());
  }
  const card = created.unwrap();
  card.clearEvents();
  return card;
};

const memoryRef = (): CardRef => ({ kind: 'memory', id: newMemoryId() });

describe('Card.create', () => {
  it('starts as an idea at revision 1 and raises one created event', () => {
    const card = Card.create({
      scope: SCOPE,
      number: 1,
      title: 'Ship the board',
    }).unwrap();

    expect(card.state).toBe('idea');
    expect(card.revision).toBe(1);
    expect(card.originLoopId).toBeNull();
    expect(card.events).toEqual([
      { type: 'created', toState: 'idea', originLoopId: null },
    ]);
  });

  it('carries the loop it was promoted from', () => {
    const loop = newMemoryId();
    const card = Card.create({
      scope: SCOPE,
      number: 2,
      title: 'Promoted work',
      originLoopId: loop,
    }).unwrap();

    expect(card.originLoopId).toBe(loop);
    expect(card.events[0]).toMatchObject({ originLoopId: loop });
  });

  it('refuses a blank title and a non-positive number', () => {
    expect(Card.create({ scope: SCOPE, number: 1, title: '   ' }).isErr()).toBe(
      true
    );
    expect(
      Card.create({ scope: SCOPE, number: 0, title: 'Fine' }).isErr()
    ).toBe(true);
  });
});

describe('Card.moveTo', () => {
  it('refuses a move with no reason', () => {
    const card = makeCard();

    expect(card.moveTo('active', '').isErr()).toBe(true);
    expect(card.moveTo('active', '   ').isErr()).toBe(true);
    expect(card.state).toBe('idea');
    expect(card.events).toHaveLength(0);
  });

  it('records where the card came from, where it went and why', () => {
    const card = makeCard();

    expect(card.moveTo('active', 'picked it up for the S0 slice').isOk()).toBe(
      true
    );

    expect(card.state).toBe('active');
    expect(card.events).toEqual([
      {
        type: 'moved',
        fromState: 'idea',
        toState: 'active',
        reason: 'picked it up for the S0 slice',
      },
    ]);
  });

  it('refuses a move to the state the card is already in', () => {
    const card = makeCard();
    card.moveTo('active', 'started').unwrap();

    expect(card.moveTo('active', 'started again').isErr()).toBe(true);
  });

  it('lets any state follow any other, so finished work reopens', () => {
    const card = makeCard();
    card.moveTo('done', 'shipped').unwrap();

    expect(card.moveTo('active', 'a defect turned up in review').isOk()).toBe(
      true
    );
    expect(card.state).toBe('active');
  });

  it('refuses an unknown state', () => {
    const card = makeCard();

    expect(card.moveTo('in_review', 'because').isErr()).toBe(true);
  });
});

describe('Card.edit', () => {
  it('writes no event and no revision when nothing changes', () => {
    const card = makeCard('Ship the board');

    const result = card.edit({ title: 'Ship the board' }).unwrap();

    expect(result.changed).toBe(false);
    expect(card.revision).toBe(1);
    expect(card.events).toHaveLength(0);
  });

  it('bumps the revision once per real change', () => {
    const card = makeCard();

    expect(card.edit({ body: 'Goal, boundaries, acceptance.' }).isOk()).toBe(
      true
    );

    expect(card.revision).toBe(2);
    expect(card.events).toEqual([{ type: 'edited', revision: 2 }]);
  });

  it('refuses an edit that expects an older revision', () => {
    const card = makeCard();
    card.edit({ body: 'first' }).unwrap();

    const stale = card.edit({ body: 'second', expectedRevision: 1 });

    expect(stale.isErr()).toBe(true);
    expect(card.body).toBe('first');
  });

  it('accepts an edit that expects the current revision', () => {
    const card = makeCard();

    expect(card.edit({ body: 'first', expectedRevision: 1 }).isOk()).toBe(true);
  });
});

describe('Card.archive', () => {
  it('needs a reason and then freezes the card', () => {
    const card = makeCard();

    expect(card.archive('  ').isErr()).toBe(true);
    expect(card.archive('superseded by the umbrella card').isOk()).toBe(true);
    expect(card.isArchived).toBe(true);

    expect(card.moveTo('active', 'changed my mind').isErr()).toBe(true);
    expect(card.edit({ title: 'New title' }).isErr()).toBe(true);
    expect(card.attach(memoryRef()).isErr()).toBe(true);
    expect(card.note({ text: 'one more thought' }).isErr()).toBe(true);
    expect(card.archive('again').isErr()).toBe(true);
  });
});

describe('Card.attach and Card.detach', () => {
  it('keeps one attachment when the same target arrives twice', () => {
    const card = makeCard();
    const ref = memoryRef();

    expect(card.attach(ref).unwrap().changed).toBe(true);
    expect(card.attach({ ...ref }).unwrap().changed).toBe(false);

    expect(card.refs).toHaveLength(1);
    expect(card.events).toHaveLength(1);
  });

  it('accepts every reference kind the vocabulary allows', () => {
    const card = makeCard();
    const refs: CardRef[] = [
      memoryRef(),
      { kind: 'entity', id: entityIdSchemas.entity.create() },
      { kind: 'thread', id: entityIdSchemas.session_thread.create() },
      { kind: 'card', id: newCardId() },
      { kind: 'url', url: 'https://example.invalid/run/1' },
    ];

    for (const ref of refs) {
      expect(card.attach(ref).isOk()).toBe(true);
    }

    expect(card.refs).toHaveLength(refs.length);
  });

  it('refuses to reference itself', () => {
    const card = makeCard();

    expect(card.attach({ kind: 'card', id: card.id }).isErr()).toBe(true);
  });

  it('detaches what is attached and refuses what is not', () => {
    const card = makeCard();
    const ref = memoryRef();
    card.attach(ref).unwrap();
    card.clearEvents();

    expect(card.detach(ref).isOk()).toBe(true);
    expect(card.refs).toHaveLength(0);
    expect(card.events).toEqual([{ type: 'detached', ref }]);

    expect(card.detach(ref).isErr()).toBe(true);
  });
});

describe('Card.note', () => {
  it('refuses an empty note', () => {
    const card = makeCard();

    expect(card.note({ text: '   ' }).isErr()).toBe(true);
  });

  it('refuses a relation with nothing to relate to', () => {
    const card = makeCard();

    expect(
      card.note({ text: 'that is wrong', relation: 'disputes' }).isErr()
    ).toBe(true);
  });

  it('never moves the card, whatever the note claims', () => {
    const card = makeCard();

    expect(card.note({ text: 'I finished this work.' }).isOk()).toBe(true);

    expect(card.state).toBe('idea');
    expect(card.events).toEqual([
      {
        type: 'noted',
        text: 'I finished this work.',
        replyTo: null,
        relation: null,
      },
    ]);
  });
});
