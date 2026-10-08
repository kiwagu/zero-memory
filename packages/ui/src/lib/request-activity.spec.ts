import { describe, expect, it, vi } from 'vitest';

import { installRequestActivity, type FetchHost } from './request-activity.js';

/** A response whose body ends only when the test closes it. */
const streamedResponse = () => {
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first chunk'));
      close = () => controller.close();
    },
  });
  return { response: new Response(body), close };
};

/** A fetch whose answer the test releases by hand. */
const deferredFetch = () => {
  const waiting: Array<(response: Response) => void> = [];
  const impl = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        waiting.push(resolve);
      })
  );
  return {
    impl,
    answer: (response: () => Response) => {
      for (const resolve of waiting.splice(0)) {
        resolve(response());
      }
    },
  };
};

const hostWith = (
  impl: (...args: never[]) => Promise<Response>
): FetchHost => ({
  fetch: impl as unknown as typeof fetch,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('installRequestActivity', () => {
  it('counts a request until its body has been read to the end, and hands back the response itself', async () => {
    const { response, close } = streamedResponse();
    const host = hostWith(async () => response);
    const activity = installRequestActivity(host);
    const seen: number[] = [];
    activity.subscribe((pending) => seen.push(pending));

    const got = await host.fetch('/memories');
    // The App Router reads `url` and `redirected` off the very object.
    expect(got).toBe(response);
    await settle();
    // The headers are in, but a streamed re-render is not over yet.
    expect(activity.pending()).toBe(1);

    close();
    await settle();
    expect(activity.pending()).toBe(0);
    expect(seen).toEqual([1, 0]);
  });

  it('does not count a background prefetch, by header or by request', async () => {
    const { impl, answer } = deferredFetch();
    const host = hostWith(impl);
    const activity = installRequestActivity(host);

    const byInit = host.fetch('/board', {
      headers: { 'Next-Router-Prefetch': '1' },
    });
    const byRequest = host.fetch(
      new Request('http://localhost/rules', {
        headers: { 'next-router-prefetch': '1' },
      })
    );
    // Both are in flight, and neither is something the person waits for.
    expect(impl).toHaveBeenCalledTimes(2);
    expect(activity.pending()).toBe(0);

    answer(() => new Response('ok'));
    await Promise.all([byInit, byRequest]);
  });

  it('passes headers given as a one-shot iterable on unread', async () => {
    const sent: RequestInit[] = [];
    const host = hostWith(async (_input: unknown, init?: RequestInit) => {
      sent.push(init ?? {});
      return new Response('ok');
    });
    installRequestActivity(host);
    function* headers(): Generator<[string, string]> {
      yield ['x-probe', '1'];
    }
    const iterable = headers();

    await host.fetch('/memories', {
      headers: iterable as unknown as HeadersInit,
    });
    // The request still carries every header the caller gave it.
    expect([...(sent[0]!.headers as Iterable<[string, string]>)]).toEqual([
      ['x-probe', '1'],
    ]);
  });

  it('ends the count when the request fails', async () => {
    const host = hostWith(async () => {
      throw new TypeError('network down');
    });
    const activity = installRequestActivity(host);

    await expect(host.fetch('/settings')).rejects.toThrow('network down');
    expect(activity.pending()).toBe(0);
  });

  it('ends the count at once for a response without a body', async () => {
    const host = hostWith(async () => new Response(null, { status: 204 }));
    const activity = installRequestActivity(host);

    await host.fetch('/healthz');
    await settle();
    expect(activity.pending()).toBe(0);
  });

  it('wraps fetch only once, however often it is installed', () => {
    const host = hostWith(async () => new Response('ok'));
    const first = installRequestActivity(host);
    const wrapped = host.fetch;

    expect(installRequestActivity(host)).toBe(first);
    expect(host.fetch).toBe(wrapped);
  });
});
