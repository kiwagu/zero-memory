import { getRequestId } from '@workspace/context';
import { createLogger, setLogContextResolver } from '@workspace/logger';
import { trustProxyFromEnv } from '@workspace/mcp-auth';
import { Elysia } from 'elysia';

import { createApp } from './app.js';
import { resolvePublicUrl } from './public-url.js';
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
const inner = createApp({ publicUrl });
const handle = withRequestObservability(
  (request) => inner.handle(request),
  logger
);
const app = new Elysia()
  .all('*', ({ request }) => handle(request))
  .listen(port);

for (const warning of publicUrlWarnings) {
  logger.warn('public url', { warning });
}

logger.info('server started', { port, publicUrl });

// Optional in-process nightly hygiene scan (independent of the watcher).
startHygieneScheduler();

// Optional in-process nightly language-canonicalization pass (opt-in).
startTranslationScheduler();

// Storage upkeep for the usage ledger. Always on: it costs SQL, not tokens.
startUsageScheduler();

export type { App } from './app.js';
export { app };
