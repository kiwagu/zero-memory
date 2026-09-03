import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FixedWindowRateLimiter,
  rateLimitedResponse,
  rateLimiterOptionsFromEnv,
  resolveClientIp,
} from './rate-limit.js';

const makeClock = (startMs = 1_000_000) => {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

describe('FixedWindowRateLimiter', () => {
  it('allows up to maxRequests within a window, then denies', () => {
    const clock = makeClock();
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 3,
      windowSeconds: 60,
      now: clock.now,
    });

    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(true);
    const denied = limiter.hit('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(60);
  });

  it('anchors the window at the first request and resets after it elapses', () => {
    const clock = makeClock();
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 2,
      windowSeconds: 60,
      now: clock.now,
    });

    limiter.hit('k');
    clock.advance(30_000);
    limiter.hit('k');
    // 45s into the window: over the limit, 15s left until reset.
    clock.advance(15_000);
    const denied = limiter.hit('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(15);

    // Window elapsed: a fresh window opens with a reset counter.
    clock.advance(15_000);
    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(false);
  });

  it('reports at least 1 second of Retry-After', () => {
    const clock = makeClock();
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 1,
      windowSeconds: 60,
      now: clock.now,
    });
    limiter.hit('k');
    clock.advance(59_999);
    expect(limiter.hit('k').retryAfterSeconds).toBe(1);
  });

  it('isolates keys from one another', () => {
    const clock = makeClock();
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 1,
      windowSeconds: 60,
      now: clock.now,
    });

    expect(limiter.hit('1.2.3.4:token').allowed).toBe(true);
    expect(limiter.hit('1.2.3.4:token').allowed).toBe(false);
    // Same IP, different route — separate budget.
    expect(limiter.hit('1.2.3.4:register').allowed).toBe(true);
    // Different IP, same route — separate budget.
    expect(limiter.hit('5.6.7.8:token').allowed).toBe(true);
  });

  it('sweeps only fully elapsed windows', () => {
    const clock = makeClock();
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 5,
      windowSeconds: 60,
      now: clock.now,
    });

    limiter.hit('stale');
    clock.advance(45_000);
    limiter.hit('active');
    clock.advance(15_000); // stale is 60s old, active is 15s old.
    limiter.sweep();
    expect(limiter.size).toBe(1);

    clock.advance(45_000);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

describe('rateLimiterOptionsFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 30 requests per 60 seconds', () => {
    vi.stubEnv('ZM_RATELIMIT_MAX', '');
    vi.stubEnv('ZM_RATELIMIT_WINDOW_S', '');
    expect(rateLimiterOptionsFromEnv()).toEqual({
      maxRequests: 30,
      windowSeconds: 60,
    });
  });

  it('honors ZM_RATELIMIT_MAX and ZM_RATELIMIT_WINDOW_S overrides', () => {
    vi.stubEnv('ZM_RATELIMIT_MAX', '5');
    vi.stubEnv('ZM_RATELIMIT_WINDOW_S', '10');
    expect(rateLimiterOptionsFromEnv()).toEqual({
      maxRequests: 5,
      windowSeconds: 10,
    });
  });

  it('falls back to defaults on non-positive or garbage values', () => {
    vi.stubEnv('ZM_RATELIMIT_MAX', '0');
    vi.stubEnv('ZM_RATELIMIT_WINDOW_S', 'soon');
    expect(rateLimiterOptionsFromEnv()).toEqual({
      maxRequests: 30,
      windowSeconds: 60,
    });
  });
});

describe('rateLimitedResponse', () => {
  it('returns a 429 with Retry-After and an OAuth-shaped error body', async () => {
    const response = rateLimitedResponse(42);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({
      error: 'rate_limited',
      error_description: 'Too many requests. Retry later.',
    });
  });
});

describe('resolveClientIp', () => {
  const makeRequest = (headers: Record<string, string> = {}): Request =>
    new Request('http://localhost/oauth/token', { method: 'POST', headers });

  it('uses the first X-Forwarded-For hop when the proxy is trusted', () => {
    const request = makeRequest({
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    });
    expect(resolveClientIp(request, null, true)).toBe('203.0.113.7');
  });

  it('IGNORES X-Forwarded-For by default (spoof-proof when direct-exposed)', () => {
    const request = makeRequest({
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    });
    const server = { requestIP: () => ({ address: '192.0.2.9' }) };
    expect(resolveClientIp(request, server, false)).toBe('192.0.2.9');
  });

  it('falls back to the socket address without the header', () => {
    const server = { requestIP: () => ({ address: '192.0.2.9' }) };
    expect(resolveClientIp(makeRequest(), server, true)).toBe('192.0.2.9');
  });

  it('returns "unknown" when no source is available', () => {
    expect(resolveClientIp(makeRequest(), null, false)).toBe('unknown');
    expect(
      resolveClientIp(makeRequest({ 'x-forwarded-for': ' ' }), {
        requestIP: () => null,
      })
    ).toBe('unknown');
  });
});
