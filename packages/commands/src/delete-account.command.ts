import { Command, type CommandProps } from '@workspace/domain';

/**
 * Erase the caller's own account and everything it owns. Carries no payload —
 * the subject is the authenticated caller, resolved server-side from the
 * request context, never passed in — so the command can only ever erase the
 * caller themselves. Modeled as a command so the audited command bus records
 * the erasure in `audit_log`.
 */
export class HardDeleteAccountCommand extends Command {
  constructor(props: CommandProps<unknown> = {}) {
    super(props);
  }
}
