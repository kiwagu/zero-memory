import { getRequestId, runWithContext } from '@workspace/context';
import { newRequestId, toolErrorSchema } from '@workspace/contracts';
import {
  createLogger,
  setLogContextResolver,
  type Logger,
} from '@workspace/logger';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRequestId, withRequestObservability } from './observability.js';

const quietLogger = (): Logger => {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
};

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

describe('withRequestObservability', () => {
  it('runs the handler under the request id and echoes it on the response', async () => {
    const incoming = newRequestId();
    let seenByHandler: string | undefined;
    const handle = withRequestObservability(() => {
      seenByHandler = getRequestId();
      return Promise.resolve(
        new Response('created', {
          status: 201,
          headers: { 'x-route': 'kept' },
        })
      );
    }, quietLogger());

    const response = await handle(
      new Request('http://localhost/anything', {
        headers: { 'x-request-id': incoming },
      })
    );

    expect(seenByHandler).toBe(incoming);
    expect(response.headers.get('x-request-id')).toBe(incoming);
    // The rebuilt response keeps what the route answered.
    expect(response.status).toBe(201);
    expect(response.headers.get('x-route')).toBe('kept');
    expect(await response.text()).toBe('created');
  });

  it('answers a handler that threw with the taxonomy 500 and the request id', async () => {
    const logger = quietLogger();
    const handle = withRequestObservability(
      () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
      logger
    );

    const response = await handle(new Request('http://localhost/anything'));

    expect(response.status).toBe(500);
    expect(toolErrorSchema.parse(await response.json())).toEqual({
      error: { code: 'internal', message: 'Internal server error.' },
    });
    // The caller gets an id to quote; the cause stays in the log line.
    expect(response.headers.get('x-request-id')).toMatch(/^req_/);
    expect(logger.error).toHaveBeenCalledWith(
      'http request failed',
      expect.objectContaining({ error: 'connect ECONNREFUSED 10.0.0.5:5432' })
    );
  });
});
