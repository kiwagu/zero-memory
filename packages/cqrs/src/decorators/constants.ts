export const COMMAND_METADATA = Symbol.for('zero-memory:command');
export const COMMAND_HANDLER_METADATA = Symbol.for(
  'zero-memory:command-handler'
);

export const QUERY_METADATA = Symbol.for('zero-memory:query');
export const QUERY_HANDLER_METADATA = Symbol.for('zero-memory:query-handler');

export const EVENT_METADATA = Symbol.for('zero-memory:event');
export const EVENT_HANDLER_METADATA = Symbol.for('zero-memory:event-handler');

export interface HandlerTargetMetadata {
  id: string;
}
