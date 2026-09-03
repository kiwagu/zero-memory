/**
 * Seeds a two-version supersession chain for a user through the service-role
 * client: an older memory whose `superseded_by` points at (and is invalidated
 * in favour of) a current one. Idempotent — lookups match on content regardless
 * of invalidation, so re-seeding re-applies the same chain instead of forking
 * a new pair. Drives the version-history section on the memory detail page.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';
import type { E2EUser } from './users.js';

export interface SeededVersionChain {
  currentId: string;
  oldId: string;
  invalidatorAgent: string;
  invalidatorModel: string;
  currentContent: string;
  oldContent: string;
}

// The old version is invalidated as a system action (mirrors the hygiene
// scanner's #supersede): no usr_ actor, attributed to the scanner + judge model.
const INVALIDATOR_AGENT = 'hygiene-scanner';
const INVALIDATOR_MODEL = 'claude-haiku-4-5-20251001';

// Dedicated content (not part of FIXTURE_MEMORIES) so this chain never disturbs
// the feed fixtures other specs assert on.
const OLD_CONTENT =
  'E2E version fixture: the rate limiter allows 30 requests per minute.';
const CURRENT_CONTENT =
  'E2E version fixture: the rate limiter allows 100 requests per minute.';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export const seedVersionChain = async (
  user: E2EUser,
  // Overridable so the demo seed can drop the fixture marker from content
  // that lands in published screenshots; specs keep the defaults.
  contents: { old: string; current: string } = {
    old: OLD_CONTENT,
    current: CURRENT_CONTENT,
  }
): Promise<SeededVersionChain> => {
  const client = adminClient();

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `version seed: profile lookup failed: ${profileError?.message}`
    );
  }
  const ownerId = (profile as { id: string }).id;
  const scope = `user.${ownerId.replace('.', '_')}`;

  // Match on content only (NOT invalidated_at) so the already-invalidated old
  // row is found on re-runs instead of being duplicated.
  const ensure = async (content: string): Promise<string> => {
    const { data: existing } = await client
      .from('memories')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('content', content)
      .maybeSingle();
    if (existing) {
      return (existing as { id: string }).id;
    }
    const { data: inserted, error } = await client
      .from('memories')
      .insert({ content, kind: 'fact', scope, owner_id: ownerId })
      .select('id')
      .single();
    if (error) {
      throw new Error(`version seed: insert memory failed: ${error.message}`);
    }
    return (inserted as { id: string }).id;
  };

  const oldId = await ensure(contents.old);
  const currentId = await ensure(contents.current);

  // Point the old row at the current one and invalidate it as the hygiene
  // scanner would (system action: no usr_ actor, attributed to the scanner +
  // judge model). Idempotent.
  const { error: linkError } = await client
    .from('memories')
    .update({
      superseded_by: currentId,
      invalidated_at: new Date().toISOString(),
      invalidated_by: null,
      invalidated_by_agent: INVALIDATOR_AGENT,
      invalidated_by_model: INVALIDATOR_MODEL,
    })
    .eq('id', oldId);
  if (linkError) {
    throw new Error(
      `version seed: supersede link failed: ${linkError.message}`
    );
  }
  // Keep the current row as the live head (idempotent on re-runs).
  const { error: headError } = await client
    .from('memories')
    .update({
      superseded_by: null,
      invalidated_at: null,
      invalidated_by: null,
      invalidated_by_agent: null,
      invalidated_by_model: null,
    })
    .eq('id', currentId);
  if (headError) {
    throw new Error(`version seed: head reset failed: ${headError.message}`);
  }

  return {
    currentId,
    oldId,
    invalidatorAgent: INVALIDATOR_AGENT,
    invalidatorModel: INVALIDATOR_MODEL,
    currentContent: contents.current,
    oldContent: contents.old,
  };
};
