/**
 * How many requests the page is waiting on, counted at the one point every
 * request passes through: the global `fetch`.
 *
 * WHY ONE CHOKE POINT AND NOT THE CALL SITES: the dashboard waits on the
 * server through server actions, `router.refresh()`, navigations and its own
 * client calls, from dozens of places. All of them reach `fetch`, so a single
 * wrapper sees every one and nothing has to be wired per call.
 *
 * A request counts until its response body has been read to the end, not
 * until its headers arrive: a server re-render streams its payload, and the
 * page changes only once that stream ends. The caller still gets the ORIGINAL
 * Response (the App Router reads its `url` and `redirected`); the end is
 * observed on a clone.
 *
 * Not counted: background prefetches, which the App Router marks with the
 * `next-router-prefetch` header. Nobody waits for them, and counting them
 * would light the bar whenever a link scrolls into view. Realtime runs over a
 * WebSocket and never passes through here.
 */

const PREFETCH_HEADER = 'next-router-prefetch';
const INSTALLED: unique symbol = Symbol.for('zero-memory.request-activity');

export type ActivityListener = (pending: number) => void;

export interface RequestActivity {
  /** Requests in flight right now. */
  pending(): number;
  /** Called with the new count on every change; returns the unsubscribe. */
  subscribe(listener: ActivityListener): () => void;
}

/** Whatever owns the `fetch` to wrap: `globalThis` in the browser. */
export interface FetchHost {
  fetch: typeof fetch;
  [INSTALLED]?: RequestActivity;
}

const isPrefetch = (input: RequestInfo | URL, init?: RequestInit): boolean =>
  (input instanceof Request && input.headers.has(PREFETCH_HEADER)) ||
  new Headers(init?.headers).has(PREFETCH_HEADER);

/** Reads `body` to its end; a failed or aborted body ends the wait too. */
const drain = async (body: ReadableStream<Uint8Array>): Promise<void> => {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // The request is over either way.
  } finally {
    reader.releaseLock();
  }
};

/**
 * Wraps `host.fetch` once and returns the shared counter. A second call
 * returns the same counter instead of wrapping the wrapper.
 */
export const installRequestActivity = (
  host: FetchHost = globalThis as unknown as FetchHost
): RequestActivity => {
  const existing = host[INSTALLED];
  if (existing) {
    return existing;
  }

  let pending = 0;
  const listeners = new Set<ActivityListener>();
  const change = (delta: number) => {
    pending += delta;
    for (const listener of listeners) {
      listener(pending);
    }
  };

  const original = host.fetch.bind(host);
  host.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isPrefetch(input, init)) {
      return original(input, init);
    }
    change(1);
    let response: Response;
    try {
      response = await original(input, init);
    } catch (error) {
      change(-1);
      throw error;
    }
    let settled: Promise<void> = Promise.resolve();
    try {
      const copy = response.body ? response.clone().body : null;
      if (copy) {
        settled = drain(copy);
      }
    } catch {
      // A body that cannot be cloned is not worth waiting on.
    }
    void settled.finally(() => change(-1));
    return response;
  }) as typeof fetch;

  const activity: RequestActivity = {
    pending: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  host[INSTALLED] = activity;
  return activity;
};
