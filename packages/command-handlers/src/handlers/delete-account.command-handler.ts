import { HardDeleteAccountCommand } from '@workspace/commands';
import type { DeleteAccountOutput } from '@workspace/contracts';
import { commandHandler, type ICommandHandler } from '@workspace/cqrs';
import { singleton } from '@workspace/di';
import { injectAccountEraser, type IAccountEraser } from '@workspace/memory';

@commandHandler(HardDeleteAccountCommand)
@singleton()
export class HardDeleteAccountCommandHandler implements ICommandHandler<
  HardDeleteAccountCommand,
  DeleteAccountOutput
> {
  // No domain logic: the value of the command wrapper is the audited erasure.
  // The eraser resolves the subject from the caller's context, so the empty
  // command cannot carry a foreign target.
  constructor(
    @injectAccountEraser()
    private readonly eraser: IAccountEraser
  ) {}

  async execute(
    _command: HardDeleteAccountCommand
  ): Promise<DeleteAccountOutput> {
    return this.eraser.eraseCurrentAccount();
  }
}
