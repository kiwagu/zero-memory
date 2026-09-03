import { mcpAuthPlugin } from '@workspace/mcp-auth';
import { Elysia } from 'elysia';

import { buildVersion, checkoutRevision } from './build-version.js';
import { errorResponse, errorResponseFromThrown } from './http-error.js';
import { renderMetrics } from './metrics.js';
import { createMcpHttpRoutes } from './mcp-http.js';
import {
  createDefaultReadinessProbes,
  createReadinessRoutes,
  type ReadinessProbes,
} from './readiness.js';

export interface AppOptions {
  /** Public base URL of this server (OAuth issuer), no trailing slash. */
  publicUrl: string;
  /** Downstream probes for /readyz; defaults read env + the DI container. */
  readiness?: ReadinessProbes;
}

export const createApp = (options: AppOptions) =>
  new Elysia()
    // Every failure this app owns answers in one shape, so a client branches on
    // `error.code`. Global scope so it also covers the routes contributed by
    // plugins. It only ever sees THROWN failures and unmatched paths — the
    // protocol responses the OAuth endpoints and /mcp return deliberately
    // (RFC 6749/6750, JSON-RPC) never pass through here.
    .onError({ as: 'global' }, ({ code, error }) => {
      if (code === 'NOT_FOUND') {
        return errorResponse('not_found', 'No route matches this request.');
      }
      if (code === 'VALIDATION' || code === 'PARSE') {
        return errorResponse('validation_failed', 'Malformed request.');
      }
      return errorResponseFromThrown(error);
    })
    // Liveness: process is up (container healthcheck target). Carries the
    // build identity so operators can see which build actually serves.
    .get('/healthz', () => ({
      ok: true,
      version: buildVersion(),
      checkout: checkoutRevision(),
    }))
    // Prometheus scrape target: in-process counters (requests, tool calls).
    .get(
      '/metrics',
      () =>
        new Response(renderMetrics(), {
          headers: { 'content-type': 'text/plain; version=0.0.4' },
        })
    )
    // Readiness: downstreams reachable (monitoring probe, see infra/prod).
    .use(
      createReadinessRoutes(options.readiness ?? createDefaultReadinessProbes())
    )
    .use(mcpAuthPlugin({ issuer: options.publicUrl }))
    .use(createMcpHttpRoutes({ issuer: options.publicUrl }));

export type App = ReturnType<typeof createApp>;
