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
  land = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('land');
    return this.#ok();
  };
  link = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('link');
    return this.#ok();
  };
  unlink = async (): Promise<Result<CardWrite, CardFailure>> => {
    this.calls.push('unlink');
    return this.#ok();
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

  const branch = { repo: 'kiwagu/zero-memory', name: 'feature/x' };

  it('refuses a branch and a no-code declaration together', async () => {
    const result = await service.moveCard({
      cardId,
      to: 'active',
      reason: 'start',
      branch,
      noBranch: 'research',
    });
    expect(result.unwrapErr().message).toMatch(/not both/u);
    expect(repository.calls).toEqual([]);
  });

  it('refuses a blank declaration', async () => {
    expect(
      (
        await service.moveCard({
          cardId,
          to: 'active',
          reason: 'start',
          noBranch: '  ',
        })
      ).isErr()
    ).toBe(true);
    expect(
      (
        await service.moveCard({
          cardId,
          to: 'waiting',
          reason: 'hold',
          notLanded: '',
        })
      ).isErr()
    ).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  it('refuses a branch on a move that is not into active', async () => {
    const result = await service.moveCard({
      cardId,
      to: 'waiting',
      reason: 'hold',
      branch,
    });
    expect(result.unwrapErr().message).toMatch(/entering active/u);
    expect(repository.calls).toEqual([]);
  });

  it('refuses a branch on a card opened outside active', async () => {
    const result = await service.createCard({
      scope: 'proj.x',
      title: 'Idea',
      branch,
    });
    expect(result.isErr()).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  it('leaves the open-branch question to the store', async () => {
    // Whether the card already holds an open branch is known only under its
    // lock.
    await service.moveCard({ cardId, to: 'active', reason: 'resume' });
    expect(repository.calls).toEqual(['move']);
  });

  it('refuses a landing without its commit, target or reason before a round trip', async () => {
    for (const bad of [
      { squashSha: 'nope', target: 'main', reason: 'ok' },
      { squashSha: 'abcdef1', target: 'has space', reason: 'ok' },
      { squashSha: 'abcdef1', target: 'main', reason: '  ' },
    ]) {
      expect((await service.landCard({ cardId, branch, ...bad })).isErr()).toBe(
        true
      );
    }
    expect(repository.calls).toEqual([]);
  });

  it('passes a landing through with a normalized sha', async () => {
    const result = await service.landCard({
      cardId,
      branch,
      squashSha: 'ABCDEF1',
      target: 'main',
      reason: 'gate green',
    });
    expect(result.isOk()).toBe(true);
    expect(repository.calls).toEqual(['land']);
  });

  it('refuses relations and a no-relations statement together', async () => {
    const result = await service.createCard({
      scope: 'proj.usr_test.board',
      title: 'Ship it',
      links: [{ card: 'ZM-2', relation: 'depends_on', reason: 'needs it' }],
      noLinks: 'standalone',
    });
    expect(result.unwrapErr().message).toMatch(/not both/u);
    expect(repository.calls).toEqual([]);
  });

  it('refuses a blank no-relations statement', async () => {
    const result = await service.promoteLoop({
      loopId: newMemoryId(),
      title: 'Ship it',
      noBranch: 'research',
      noLinks: '   ',
    });
    expect(result.unwrapErr().code).toBe('invalid');
    expect(repository.calls).toEqual([]);
  });

  it('refuses a relations statement on a move that is not into active', async () => {
    const result = await service.moveCard({
      cardId,
      to: 'waiting',
      reason: 'paused',
      noLinks: 'standalone',
    });
    expect(result.unwrapErr().message).toMatch(/entering active/u);
    expect(repository.calls).toEqual([]);
  });

  it('leaves a missing statement to the store, which knows the candidates', async () => {
    await service.createCard({
      scope: 'proj.usr_test.board',
      title: 'Ship it',
    });
    expect(repository.calls).toEqual(['create']);
  });

  it('refuses a link with an unknown relation, no other card or no reason', async () => {
    for (const params of [
      { toCard: 'ZM-2', relation: 'causes', reason: 'why' },
      { toCard: ' ', relation: 'blocks', reason: 'why' },
      { toCard: 'ZM-2', relation: 'blocks', reason: '  ' },
    ]) {
      const result = await service.linkCard({ cardId, ...params } as never);
      expect(result.unwrapErr().code).toBe('invalid');
    }
    expect(
      (
        await service.unlinkCard({
          cardId,
          toCard: 'ZM-2',
          relation: 'blocks',
          reason: '',
        })
      ).unwrapErr().code
    ).toBe('invalid');
    expect(repository.calls).toEqual([]);
  });

  it('passes a link and an unlink through', async () => {
    await service.linkCard({
      cardId,
      toCard: 'ZM-2',
      relation: 'blocked_by',
      reason: 'needs the keys',
    });
    await service.unlinkCard({
      cardId,
      toCard: 'ZM-2',
      relation: 'blocked_by',
      reason: 'keys rotated',
    });
    expect(repository.calls).toEqual(['link', 'unlink']);
  });

  it('refuses a card address that is not a positive number', async () => {
    expect((await service.resolveCard('proj.x', 0)).isErr()).toBe(true);
    expect((await service.resolveCard('proj.x', 1.5)).isErr()).toBe(true);
  });
});
