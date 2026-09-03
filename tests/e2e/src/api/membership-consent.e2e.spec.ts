/**
 * A membership confers nothing until its member accepts it.
 *
 * Granting was unilateral and scope creation is self-service, so any account
 * could manufacture a shared scope with anyone whose address it knew and read
 * their identity through the co-membership predicate on `profiles`. These
 * specs pin the two halves of the fix: an unaccepted grant is inert, and the
 * consented path still works.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

/**
 * The `usr_` entity id behind an auth uuid, read past RLS with the service
 * role. Deliberately NOT "the first row of profiles the caller can see": once
 * the caller has co-members that set holds several people, and picking the
 * first one silently attributes someone else's id to the caller.
 */
const entityIdOf = async (authUserId: string): Promise<string> => {
  const admin = createClient(
    e2eEnv.supabaseUrl,
    e2eEnv.supabaseServiceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data, error } = await admin
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
};

/** `proj.<owner with dots folded>.<slug>` — the per-owner project namespace. */
const ownScope = (userEntityId: string, slug: string): string =>
  `proj.${userEntityId.replace(/\./g, '_')}.${slug}`;

/**
 * A fresh scope path per run. `create_scope` refuses a path whose ancestor or
 * descendant already has members, so a fixed slug makes the spec pass once and
 * then fail on every repeat against a warm stand — which reads as a product
 * bug and is not one.
 */
const uniqueSlug = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

test.describe('Membership requires consent', () => {
  test('@smoke an unaccepted grant reveals nothing about the person granted', async () => {
    const seed = await readSeedState();
    const target = await provisionE2EUser('consent-target@zm.e2e');

    const granterToken = await passwordGrantToken(seed.userB);
    const rest = userRestClient(granterToken);

    const myId = await entityIdOf(seed.userB.id);

    const scope = ownScope(myId, uniqueSlug('consent_probe'));
    const created = await rest.rpc('create_scope', { p_scope: scope });
    expect(created.error).toBeNull();

    // Resolve the target and grant them a membership they never asked for.
    const resolved = await rest.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: target.email,
    });
    expect(resolved.error).toBeNull();
    const targetId = String(resolved.data);
    expect(targetId).toMatch(/^usr_/);

    const granted = await rest.rpc('add_scope_member', {
      p_scope: scope,
      p_user: targetId,
      p_role: 'reader',
    });
    expect(granted.error).toBeNull();

    // THE POINT: the grant landed, and it bought the granter nothing. Before
    // the fix this is exactly where the target's profile row became readable.
    const { data: after, error } = await rest.from('profiles').select('id');
    expect(error).toBeNull();
    const visibleIds = ((after ?? []) as { id: string }[]).map((r) => r.id);
    expect(visibleIds).toContain(myId);
    expect(visibleIds).not.toContain(targetId);

    const identities = await rest.rpc('scope_member_identities');
    expect(identities.error).toBeNull();
    const emails = ((identities.data ?? []) as { email: string }[]).map(
      (r) => r.email
    );
    expect(emails).not.toContain(target.email);
  });

  test('@smoke the invitee sees the pending invitation and accepting is what makes it real', async () => {
    const seed = await readSeedState();
    const target = await provisionE2EUser('consent-accepter@zm.e2e');

    const rest = userRestClient(await passwordGrantToken(seed.userB));
    const myId = await entityIdOf(seed.userB.id);
    const scope = ownScope(myId, uniqueSlug('consent_accept'));

    await rest.rpc('create_scope', { p_scope: scope });
    const resolved = await rest.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: target.email,
    });
    await rest.rpc('add_scope_member', {
      p_scope: scope,
      p_user: String(resolved.data),
      p_role: 'writer',
    });

    const asTarget = userRestClient(await passwordGrantToken(target));

    // The invitee can see what they were offered — an invitation nobody can
    // see cannot be accepted — but it is inert until they act on it.
    const pending = await asTarget.rpc('pending_scope_invitations');
    expect(pending.error).toBeNull();
    const rows = (pending.data ?? []) as { scope: string; role: string }[];
    expect(rows.map((r) => r.scope)).toContain(scope);
    expect(rows.find((r) => r.scope === scope)?.role).toBe('writer');

    const beforeWrite = await asTarget.rpc('can_write_scope', {
      p_scope: scope,
    });
    expect(beforeWrite.error).toBeNull();
    expect(beforeWrite.data).toBe(false);

    const accepted = await asTarget.rpc('accept_scope_invitation', {
      p_scope: scope,
    });
    expect(accepted.error).toBeNull();

    const afterWrite = await asTarget.rpc('can_write_scope', {
      p_scope: scope,
    });
    expect(afterWrite.error).toBeNull();
    expect(afterWrite.data).toBe(true);

    const stillPending = await asTarget.rpc('pending_scope_invitations');
    expect(
      ((stillPending.data ?? []) as { scope: string }[]).map((r) => r.scope)
    ).not.toContain(scope);
  });

  test('declining removes the invitation without telling the granter who refused', async () => {
    const seed = await readSeedState();
    const target = await provisionE2EUser('consent-decliner@zm.e2e');

    const rest = userRestClient(await passwordGrantToken(seed.userB));
    const myId = await entityIdOf(seed.userB.id);
    const scope = ownScope(myId, uniqueSlug('consent_decline'));

    await rest.rpc('create_scope', { p_scope: scope });
    const resolved = await rest.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: target.email,
    });
    await rest.rpc('add_scope_member', {
      p_scope: scope,
      p_user: String(resolved.data),
      p_role: 'reader',
    });

    const asTarget = userRestClient(await passwordGrantToken(target));
    const declined = await asTarget.rpc('decline_scope_invitation', {
      p_scope: scope,
    });
    expect(declined.error).toBeNull();

    // Gone for the invitee...
    const pending = await asTarget.rpc('pending_scope_invitations');
    expect(
      ((pending.data ?? []) as { scope: string }[]).map((r) => r.scope)
    ).not.toContain(scope);

    // ...and no refusal tombstone the granter could read as "this person said
    // no": the row is deleted, so a re-invitation looks like a first one.
    const { data: members } = await rest
      .from('scope_members')
      .select('user_id')
      .eq('scope', scope);
    expect(
      ((members ?? []) as { user_id: string }[]).map((r) => r.user_id)
    ).not.toContain(String(resolved.data));
  });
});
