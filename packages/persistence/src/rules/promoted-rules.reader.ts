import type { ContextRule } from '@workspace/contracts';
import { deliverableRules } from '@workspace/db';

import { readAllPages } from '../paged-read.js';
import { createUserClient } from '../supabase.client.js';

/**
 * The caller's PROMOTED user-layer (General) rules (rules-incubator output):
 * standing instructions the owner elevated out of memory. Read with the
 * caller's own JWT — RLS scopes the rows to their owner. Explicit-token (no
 * ALS) so it also works at MCP session creation, which runs outside the
 * request context.
 *
 * Delivery order IS the priority: PINNED first (the owner's guarantee that
 * the rule reaches the session at all), then newest-first — so when more
 * rules are promoted than a channel's cap admits, a fresh promotion takes
 * effect immediately instead of waiting out older rules.
 *
 * Soft-TTL: rules older than the delivery TTL (by promoted_at) drop OUT of
 * delivery — they stay on /rules for the owner to re-promote or revoke.
 * Pinned rules are EXEMPT: the pin is a standing decision, so it never
 * expires silently by age. The age rule and the order are applied here by
 * `deliverableRules`, the same function the /rules page counts with.
 *
 * Every promoted row is read, paged: the age rule runs in memory, so expired
 * rows arrive too and accumulate over time. A single response would hit
 * PostgREST's max-rows cap and silently drop an arbitrary subset — pinned
 * rules included.
 */
export async function listPromotedUserRules(
  accessToken: string
): Promise<ContextRule[]> {
  const client = createUserClient(accessToken);
  const data = await readAllPages(
    (from, to) =>
      client
        .from('rule_candidates')
        .select('rule_text, pinned, promoted_at')
        .eq('status', 'promoted')
        .eq('target_layer', 'user')
        .is('revoked_at', null)
        .not('rule_text', 'is', null)
        // A total order, so no row lands on two pages or on none; the
        // delivery order itself is deliverableRules' to decide.
        .order('id', { ascending: true })
        .range(from, to),
    { label: 'promoted rules lookup' }
  );
  const rules = data.map((row) => ({
    text: row.rule_text?.trim() ?? '',
    pinned: row.pinned === true,
    promotedAt: row.promoted_at,
  }));
  return deliverableRules(rules, Date.now()).flatMap(({ text, pinned }) =>
    text ? [{ text, pinned }] : []
  );
}
