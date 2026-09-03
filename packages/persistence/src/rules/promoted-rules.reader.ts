import type { ContextRule } from '@workspace/contracts';
import { ruleDeliveryCutoff } from '@workspace/db';

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
 * expires silently by age.
 */
export async function listPromotedUserRules(
  accessToken: string
): Promise<ContextRule[]> {
  const { data, error } = await createUserClient(accessToken)
    .from('rule_candidates')
    .select('rule_text, pinned')
    .eq('status', 'promoted')
    .eq('target_layer', 'user')
    .is('revoked_at', null)
    .not('rule_text', 'is', null)
    .or(`pinned.eq.true,promoted_at.gte.${ruleDeliveryCutoff(Date.now())}`)
    .order('pinned', { ascending: false })
    .order('promoted_at', { ascending: false });
  if (error) {
    throw new Error(`promoted rules lookup failed: ${error.message}`);
  }
  return (data ?? []).flatMap((row) => {
    const text = row.rule_text?.trim();
    return text ? [{ text, pinned: row.pinned === true }] : [];
  });
}
