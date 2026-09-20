import {
  cardBodySchema,
  cardNoteTextSchema,
  cardReasonSchema,
  cardStateSchema,
  cardTitleSchema,
  type Card,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { Err, type Result } from 'oxide.ts';

import { toCardFailure, type CardFailure } from './card.errors.js';
import {
  injectCardRepository,
  type ICardRepository,
} from './card.repository.provider.js';
import type {
  ArchiveCardParams,
  AttachRefParams,
  BoardView,
  CardReadView,
  CardWrite,
  CreateCardParams,
  EditCardParams,
  ListBoardParams,
  MoveCardParams,
  NoteCardParams,
  PromoteLoopParams,
  ReadCardParams,
} from './card.repository.js';

const invalid = (message: string): CardFailure =>
  toCardFailure('invalid', message);

/**
 * The board's application service.
 *
 * It answers what can be answered WITHOUT the card — a blank reason, an empty
 * note, a relation with nothing to relate to — so a hopeless call never costs
 * a round trip and the caller gets a sentence it can act on. Everything that
 * depends on the card's current state (archived, already in that state, a
 * stale revision) is decided by the store under the card's row lock, because
 * only there is the answer still true by the time it is acted on.
 */
@singleton()
export class CardService {
  constructor(
    @injectCardRepository()
    private readonly repository: ICardRepository
  ) {}

  async createCard(
    params: CreateCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const title = cardTitleSchema.safeParse(params.title);
    if (!title.success) {
      return Err(invalid('A card needs a title.'));
    }
    const body = cardBodySchema.safeParse(params.body ?? '');
    if (!body.success) {
      return Err(invalid('The card body is longer than the limit.'));
    }
    return this.repository.create({
      ...params,
      title: title.data,
      body: body.data,
    });
  }

  async promoteLoop(
    params: PromoteLoopParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const title = cardTitleSchema.safeParse(params.title);
    if (!title.success) {
      return Err(invalid('A card needs a title.'));
    }
    return this.repository.promoteLoop({ ...params, title: title.data });
  }

  async moveCard(
    params: MoveCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const state = cardStateSchema.safeParse(params.to);
    if (!state.success) {
      return Err(
        invalid(
          `Unknown state: expected one of ${cardStateSchema.options.join(', ')}.`
        )
      );
    }
    const reason = cardReasonSchema.safeParse(params.reason);
    if (!reason.success) {
      return Err(
        invalid('A move must carry a reason saying why the state changed.')
      );
    }
    return this.repository.move({
      ...params,
      to: state.data,
      reason: reason.data,
    });
  }

  async editCard(
    params: EditCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    if (params.title === undefined && params.body === undefined) {
      return Err(invalid('An edit must change the title or the body.'));
    }
    if (params.title !== undefined) {
      const title = cardTitleSchema.safeParse(params.title);
      if (!title.success) {
        return Err(invalid('A card title must not be empty.'));
      }
    }
    if (params.body !== undefined) {
      const body = cardBodySchema.safeParse(params.body);
      if (!body.success) {
        return Err(invalid('The card body is longer than the limit.'));
      }
    }
    return this.repository.edit(params);
  }

  async archiveCard(
    params: ArchiveCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const reason = cardReasonSchema.safeParse(params.reason);
    if (!reason.success) {
      return Err(invalid('Archiving must carry a reason.'));
    }
    return this.repository.archive({ ...params, reason: reason.data });
  }

  async attachRef(
    params: AttachRefParams
  ): Promise<Result<CardWrite, CardFailure>> {
    if (params.ref.kind === 'card' && params.ref.id === params.cardId) {
      return Err(invalid('A card cannot reference itself.'));
    }
    return this.repository.attach(params);
  }

  async detachRef(
    params: AttachRefParams
  ): Promise<Result<CardWrite, CardFailure>> {
    return this.repository.detach(params);
  }

  async noteCard(
    params: NoteCardParams
  ): Promise<
    Result<{ eventId: string | null; replayed: boolean }, CardFailure>
  > {
    const text = cardNoteTextSchema.safeParse(params.text);
    if (!text.success) {
      return Err(invalid('A note must not be empty.'));
    }
    if (params.relation && !params.replyTo) {
      return Err(
        invalid(
          `A "${params.relation}" relation needs the note it answers: pass reply_to.`
        )
      );
    }
    return this.repository.note({ ...params, text: text.data });
  }

  async readCard(
    params: ReadCardParams
  ): Promise<Result<CardReadView, CardFailure>> {
    return this.repository.read(params);
  }

  async listBoard(
    params: ListBoardParams
  ): Promise<Result<BoardView, CardFailure>> {
    return this.repository.list(params);
  }

  async resolveCard(
    scope: string,
    number: number
  ): Promise<Result<Card, CardFailure>> {
    if (!Number.isInteger(number) || number < 1) {
      return Err(invalid('A card address is a positive number, like #42.'));
    }
    return this.repository.resolve(scope, number);
  }
}
