import { z } from 'zod';

import { contextRuleSchema } from './graph.schema.js';

/**
 * MCP resource URIs — the read-only plane over the store. Resources never
 * mutate state: they are views the client can dereference without a tool
 * call. The `zm:` scheme is deliberately id-only (no scope segment): which
 * memories a URI resolves to is decided by the caller's authenticated
 * context and RLS, never by the URI itself, so a pasted URI can leak nothing
 * but an opaque id.
 */

/** RFC 6570 template for one full memory by its canonical id. */
export const ZM_MEMORY_URI_TEMPLATE = 'zm://memory/{id}';

/** Canonical URI of one memory. */
export const zmMemoryUri = (id: string): string => `zm://memory/${id}`;

/** The caller's standing promoted rules, pinned first. */
export const ZM_RULES_URI = 'zm://rules';

/**
 * Payload of the `zm://rules` resource: the same rules build_context delivers
 * in `rules[]`, served as a dereferenceable document so a client can pull
 * (or re-pull) them without a briefing call.
 */
export const promotedRulesResourceSchema = z.object({
  rules: contextRuleSchema.array(),
});
export type PromotedRulesResource = z.infer<typeof promotedRulesResourceSchema>;
