import { getRequestId, runWithContext } from '@workspace/context';
import { newRequestId } from '@workspace/contracts';
import { createLogger, setLogContextResolver } from '@workspace/logger';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRequestId } from './observability.js';

describe('resolveRequestId', () => {
  it('honors a valid client-supplied req_ id', () => {
    const incoming = newRequestId();
    expect(resolveRequestId(incoming)).toBe(incoming);
  });

  it('mints a fresh req_ id for a missing or malformed header', () => {
    expect(resolveRequestId(null).startsWith('req_')).toBe(true);
    expect(resolveRequestId('garbage').startsWith('req_')).toBe(true);
    // A well-formed id under a different prefix is not a request id.
    expect(resolveRequestId('mem_0000000000000000.0000000000')).not.toBe(
      'mem_0000000000000000.0000000000'
    );
  });
});

describe('logger correlation via the execution context', () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => setLogContextResolver(undefined));

  it('stamps deep child-logger lines with the ambient requestId', () => {
    setLogContextResolver(() => {
      const requestId = getRequestId();
      return requestId ? { requestId } : undefined;
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const requestId = newRequestId();
    runWithContext({ requestId }, () => {
      // A logger created deep in the call tree (e.g. persistence) still emits
      // the request's correlation id, without threading it through signatures.
      createLogger('persistence').child({ op: 'search' }).info('deep log');
    });

    expect(logged).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(logged.mock.calls[0]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(entry.requestId).toBe(requestId);
    expect(entry.op).toBe('search');
    expect(entry.name).toBe('persistence');
  });
});
