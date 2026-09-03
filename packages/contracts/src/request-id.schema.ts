import { z } from 'zod';

import { entityIdSchemas } from './entity-prefixes.js';

/**
 * Correlation id for a single inbound request (HTTP) or processing run
 * (watcher). It is a distinctly-branded entity id under the `req_` prefix, so
 * every id that crosses a trust boundary — e.g. an incoming `X-Request-Id`
 * header — is validated by parsing rather than trusted as a raw string, and a
 * `RequestId` is a different compile-time type from other entity ids. Anything
 * that does not parse is rejected and a fresh id is minted in its place.
 */
export const requestIdSchema = entityIdSchemas.request.schema;

export type RequestId = z.infer<typeof requestIdSchema>;

/** Mint a fresh request id. */
export const newRequestId = (): RequestId => entityIdSchemas.request.create();
