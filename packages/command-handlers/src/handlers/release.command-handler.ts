import {
  cardFailureToErrorCode,
  ReleaseService,
  type CardFailure,
} from '@workspace/board';
import { ReleaseCommand } from '@workspace/commands';
import {
  FailureError,
  failure,
  type ReleaseOutput,
} from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { inject, singleton } from '@workspace/di';
import type { Result } from 'oxide.ts';

/** A field the chosen action cannot do without. */
const missing = (field: string, action: string): never => {
  throw new FailureError(
    failure('validation_failed', `\`${field}\` is required to ${action}.`)
  );
};

const unwrap = <T>(result: Result<T, CardFailure>): T => {
  if (result.isErr()) {
    const cardFailure = result.unwrapErr();
    throw new FailureError(
      failure(cardFailureToErrorCode(cardFailure), cardFailure.message)
    );
  }
  return result.unwrap();
};

@commandHandler(ReleaseCommand)
@singleton()
export class ReleaseCommandHandler implements ICommandHandler<
  ReleaseCommand,
  ReleaseOutput
> {
  constructor(
    @inject(ReleaseService) private readonly service: ReleaseService
  ) {}

  async execute(command: ReleaseCommand): Promise<ReleaseOutput> {
    switch (command.action) {
      case 'settings':
        return { settings: unwrap(await this.service.settings(command.scope)) };
      case 'configure': {
        // release_configure replaces the whole row: every field it is not
        // given falls back to a bare SQL default rather than to what the
        // project already has. So a field the caller omitted here keeps its
        // CURRENT value (read first), and only a field the caller actually
        // passed — including an explicit `null` on version_url — changes.
        const current = unwrap(await this.service.settings(command.scope));
        return {
          settings: unwrap(
            await this.service.configure({
              scope: command.scope,
              versionUrl:
                command.version_url !== undefined
                  ? command.version_url
                  : (current?.version_url ?? null),
              versionField: command.version_field ?? current?.version_field,
              tagTemplate: command.tag_template ?? current?.tag_template,
              tagPattern: command.tag_pattern ?? current?.tag_pattern,
              onRelease: command.on_release ?? current?.on_release,
            })
          ),
        };
      }
      case 'candidates':
        return {
          cards: unwrap(
            await this.service.candidates(
              command.scope,
              command.version ??
                missing('version', 'list the candidates of a release')
            )
          ),
        };
      case 'record': {
        const written = unwrap(
          await this.service.record({
            scope: command.scope,
            version: command.version ?? missing('version', 'record a release'),
            build: command.build ?? null,
            releaseCommit:
              command.release_commit ??
              missing('release_commit', 'record a release'),
            source: command.source ?? missing('source', 'record a release'),
            cardIds: command.card_ids ?? [],
            thread: command.thread,
            agentLabel: command.agent_label,
          })
        );
        return {
          release: written.release,
          // The port answers plain strings (`RecordedRelease.recorded` is
          // `string[]`); the store already validated them as card ids.
          recorded: written.recorded as ReleaseOutput['recorded'],
          moved: written.moved as ReleaseOutput['moved'],
        };
      }
    }
  }
}
