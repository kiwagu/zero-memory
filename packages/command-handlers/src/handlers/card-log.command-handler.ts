import {
  CardService,
  cardFailureToErrorCode,
  parseCardRef,
} from '@workspace/board';
import { CardLogCommand } from '@workspace/commands';
import {
  FailureError,
  failure,
  type CardLogOutput,
  type CardRef,
} from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';

const invalid = (message: string): FailureError =>
  new FailureError(failure('validation_failed', message));

/**
 * Rebuild the typed reference from the two flat fields the tool takes.
 *
 * The tool surface is flat because an MCP input schema is one object, but the
 * vocabulary stays closed: a kind the union does not know never reaches the
 * store.
 */
const refFrom = (kind?: string, target?: string): CardRef => {
  if (!kind || !target) {
    throw invalid('`ref_kind` and `ref_target` are both required to attach.');
  }
  const parsed = parseCardRef(
    kind === 'url' ? { kind, url: target } : { kind, id: target }
  );
  if (parsed.isErr()) {
    throw invalid(parsed.unwrapErr());
  }
  return parsed.unwrap();
};

@commandHandler(CardLogCommand)
@singleton()
export class CardLogCommandHandler implements ICommandHandler<
  CardLogCommand,
  CardLogOutput
> {
  constructor(@inject(CardService) private readonly service: CardService) {}

  async execute(command: CardLogCommand): Promise<CardLogOutput> {
    const authorship = {
      thread: command.thread,
      agentLabel: command.agent_label,
      idempotencyKey: command.idempotency_key,
    };

    if (command.action === 'note') {
      if (!command.text) {
        throw invalid('`text` is required to add a note.');
      }
      const noted = await this.service.noteCard({
        ...authorship,
        cardId: command.card_id,
        text: command.text,
        replyTo: command.reply_to,
        relation: command.relation,
      });
      if (noted.isErr()) {
        const cardFailure = noted.unwrapErr();
        throw new FailureError(
          failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
        );
      }
      const written = noted.unwrap();
      return {
        event_id: written.eventId,
        changed: !written.replayed,
        replayed: written.replayed,
      };
    }

    const ref = refFrom(command.ref_kind, command.ref_target);
    const params = { ...authorship, cardId: command.card_id, ref };
    const result =
      command.action === 'attach'
        ? await this.service.attachRef(params)
        : await this.service.detachRef(params);
    if (result.isErr()) {
      const cardFailure = result.unwrapErr();
      throw new FailureError(
        failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
      );
    }
    const write = result.unwrap();
    return {
      event_id: null,
      changed: write.changed,
      replayed: write.replayed,
    };
  }
}
