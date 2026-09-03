import type { UsageEvent } from './usage-event.js';

/**
 * Port: append one usage event. Implementations resolve the actor (`usr_`) and
 * request id from the ambient execution context and write through a privileged
 * client, because public.usage_events is deny-all to end users.
 *
 * `record` MAY reject (a write can fail); callers MUST NOT await it in a
 * critical path. Use {@link recordUsage} for the fire-and-forget contract.
 */
export interface IUsageRecorder {
  record(event: UsageEvent): Promise<void>;
}
