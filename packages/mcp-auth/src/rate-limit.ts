/**
 * In-memory fixed-window rate limiter for the unauthenticated OAuth surface
 * (token / authorize / register are the only brute-forceable endpoints).
 *
 * Each key gets its own window anchored at its first request (no clock
 * alignment, no jitter): requests within `windowSeconds` of the anchor share
 * a counter; the first request after the window elapses starts a fresh one.
 * State is a plain Map — single-process by design (one server instance per
 * deployment); a shared store is only needed if that topology changes.
 */

const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_SECONDS = 60;

export interface RateLimiterOptions {
  /** Requests allowed per key per window (ZM_RATELIMIT_MAX, default 30). */
  maxRequests?: number;
  /** Window length in seconds (ZM_RATELIMIT_WINDOW_S, default 60). */
  windowSeconds?: number;
  /** Clock override for tests (epoch milliseconds). */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller's window resets (0 when allowed). */
  retryAfterSeconds: number;
}

interface WindowEntry {
  windowStartMs: number;
  count: number;
}

const positiveIntFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Reads ZM_RATELIMIT_MAX / ZM_RATELIMIT_WINDOW_S with safe defaults. */
export const rateLimiterOptionsFromEnv = (): Required<
  Omit<RateLimiterOptions, 'now'>
> => ({
  maxRequests: positiveIntFromEnv('ZM_RATELIMIT_MAX', DEFAULT_MAX_REQUESTS),
  windowSeconds: positiveIntFromEnv(
    'ZM_RATELIMIT_WINDOW_S',
    DEFAULT_WINDOW_SECONDS
  ),
});

export class FixedWindowRateLimiter {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, WindowEntry>();

  constructor(options: RateLimiterOptions = {}) {
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#windowMs = (options.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
    this.#now = options.now ?? Date.now;
  }

  /** Records one request for `key` and decides whether it is allowed. */
  hit(key: string): RateLimitDecision {
    const now = this.#now();
    const entry = this.#entries.get(key);

    if (!entry || now - entry.windowStartMs >= this.#windowMs) {
      this.#entries.set(key, { windowStartMs: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    entry.count += 1;
    if (entry.count <= this.#maxRequests) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((entry.windowStartMs + this.#windowMs - now) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  /** Drops entries whose window has fully elapsed (periodic housekeeping). */
  sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (now - entry.windowStartMs >= this.#windowMs) {
        this.#entries.delete(key);
      }
    }
  }

  /** Number of tracked keys (observability / tests). */
  get size(): number {
    return this.#entries.size;
  }
}

/** Minimal shape of Bun's server for socket-address fallback. */
export interface RequestIpSource {
  requestIP?: (request: Request) => { address: string } | null;
}

/**
 * Whether X-Forwarded-For may be trusted for rate-limit keying. Default OFF:
 * a direct-exposed server that trusts XFF is trivially bypassable — one
 * spoofed header value per request means one fresh bucket per request, i.e.
 * no limiting at all. Set ZM_TRUST_PROXY=true only when the server sits
 * behind our edge (the caddy/nginx overlays set/overwrite the header).
 */
export const trustProxyFromEnv = (): boolean => {
  const raw = (process.env.ZM_TRUST_PROXY ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on';
};

/**
 * Client IP for rate-limit keying: the socket address by default; the first
 * X-Forwarded-For hop only when `trustProxy` is explicitly enabled.
 */
export const resolveClientIp = (
  request: Request,
  server?: RequestIpSource | null,
  trustProxy: boolean = trustProxyFromEnv()
): string => {
  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for');
    const firstHop = forwarded?.split(',')[0]?.trim();
    if (firstHop) {
      return firstHop;
    }
  }
  return server?.requestIP?.(request)?.address ?? 'unknown';
};

/** 429 with Retry-After, RFC 6749-shaped JSON error body. */
export const rateLimitedResponse = (retryAfterSeconds: number): Response =>
  new Response(
    JSON.stringify({
      error: 'rate_limited',
      error_description: 'Too many requests. Retry later.',
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'retry-after': String(retryAfterSeconds),
      },
    }
  );
