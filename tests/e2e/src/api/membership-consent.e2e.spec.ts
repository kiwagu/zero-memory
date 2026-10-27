/**
 * A membership confers nothing until its member accepts it.
 *
 * Granting was unilateral and scope creation is self-service, so any account
 * could manufacture a shared scope with anyone whose address it knew and read
 * their identity through the co-membership predicate on `profiles`. These
 * specs pin the two halves of the fix: an unaccepted grant is inert, and the
 * consented path still works.
 *
 * The second group pins what a membership row is: a bond between one scope,
 * one person and the admin who offered it. Nobody moves it, the invitee takes
 * exactly what was offered and says yes themselves, and only an admin of the
 * scope grades it.
 */
import { expect, test } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import { readSeedState } from '../helpers/runtime-state.js';
import {
  entityIdOf,
  type MembershipRow,
  passwordGrantToken,
  provisionE2EUser,
  scopeMemberships,
  userRestClient,
} from '../helpers/users.js';

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

test.describe('Membership rows are bound to their people', () => {
  /** What the API answers to a write, as far as these specs read it. */
  interface WriteResult {
    data: unknown;
    error: { code?: string; message: string } | null;
    status: number;
  }

  /** The membership of `userId` in `scope`, as the database holds it. */
  const membershipOf = async (
    scope: string,
    userId: string
  ): Promise<MembershipRow> => {
    const row = (await scopeMemberships(scope)).find(
      (r) => r.user_id === userId
    );
    if (!row) {
      throw new Error(`${userId} holds no membership of ${scope}`);
    }
    return row;
  };

  /** The write was turned down outright: forbidden, with nothing changed. */
  const expectForbidden = (result: WriteResult, what: string): void => {
    expect(result.error, what).not.toBeNull();
    expect(result.status, what).toBe(403);
    expect(result.error?.code, what).toBe('42501');
  };

  /**
   * The write changed nothing: turned down outright, or landing on no row
   * the caller may touch — an accepted member's own row is not theirs to
   * edit, so the attempt finds nothing and the API reports no changed row.
   */
  const expectUntouched = (result: WriteResult, what: string): void => {
    if (result.error) {
      expectForbidden(result, what);
      return;
    }
    expect(result.data, what).toEqual([]);
  };

  interface Invitation {
    scope: string;
    adminId: string;
    asAdmin: SupabaseClient;
    inviteeId: string;
    asInvitee: SupabaseClient;
  }

  /**
   * A fresh scope of user B's with `email`'s account invited into it in
   * `role`, the way the dashboard invites: still pending, waiting on the
   * invitee.
   */
  const invitation = async (
    tag: string,
    email: string,
    role: 'reader' | 'writer'
  ): Promise<Invitation> => {
    const seed = await readSeedState();
    const invitee = await provisionE2EUser(email);

    const asAdmin = userRestClient(await passwordGrantToken(seed.userB));
    const adminId = await entityIdOf(seed.userB.id);
    const scope = ownScope(adminId, uniqueSlug(tag));
    const created = await asAdmin.rpc('create_scope', { p_scope: scope });
    expect(created.error).toBeNull();

    const resolved = await asAdmin.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: invitee.email,
    });
    expect(resolved.error).toBeNull();
    const inviteeId = String(resolved.data);
    const granted = await asAdmin.rpc('add_scope_member', {
      p_scope: scope,
      p_user: inviteeId,
      p_role: role,
    });
    expect(granted.error).toBeNull();

    return {
      scope,
      adminId,
      asAdmin,
      inviteeId,
      asInvitee: userRestClient(await passwordGrantToken(invitee)),
    };
  };

  /** A PATCH of one membership row through the API, as the given caller. */
  const patchMembership = (
    client: SupabaseClient,
    scope: string,
    userId: string,
    values: Record<string, unknown>
  ): PromiseLike<WriteResult> =>
    client
      .from('scope_members')
      .update(values)
      .eq('scope', scope)
      .eq('user_id', userId)
      .select();

  test('@smoke a member cannot move their own membership to another scope', async () => {
    const seed = await readSeedState();
    const neighbour = await provisionE2EUser('consent-neighbour@zm.e2e');

    const rest = userRestClient(await passwordGrantToken(seed.userB));
    const myId = await entityIdOf(seed.userB.id);
    const mine = ownScope(myId, uniqueSlug('consent_mine'));
    expect(
      (await rest.rpc('create_scope', { p_scope: mine })).error
    ).toBeNull();

    const asNeighbour = userRestClient(await passwordGrantToken(neighbour));
    const neighbourId = await entityIdOf(neighbour.id);
    const theirs = ownScope(neighbourId, uniqueSlug('consent_theirs'));
    expect(
      (await asNeighbour.rpc('create_scope', { p_scope: theirs })).error
    ).toBeNull();

    const before = await membershipOf(mine, myId);
    expect(before.role).toBe('admin');
    expect(before.accepted_at).not.toBeNull();

    // THE POINT: an accepted admin membership of one's own, re-addressed to
    // a scope nobody shared. Before the fix this answered 200 and made the
    // caller an admin of a stranger's scope.
    expectForbidden(
      await patchMembership(rest, mine, myId, { scope: theirs }),
      'moving own membership'
    );

    expect(await membershipOf(mine, myId)).toEqual(before);
    expect((await scopeMemberships(theirs)).map((r) => r.user_id)).toEqual([
      neighbourId,
    ]);
  });

  test('@smoke an invitee cannot change the offered role or stamp an old acceptance', async () => {
    const f = await invitation(
      'consent_offer',
      'consent-upgrader@zm.e2e',
      'reader'
    );
    const offered = await membershipOf(f.scope, f.inviteeId);
    expect(offered.accepted_at).toBeNull();

    // The role they were offered is the role they get.
    expectForbidden(
      await patchMembership(f.asInvitee, f.scope, f.inviteeId, {
        role: 'admin',
      }),
      'invitee grading own offer'
    );
    expect(await membershipOf(f.scope, f.inviteeId)).toEqual(offered);

    // Saying yes is theirs — but WHEN they said it is recorded by the
    // product, not supplied by the caller: a backdated acceptance comes out
    // stamped with the moment it actually happened.
    const backdated = '2020-01-01T00:00:00.000Z';
    const accepted = await patchMembership(f.asInvitee, f.scope, f.inviteeId, {
      accepted_at: backdated,
    });
    expect(accepted.error).toBeNull();
    const stamped = await membershipOf(f.scope, f.inviteeId);
    expect(stamped.accepted_at).not.toBeNull();
    expect(
      Math.abs(Date.parse(stamped.accepted_at ?? '') - Date.now())
    ).toBeLessThan(10_000);
    expect(stamped.role).toBe('reader');

    // Accepted once, the acceptance is settled.
    expectUntouched(
      await patchMembership(f.asInvitee, f.scope, f.inviteeId, {
        accepted_at: backdated,
      }),
      'restamping an acceptance'
    );
    expect(await membershipOf(f.scope, f.inviteeId)).toEqual(stamped);
  });

  test("@smoke an admin cannot record another person's acceptance", async () => {
    const f = await invitation(
      'consent_vouch',
      'consent-vouchee@zm.e2e',
      'reader'
    );
    const pending = await membershipOf(f.scope, f.inviteeId);
    expect(pending.accepted_at).toBeNull();

    // Consent is the invitee's to give; the admin who offered the membership
    // cannot say yes on their behalf.
    expectForbidden(
      await patchMembership(f.asAdmin, f.scope, f.inviteeId, {
        accepted_at: new Date().toISOString(),
      }),
      'admin accepting for the invitee'
    );
    expect(await membershipOf(f.scope, f.inviteeId)).toEqual(pending);

    // What the admin may still do with an offer is change it. It stays an
    // offer: the new role waits for the same yes.
    const regraded = await f.asAdmin.rpc('add_scope_member', {
      p_scope: f.scope,
      p_user: f.inviteeId,
      p_role: 'writer',
    });
    expect(regraded.error).toBeNull();
    const after = await membershipOf(f.scope, f.inviteeId);
    expect(after.role).toBe('writer');
    expect(after.accepted_at).toBeNull();
    expect(after.granted_by).toBe(f.adminId);
  });

  test('a non-admin member cannot change roles or the granter', async () => {
    const f = await invitation(
      'consent_rank',
      'consent-climber@zm.e2e',
      'writer'
    );
    const joined = await f.asInvitee.rpc('accept_scope_invitation', {
      p_scope: f.scope,
    });
    expect(joined.error).toBeNull();
    const before = await membershipOf(f.scope, f.inviteeId);
    expect(before.accepted_at).not.toBeNull();
    expect(before.role).toBe('writer');

    // A membership is held, not administered, by its member: neither the
    // rank nor whose name it was granted in is theirs to rewrite.
    expectUntouched(
      await patchMembership(f.asInvitee, f.scope, f.inviteeId, {
        role: 'admin',
      }),
      'member promoting themselves'
    );
    expectUntouched(
      await patchMembership(f.asInvitee, f.scope, f.inviteeId, {
        granted_by: f.inviteeId,
      }),
      'member granting themselves'
    );
    expect(await membershipOf(f.scope, f.inviteeId)).toEqual(before);
  });

  test("the owner of a scope still changes a member's role", async () => {
    const f = await invitation(
      'consent_promote',
      'consent-promotee@zm.e2e',
      'reader'
    );
    const joined = await f.asInvitee.rpc('accept_scope_invitation', {
      p_scope: f.scope,
    });
    expect(joined.error).toBeNull();
    const before = await membershipOf(f.scope, f.inviteeId);

    const promoted = await patchMembership(f.asAdmin, f.scope, f.inviteeId, {
      role: 'writer',
    });
    expect(promoted.error).toBeNull();

    // The grade changed and nothing else about the bond did: same person,
    // same scope, same acceptance.
    expect(await membershipOf(f.scope, f.inviteeId)).toEqual({
      ...before,
      role: 'writer',
    });
    const canWrite = await f.asInvitee.rpc('can_write_scope', {
      p_scope: f.scope,
    });
    expect(canWrite.error).toBeNull();
    expect(canWrite.data).toBe(true);
  });
});
