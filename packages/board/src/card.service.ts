import {
  cardBodySchema,
  cardBranchSchema,
  cardNoteTextSchema,
  cardReasonSchema,
  cardStateSchema,
  cardTitleSchema,
  gitBranchNameSchema,
  gitCommitShaSchema,
  type Card,
  type CardBranch,
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
  LandCardParams,
  ListBoardParams,
  MoveCardParams,
  NoteCardParams,
  PromoteLoopParams,
  ReadCardParams,
} from './card.repository.js';

const invalid = (message: string): CardFailure =>
  toCardFailure('invalid', message);

/**
 * What can be refused about the branch rule without reading the card: a
 * branch together with a no-code declaration, a blank declaration, or a
 * branch offered to work that is not entering active. Whether the card
 * already holds an open branch is the store's call, under the card's lock.
 */
const branchDeclarationFailure = (
  entering: boolean,
  params: { branch?: CardBranch; noBranch?: string; notLanded?: string }
): CardFailure | null => {
  if (params.branch && params.noBranch !== undefined) {
    return invalid('Pass `branch` or `no_branch`, not both.');
  }
  if (params.noBranch !== undefined && params.noBranch.trim() === '') {
    return invalid('`no_branch` must say why the work has no code.');
  }
  if (params.notLanded !== undefined && params.notLanded.trim() === '') {
    return invalid('`not_landed` must say why the open branch has not landed.');
  }
  if (!entering && (params.branch || params.noBranch !== undefined)) {
    return invalid('`branch` and `no_branch` apply to work entering active.');
  }
  return null;
};

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
    const rule = branchDeclarationFailure(
      (params.state ?? 'idea') === 'active',
      params
    );
    if (rule) {
      return Err(rule);
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
    const rule = branchDeclarationFailure(
      (params.state ?? 'active') === 'active',
      params
    );
    if (rule) {
      return Err(rule);
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
    const rule = branchDeclarationFailure(state.data === 'active', params);
    if (rule) {
      return Err(rule);
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

  async landCard(
    params: LandCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const branch = cardBranchSchema.safeParse(params.branch);
    if (!branch.success) {
      return Err(invalid('A landing names its branch: {repo, name}.'));
    }
    const sha = gitCommitShaSchema.safeParse(params.squashSha);
    if (!sha.success) {
      return Err(
        invalid('`squash_sha` is the landed commit: 7 to 64 hex characters.')
      );
    }
    const target = gitBranchNameSchema.safeParse(params.target);
    if (!target.success) {
      return Err(invalid('`target` is the branch it landed on, e.g. main.'));
    }
    const reason = cardReasonSchema.safeParse(params.reason);
    if (!reason.success) {
      return Err(
        invalid(
          'A landing must carry a reason: what the gate proved and what the ' +
            'card waits for.'
        )
      );
    }
    if (
      params.to !== undefined &&
      !cardStateSchema.safeParse(params.to).success
    ) {
      return Err(
        invalid(
          `Unknown state: expected one of ${cardStateSchema.options.join(', ')}.`
        )
      );
    }
    const rule = branchDeclarationFailure(false, {
      notLanded: params.notLanded,
    });
    if (rule) {
      return Err(rule);
    }
    return this.repository.land({
      ...params,
      branch: branch.data,
      squashSha: sha.data,
      target: target.data,
      reason: reason.data,
    });
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
      return Err(invalid('A card address is a positive number, like ZM-42.'));
    }
    return this.repository.resolve(scope, number);
  }
}
