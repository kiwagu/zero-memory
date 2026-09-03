import type { SessionReceiptOutput } from '@workspace/contracts';
import { inject } from '@workspace/di';

/**
 * Port: the per-session value counters behind the end-of-session receipt
 * ("captured N / fired M / loops / tokens saved"). A single narrow read over
 * rows that already exist (usage_events + memories) — the receipt is a new
 * consumer of existing metering, never a new metric. Runs as the current
 * user: the adapter's RPC keys every aggregate on the caller.
 */
export interface ISessionReceiptReader {
  /** Counters accumulated since the given window start (session start). */
  read(since: string): Promise<SessionReceiptOutput>;
}

export const SESSION_RECEIPT_READER = Symbol.for(
  'zero-memory:session-receipt-reader'
);

export const injectSessionReceiptReader = () => inject(SESSION_RECEIPT_READER);
