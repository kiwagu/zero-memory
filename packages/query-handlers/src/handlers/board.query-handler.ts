import { CardService, cardFailureToErrorCode } from '@workspace/board';
import {
  FailureError,
  boardOutputSchema,
  failure,
  type BoardOutput,
} from '@workspace/contracts';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import { BoardQuery } from '@workspace/queries';

const required = (field: string, action: string): never => {
  throw new FailureError(
    failure('validation_failed', `\`${field}\` is required to ${action}.`)
  );
};

@queryHandler(BoardQuery)
@singleton()
export class BoardQueryHandler implements IQueryHandler<
  BoardQuery,
  BoardOutput
> {
  constructor(@inject(CardService) private readonly service: CardService) {}

  async execute(query: BoardQuery): Promise<BoardOutput> {
    switch (query.action ?? 'list') {
      case 'get': {
        const read = await this.service.readCard({
          cardId: query.card_id ?? required('card_id', 'read a card'),
          afterSeq: query.after_seq,
          limit: query.limit,
          feedBefore: query.feed_before,
        });
        if (read.isErr()) {
          const cardFailure = read.unwrapErr();
          throw new FailureError(
            failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
          );
        }
        const view = read.unwrap();
        return boardOutputSchema.parse({
          card: view.card,
          refs: view.refs,
          branches: view.branches,
          releases: view.releases,
          events: view.events,
          has_more: view.has_more,
          next_after_seq: view.next_after_seq,
          feed: view.feed,
          feed_has_more: view.feed_has_more,
          feed_next_before: view.feed_next_before,
          links: view.links,
          blocked: view.blocked,
          links_assessed: view.links_assessed,
        });
      }
      case 'resolve': {
        const resolved = await this.service.resolveCard(
          query.scope ?? required('scope', 'resolve a number'),
          query.number ?? required('number', 'resolve a number')
        );
        if (resolved.isErr()) {
          const cardFailure = resolved.unwrapErr();
          throw new FailureError(
            failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
          );
        }
        return boardOutputSchema.parse({ card: resolved.unwrap() });
      }
      default: {
        const listed = await this.service.listBoard({
          scope: query.scope,
          state: query.state,
          query: query.query,
          includeArchived: query.include_archived,
          limit: query.limit,
          relatedTo: query.related_to,
          relation: query.relation_filter,
        });
        if (listed.isErr()) {
          const cardFailure = listed.unwrapErr();
          throw new FailureError(
            failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
          );
        }
        const board = listed.unwrap();
        return boardOutputSchema.parse({
          cards: board.cards,
          totals: board.totals,
        });
      }
    }
  }
}
