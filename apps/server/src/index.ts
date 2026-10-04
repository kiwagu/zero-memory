import { getRequestId } from '@workspace/context';
import { createLogger, setLogContextResolver } from '@workspace/logger';
import { trustProxyFromEnv } from '@workspace/mcp-auth';
import { Elysia } from 'elysia';

import { createApp } from './app.js';
import { resolvePublicUrl, resolveWebUrl } from './public-url.js';
import { startHygieneScheduler } from './hygiene-scheduler.js';
import { startTranslationScheduler } from './translation-scheduler.js';
import { startUsageScheduler } from './usage-scheduler.js';
import { withRequestObservability } from './observability.js';
import { register } from './registry/index.js';

const logger = createLogger('server');
const port = Number(process.env.PORT ?? 8787);
// The issuer is validated before anything listens: a wrong public URL breaks
// every client at once and does it silently, so it is worth failing to start.
const { url: publicUrl, warnings: publicUrlWarnings } = resolvePublicUrl({
  raw: process.env.ZM_PUBLIC_URL,
  port,
  trustProxy: trustProxyFromEnv(),
});
// The dashboard is where a person signs in and approves an agent; the
// authorization endpoint sends them there, so it is validated the same way.
const { url: webUrl, warnings: webUrlWarnings } = resolveWebUrl({
  raw: process.env.ZM_WEB_URL,
  trustProxy: trustProxyFromEnv(),
});

// The logger is a dependency-free leaf: feed it the ambient correlation id so
// every line — including deep persistence/extraction logs — carries requestId.
setLogContextResolver(() => {
  const requestId = getRequestId();
  return requestId ? { requestId } : undefined;
});

register();

// A thin outer app owns listening and wraps every request in the correlation
// context before delegating to the real routes (`inner.handle`). This keeps the
// ALS boundary in one place and out of Elysia's per-route lifecycle.
// Only the outer app knows the client's socket; the OAuth rate limiter asks
// for it through this callback (its own app never listens).
const inner = createApp({ publicUrl, webUrl, requestIp: () => app.server });
const handle = withRequestObservability(
  (request) => inner.handle(request),
  logger
);
// A body larger than this serves no tool or OAuth request; the runtime's own
// default (128 MB) would let one anonymous client fill memory.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const app = new Elysia()
  .all('*', ({ request }) => handle(request))
  .listen({ port, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });

for (const warning of publicUrlWarnings) {
  logger.warn('public url', { warning });
}
for (const warning of webUrlWarnings) {
  logger.warn('web url', { warning });
}

logger.info('server started', { port, publicUrl, webUrl });

// Optional in-process nightly hygiene scan (independent of the watcher).
startHygieneScheduler();

// Optional in-process nightly language-canonicalization pass (opt-in).
startTranslationScheduler();

// Storage upkeep for the usage ledger. Always on: it costs SQL, not tokens.
startUsageScheduler();

export type { App } from './app.js';
export { app };
