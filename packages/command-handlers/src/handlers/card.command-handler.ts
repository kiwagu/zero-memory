import { CardService, cardFailureToErrorCode } from '@workspace/board';
import { CardCommand } from '@workspace/commands';
import {
  FailureError,
  failure,
  type CardOutput,
  type CardState,
} from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import type { Result } from 'oxide.ts';
import type { CardFailure, CardWrite } from '@workspace/board';

/** A field the chosen action cannot do without. */
const missing = (field: string, action: string): never => {
  throw new FailureError(
    failure(
      'validation_failed',
      `\`${field}\` is required to ${action} a card.`
    )
  );
};

@commandHandler(CardCommand)
@singleton()
export class CardCommandHandler implements ICommandHandler<
  CardCommand,
  CardOutput
> {
  constructor(@inject(CardService) private readonly service: CardService) {}

  async execute(command: CardCommand): Promise<CardOutput> {
    const authorship = {
      thread: command.thread,
      agentLabel: command.agent_label,
      idempotencyKey: command.idempotency_key,
    };

    let result: Result<CardWrite, CardFailure>;
    switch (command.action) {
      case 'create':
        result = await this.service.createCard({
          ...authorship,
          scope: command.scope ?? missing('scope', 'open'),
          title: command.title ?? missing('title', 'open'),
          body: command.body,
          state: command.state,
          branch: command.branch,
          noBranch: command.no_branch,
          links: command.links,
          noLinks: command.no_links,
        });
        break;
      case 'promote_loop':
        result = await this.service.promoteLoop({
          ...authorship,
          loopId: command.loop_id ?? missing('loop_id', 'promote into'),
          title: command.title ?? missing('title', 'promote into'),
          body: command.body,
          state: command.state,
          branch: command.branch,
          noBranch: command.no_branch,
          links: command.links,
          noLinks: command.no_links,
        });
        break;
      case 'edit':
        result = await this.service.editCard({
          ...authorship,
          cardId: command.card_id ?? missing('card_id', 'edit'),
          title: command.title,
          body: command.body,
          expectedRevision: command.expected_revision,
        });
        break;
      case 'move':
        result = await this.service.moveCard({
          ...authorship,
          cardId: command.card_id ?? missing('card_id', 'move'),
          to: (command.to ?? missing('to', 'move')) as CardState,
          reason: command.reason ?? missing('reason', 'move'),
          branch: command.branch,
          noBranch: command.no_branch,
          notLanded: command.not_landed,
          links: command.links,
          noLinks: command.no_links,
        });
        break;
      case 'land':
        result = await this.service.landCard({
          ...authorship,
          cardId: command.card_id ?? missing('card_id', 'land'),
          branch: command.branch ?? missing('branch', 'land'),
          squashSha: command.squash_sha ?? missing('squash_sha', 'land'),
          target: command.target ?? missing('target', 'land'),
          reason: command.reason ?? missing('reason', 'land'),
          to: command.to,
          notLanded: command.not_landed,
        });
        break;
      case 'archive':
        result = await this.service.archiveCard({
          ...authorship,
          cardId: command.card_id ?? missing('card_id', 'archive'),
          reason: command.reason ?? missing('reason', 'archive'),
        });
        break;
      case 'link':
        result = await this.service.linkCard({
          ...authorship,
          cardId: command.card_id ?? missing('card_id', 'link'),
          toCard: command.to_card ?? missing('to_card', 'link'),
          relation: command.relation ?? missing('relation', 'link'),
          reason: command.reason ?? missing('reason', 'link'),
        });
        break;
      case 'unlink':
        result = await this.service.unlinkCard({
          ...authorship,
          cardId: command.card_id ?? missing('card_id', 'unlink'),
          toCard: command.to_card ?? missing('to_card', 'unlink'),
          relation: command.relation ?? missing('relation', 'unlink'),
          reason: command.reason ?? missing('reason', 'unlink'),
        });
        break;
    }

    if (result.isErr()) {
      const cardFailure = result.unwrapErr();
      throw new FailureError(
        failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
      );
    }
    const write = result.unwrap();
    return {
      card: write.card,
      changed: write.changed,
      replayed: write.replayed,
      candidates: write.candidates ?? [],
    };
  }
}
