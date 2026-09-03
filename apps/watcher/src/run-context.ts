import { AsyncLocalStorage } from 'node:async_hooks';

import { newRequestId } from '@workspace/contracts';

/**
 * Per-scan correlation id for the watcher. Each scan pass generates its own
 * run id so the log lines it emits (reads, chunk flushes, warnings) can be
 * grouped back to one pass. The watcher is a standalone client daemon, so it
 * keeps its own tiny store rather than pulling in the server's DI-bound
 * execution context; the shared `req_` id shape is reused for consistency.
 */
const runStore = new AsyncLocalStorage<{ runId: string }>();

/** Run `fn` inside a fresh run context and return its result. */
export const runWithRunId = <T>(fn: () => T): T =>
  runStore.run({ runId: newRequestId() }, fn);

/** The current run id, or undefined outside a run context. */
export const getRunId = (): string | undefined => runStore.getStore()?.runId;
