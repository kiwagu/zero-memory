import { newCardId, newMemoryId } from '@workspace/contracts';
import { Ok, type Result } from 'oxide.ts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CardFailure } from './card.errors.js';
import type { CardWrite, ICardRepository } from './card.repository.js';
import { CardService } from './card.service.js';

/**
 * A store that records what reached it. The point of most of these tests is
 * that it records NOTHING: a call the service can refuse on its own must not
 * cost a round trip, and the caller gets a sentence rather than a code.
 */
class RecordingRepository implements ICardRepository {
  calls: string[] = [];

  #ok(): Promise<Result<CardWrite, CardFailure>> {
    return Promise.resolve(
      Ok({
        card: {
          id: newCardId(),
          scope: 'proj.usr_test.board',
          number: 1,
          title: 'Ship it',
          body: '',
          state: 'idea',
          revision: 1,
          origin_loop_id: null,
          created_by: 'usr_0000000000000000.0000000000',
          created_at: '2026-09-20T00:00:00Z',
          updated_at: '2026-09-20T00:00:00Z',
          archived_at: null,
        } as CardWrite['card'],
        changed: true,
        replayed: false,
      })
    );
  }

  create = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('create');
    return this.#ok();
  };
  promoteLoop = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('promoteLoop');
    return this.#ok();
  };
  move = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('move');
    return this.#ok();
  };
  edit = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('edit');
    return this.#ok();
  };
  archive = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('archive');
    return this.#ok();
  };
  attach = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('attach');
    return this.#ok();
  };
  detach = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('detach');
    return this.#ok();
  };
  note = async (): Promise<
    Result<{ eventId: string | null; replayed: boolean }, CardFailure>
  > => {
    this.calls.push('note');
    return Ok({ eventId: 'cev_0000000000000000.0000000000', replayed: false });
  };
  read = async (): Promise<never> => {
    throw new Error('not used');
  };
  list = async (): Promise<never> => {
    throw new Error('not used');
  };
  resolve = async (): Promise<never> => {
    throw new Error('not used');
  };
}

describe('CardService', () => {
  let repository: RecordingRepository;
  let service: CardService;

  beforeEach(() => {
    repository = new RecordingRepository();
    service = new CardService(repository);
  });

  const cardId = newCardId();

  it('refuses a move with no reason before it costs a round trip', async () => {
    const blank = await service.moveCard({
      cardId,
      to: 'active',
      reason: '   ',
    });

    expect(blank.isErr()).toBe(true);
    expect(blank.unwrapErr().message).toMatch(/reason/i);
    expect(repository.calls).toEqual([]);
  });

  it('refuses a state the vocabulary does not have', async () => {
    const result = await service.moveCard({
      cardId,
      to: 'in_review' as never,
      reason: 'because',
    });

    expect(result.isErr()).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  it('passes a real move through', async () => {
    const result = await service.moveCard({
      cardId,
      to: 'active',
      reason: 'picked it up',
    });

    expect(result.isOk()).toBe(true);
    expect(repository.calls).toEqual(['move']);
  });

  it('refuses an empty note and a relation with nothing to answer', async () => {
    expect((await service.noteCard({ cardId, text: '  ' })).isErr()).toBe(true);
    expect(
      (
        await service.noteCard({
          cardId,
          text: 'that is wrong',
          relation: 'disputes',
        })
      ).isErr()
    ).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  it('refuses a card that references itself', async () => {
    const result = await service.attachRef({
      cardId,
      ref: { kind: 'card', id: cardId },
    });

    expect(result.isErr()).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  it('lets a card reference another card and a memory', async () => {
    await service.attachRef({ cardId, ref: { kind: 'card', id: newCardId() } });
    await service.attachRef({
      cardId,
      ref: { kind: 'memory', id: newMemoryId() },
    });

    expect(repository.calls).toEqual(['attach', 'attach']);
  });

  it('refuses an edit that would change nothing', async () => {
    const result = await service.editCard({ cardId });

    expect(result.isErr()).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  it('refuses archiving without a reason', async () => {
    expect((await service.archiveCard({ cardId, reason: '' })).isErr()).toBe(
      true
    );
    expect(repository.calls).toEqual([]);
  });

  it('refuses a card address that is not a positive number', async () => {
    expect((await service.resolveCard('proj.x', 0)).isErr()).toBe(true);
    expect((await service.resolveCard('proj.x', 1.5)).isErr()).toBe(true);
  });
});
