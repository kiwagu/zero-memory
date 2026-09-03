import { nanoid } from 'nanoid';

export type CommandProps<T> = Omit<
  T,
  'commandId' | 'correlationId' | 'causationId'
> &
  Partial<Command>;

/**
 * Base command: carries ids for auditing and correlation/causation chains.
 */
export abstract class Command {
  /** Unique id of this command instance. */
  public readonly commandId: string;

  /** Correlates commands across services, logs, and follow-up events. */
  public readonly correlationId: string;

  /** Id of the message that caused this command, when reconstructing order. */
  public readonly causationId?: string;

  constructor(props: CommandProps<unknown>) {
    this.commandId = props.commandId ?? nanoid();
    this.correlationId = props.correlationId ?? nanoid();
    this.causationId = props.causationId;
  }
}
