/**
 * Account erasure: hard_delete_user against the ownership map.
 *
 * The guarantee worth an e2e rather than a unit test: after erasure NOTHING the
 * map attributes to the user survives — across owned tables, tables owned only
 * transitively through a memory, and the content-free audit trail whose only
 * link to the user is severed — and the auth principal is gone. The completeness
 * check is DRIVEN by the map (packages/db), so it covers whatever the map
 * covers; a table added to the map later is asserted here without editing this
 * file. Idempotency is pinned too: a second call is a clean no-op.
 *
 * A representative fixture is seeded across every disposition (owned direct,
 * owned-through-memory, transitive, anonymize) — enough that the pre-assertion
 * is not vacuous. The exhaustive numeric proof over a full corpus is a rehearsal
 * on a database clone; this is the standing regression.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import {
  ACCOUNT_OWNERSHIP_MAP,
  excludedTables,
  USER_BACK_REFERENCES,
  userDataTables,
  type UserDataDisposition,
} from '@workspace/db';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  type E2EUser,
} from '../helpers/users.js';

const admin = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Rows the map attributes to a user, in a given table, after or before erasure. */
const countForUser = async (
  db: SupabaseClient,
  table: string,
  disposition: UserDataDisposition,
  userId: string,
  memoryIds: string[]
): Promise<number> => {
  if (disposition.kind === 'excluded') {
    return 0;
  }
  if (disposition.kind === 'owned') {
    const { count, error } = await db
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(disposition.ownerColumn, userId);
    if (error) {
      throw new Error(
        `count ${table}.${disposition.ownerColumn}: ${error.message}`
      );
    }
    return count ?? 0;
  }
  if (disposition.kind === 'anonymize') {
    const { count, error } = await db
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(disposition.column, userId);
    if (error) {
      throw new Error(`count ${table}.${disposition.column}: ${error.message}`);
    }
    return count ?? 0;
  }
  // transitive: a row belongs to the user if any ref column points at one of
  // the user's memories.
  let total = 0;
  for (const column of disposition.refColumns) {
    const { count, error } = await db
      .from(table)
      .select('*', { count: 'exact', head: true })
      .in(column, memoryIds);
    if (error) {
      throw new Error(`count ${table}.${column}: ${error.message}`);
    }
    total += count ?? 0;
  }
  return total;
};

const insertOrThrow = async (
  db: SupabaseClient,
  table: string,
  row: Record<string, unknown>
): Promise<void> => {
  const { error } = await db.from(table).insert(row);
  if (error) {
    throw new Error(`seed ${table}: ${error.message}`);
  }
};

const updateOrThrow = async (
  db: SupabaseClient,
  table: string,
  patch: Record<string, unknown>,
  match: Record<string, string>
): Promise<void> => {
  const { error } = await db.from(table).update(patch).match(match);
  if (error) {
    throw new Error(`patch ${table}: ${error.message}`);
  }
};

/**
 * A fresh account at a fixed address. A prior failed run may have left one
 * behind — erase any leftover first (hard_delete removes the auth user too),
 * THEN provision, so the test works with a live auth id rather than a
 * pre-erase one that would dangle.
 */
const provisionFreshUser = async (
  db: SupabaseClient,
  email: string
): Promise<{ user: E2EUser; userId: string }> => {
  const stale = await provisionE2EUser(email);
  const { data: staleProfile } = await db
    .from('profiles')
    .select('id')
    .eq('user_id', stale.id)
    .maybeSingle();
  if (staleProfile?.id) {
    await db.rpc('hard_delete_user', { p_user_id: staleProfile.id });
  }
  const fresh = await provisionE2EUser(email);
  const { data: profile } = await db
    .from('profiles')
    .select('id')
    .eq('user_id', fresh.id)
    .single();
  return { user: fresh, userId: profile!.id as string };
};

/** The two memories every fixture account seeds, through the real tool. */
const rememberTwo = async (
  user: E2EUser,
  label: string
): Promise<[string, string]> => {
  const mcp = await McpTestClient.connect(await passwordGrantToken(user));
  try {
    const first = await mcp.callTool('remember', {
      content: `e2e erasure fixture (${label}): the account-lifecycle cascade must handle this memory.`,
      kind: 'fact',
      scope: 'personal',
    });
    const second = await mcp.callTool('remember', {
      content: `e2e erasure fixture (${label}): a second memory linked to the first for the cascade.`,
      kind: 'fact',
      scope: 'personal',
    });
    expect(first.isError ?? false).toBe(false);
    expect(second.isError ?? false).toBe(false);
    return [
      firstJson<{ memory_id: string }>(first).memory_id,
      firstJson<{ memory_id: string }>(second).memory_id,
    ];
  } finally {
    await mcp.close();
  }
};

test.describe('account lifecycle: hard_delete_user', () => {
  test('erases every mapped row for the user and is idempotent', async () => {
    const db = admin();

    // The account this test erases.
    const departing = await provisionFreshUser(db, 'account-erase@zm.e2e');
    const userId = departing.userId;
    // Seed the memory graph through the real tool so scope/owner are authentic.
    const memoryIds = await rememberTwo(departing.user, 'departing');
    const [m1, m2] = memoryIds;

    // Resolve a real (ltree) scope to reuse for owned rows.
    const { data: mem } = await db
      .from('memories')
      .select('scope')
      .eq('id', m1)
      .single();
    const scope = mem!.scope as string;

    // Seed one row per disposition beyond the memories themselves.
    const { data: ent } = await db
      .from('entities')
      .insert({ name: 'e2e-erase-entity', scope, created_by: userId })
      .select('id')
      .single();
    const entityId = ent!.id as string;
    await insertOrThrow(db, 'memory_entities', {
      memory_id: m1,
      entity_id: entityId,
    });
    await insertOrThrow(db, 'memory_links', { src: m1, dst: m2 });
    await insertOrThrow(db, 'memory_reinforcement', {
      memory_id: m1,
      multiplier: 1.5,
    });
    // An overflow embedding window: what a memory too long for the model's
    // input window carries so its later paragraphs stay searchable.
    await insertOrThrow(db, 'memory_chunks', {
      memory_id: m1,
      ord: 0,
      embedding: JSON.stringify(Array.from({ length: 1024 }, () => 0)),
    });
    await insertOrThrow(db, 'rule_candidates', {
      memory_id: m1,
      useful_sessions: 1,
      window_days: 7,
    });
    const { data: candidate } = await db
      .from('reflection_candidates')
      .insert({ owner_id: userId, scope })
      .select('id')
      .single();
    await insertOrThrow(db, 'reflection_candidate_members', {
      candidate_id: (candidate as { id: string }).id,
      memory_id: m2,
      ord: 0,
    });
    const { data: probe } = await db
      .from('roi_probes')
      .insert({
        owner_id: userId,
        question: 'e2e erase probe?',
        source_memory_id: m1,
      })
      .select('id')
      .single();
    await insertOrThrow(db, 'roi_results', {
      // `run_id` groups a benchmark run and has no parent row to borrow from;
      // any well-formed entity id of the run prefix identifies this fixture.
      run_id: 'rrn_e2eerasezzzz1234.0000000000',
      probe_id: (probe as { id: string }).id,
      owner_id: userId,
      with_memory: true,
      without_memory: false,
    });
    await insertOrThrow(db, 'brief_probes', {
      owner_id: userId,
      topic: 'e2e erasure fixture',
      memory_id: m1,
      expect: 'present',
    });
    await insertOrThrow(db, 'session_threads', {
      owner_id: userId,
      conversation_id: 'e2e-erasure-thread',
      scope_path: scope,
    });
    await insertOrThrow(db, 'project_bindings', {
      match_kind: 'path',
      match_key: '/home/e2e/account-erasure-fixture',
      scope,
      created_by: userId,
    });
    // A SHARED scope, not the personal one the memories above landed in:
    // membership of `user.<uid>` is implicit and deliberately never stored, so
    // seeding scope_members means granting a role on a project scope.
    const sharedScope = 'proj.e2e_erase';
    await insertOrThrow(db, 'scopes', {
      scope: sharedScope,
      alias: 'e2e erase',
      created_by: userId,
    });
    await insertOrThrow(db, 'scope_members', {
      scope: sharedScope,
      user_id: userId,
      role: 'admin',
    });
    await insertOrThrow(db, 'usage_daily', {
      day: '2026-07-20',
      user_id: userId,
    });
    await insertOrThrow(db, 'policy_allowances', {
      subject_id: userId,
      budget_id: 'e2e-erase',
    });
    await insertOrThrow(db, 'ingest_log', {
      chunk_hash: 'e2e-erase-hash',
      client: 'e2e',
      user_id: userId,
    });
    await insertOrThrow(db, 'audit_log', {
      command: 'e2e.erase.marker',
      outcome: 'ok',
      occurred_at: '2026-07-20T00:00:00Z',
      actor_id: userId,
    });

    // A second entity so the graph edge is a real relation, not a self-loop.
    const { data: ent2 } = await db
      .from('entities')
      .insert({ name: 'e2e-erase-entity-b', scope, created_by: userId })
      .select('id')
      .single();
    await insertOrThrow(db, 'edges', {
      src: entityId,
      dst: (ent2 as { id: string }).id,
      type: 'relates_to',
      scope,
      created_by: userId,
      source_memory: m1,
    });
    await insertOrThrow(db, 'memory_verification', {
      memory_id: m1,
      verdict: 'current',
    });
    await insertOrThrow(db, 'portability_candidates', {
      owner_id: userId,
      memory_id: m2,
      from_scope: 'proj.e2e_erase',
      to_scope: `user.${userId.replace('.', '_')}.core`,
    });
    // The queue stores the pair in canonical order (memory_a < memory_b); the
    // table's own check constraint rejects any other arrangement.
    const [pairA, pairB] = [m1, m2].sort();
    await insertOrThrow(db, 'memory_review_queue', {
      memory_a: pairA,
      memory_b: pairB,
      verdict: 'duplicate',
    });
    await insertOrThrow(db, 'loop_closure_checks', {
      loop_id: m1,
      last_evidence_id: m2,
    });
    await insertOrThrow(db, 'memory_judge_checks', {
      memory_id: m1,
      judge_model: 'e2e-judge',
    });

    // Excluded tables are not user data and erasure must leave them alone —
    // but "left alone" asserted over an EMPTY table is exactly as vacuous as a
    // zero-sweep over one, so each gets a marker row that has to still be there
    // afterwards. Keyed and inserted only when absent, because these rows
    // survive the test by design and a repeat run must reuse the marker rather
    // than collide with it. Insert-if-absent rather than upsert: eval_runs is
    // append-only (the service role is granted select and insert, nothing
    // else), so an upsert is refused outright.
    const excludedMarkers: Record<
      string,
      {
        readonly key: Record<string, string>;
        readonly row: Record<string, unknown>;
      }
    > = {
      oauth_clients: {
        key: { client_id: 'oac_e2eerasezzzz1234.0000000000' },
        row: {
          client_id: 'oac_e2eerasezzzz1234.0000000000',
          client_name: 'e2e erasure marker',
          redirect_uris: ['https://e2e.invalid/callback'],
        },
      },
      ranking_config: {
        key: { kind: 'e2e-erase-untouched' },
        row: { kind: 'e2e-erase-untouched', weight: 1, half_life_days: 365 },
      },
      // Single-row table: its one config row exists from the migration and IS
      // the marker — the insert branch never fires.
      fusion_config: {
        key: { single_row: 'true' },
        row: { single_row: true },
      },
      eval_runs: {
        key: { id: 'evl_e2eerasezzzz1234.0000000000' },
        row: {
          id: 'evl_e2eerasezzzz1234.0000000000',
          harness: 'roi',
          metrics: {},
          corpus_size: 0,
        },
      },
    };
    expect(
      Object.keys(excludedMarkers).sort(),
      'every excluded table needs a marker row, or "erasure left it alone" is ' +
        'a claim about an empty table'
    ).toEqual(
      excludedTables()
        .map((e) => e.table)
        .sort()
    );
    for (const [table, marker] of Object.entries(excludedMarkers)) {
      const { count, error: probeError } = await db
        .from(table)
        .select('*', { count: 'exact', head: true })
        .match(marker.key);
      if (probeError) {
        throw new Error(`probe excluded ${table}: ${probeError.message}`);
      }
      if ((count ?? 0) > 0) {
        continue;
      }
      const { error } = await db.from(table).insert(marker.row);
      if (error) {
        throw new Error(`seed excluded ${table}: ${error.message}`);
      }
    }

    // ---- The cross-user half of erasure.
    //
    // Rows owned by ANOTHER user that merely NAME the departing one — who
    // resolved this review, who granted that membership — must SURVIVE with the
    // reference severed. Both ways of getting it wrong are silent without a
    // second account in the fixture: deleting the row erases a second person's
    // data along with the first, and leaving the reference intact aborts the
    // final profile delete on a NO ACTION foreign key.
    const survivor = await provisionFreshUser(
      db,
      'account-erase-survivor@zm.e2e'
    );
    const survivorId = survivor.userId;
    const [b1, b2] = await rememberTwo(survivor.user, 'survivor');
    const { data: survivorMem } = await db
      .from('memories')
      .select('scope')
      .eq('id', b1)
      .single();
    const survivorScope = survivorMem!.scope as string;
    const seedSurvivorEntity = async (name: string): Promise<string> => {
      const { data, error } = await db
        .from('entities')
        .insert({ name, scope: survivorScope, created_by: survivorId })
        .select('id')
        .single();
      if (error) {
        throw new Error(`seed survivor entity: ${error.message}`);
      }
      return (data as { id: string }).id;
    };
    const survivorEntityA = await seedSurvivorEntity('e2e-survivor-entity-a');
    const survivorEntityB = await seedSurvivorEntity('e2e-survivor-entity-b');
    const survivorPairA = b1 < b2 ? b1 : b2;
    const survivorPairB = b1 < b2 ? b2 : b1;

    await updateOrThrow(
      db,
      'memories',
      { invalidated_by: userId, invalidated_at: '2026-07-20T00:00:00Z' },
      { id: b1 }
    );
    await updateOrThrow(db, 'memories', { superseded_by: m1 }, { id: b2 });
    await insertOrThrow(db, 'edges', {
      src: survivorEntityA,
      dst: survivorEntityB,
      type: 'relates_to',
      scope: survivorScope,
      created_by: survivorId,
      // Points at a memory of the DEPARTING user. This edge survives only
      // because the sever runs before the delete that ALSO matches on
      // source_memory — reorder those two and this row disappears.
      source_memory: m1,
    });
    await insertOrThrow(db, 'memory_review_queue', {
      memory_a: survivorPairA,
      memory_b: survivorPairB,
      verdict: 'duplicate',
      status: 'resolved',
      resolution: 'keep_both',
      resolved_by: userId,
    });
    await insertOrThrow(db, 'reflection_candidates', {
      owner_id: survivorId,
      scope: survivorScope,
      status: 'approved',
      resolved_by: userId,
      approved_memory_id: m1,
    });
    await insertOrThrow(db, 'rule_candidates', {
      memory_id: b1,
      useful_sessions: 1,
      window_days: 7,
      status: 'dismissed',
      resolved_by: userId,
    });
    await insertOrThrow(db, 'portability_candidates', {
      owner_id: survivorId,
      memory_id: b2,
      from_scope: 'proj.e2e_erase',
      to_scope: `user.${survivorId.replace('.', '_')}.core`,
      status: 'dismissed',
      resolved_by: userId,
    });
    await insertOrThrow(db, 'scope_members', {
      scope: sharedScope,
      user_id: survivorId,
      role: 'reader',
      granted_by: userId,
    });

    // Declared, not hand-listed: every back-reference packages/db enumerates is
    // either probed above or carries a recorded reason it cannot arise on a
    // surviving row. A new one fails here until someone decides which it is.
    const unreachableBackRefs: Partial<Record<string, string>> = {
      'memories.shared_by':
        'sharing is owner-only, so shared_by always equals owner_id: no ' +
        'survivor row can name another user there, and nulling it on a row ' +
        'still marked shared would trip the shared-lifecycle check',
      'memory_review_queue.winner':
        'the winner must be one of the pair, so a winner owned by the ' +
        'departing user means the pair is theirs too and the row is deleted ' +
        'with them rather than severed',
    };
    const backRefProbes: ReadonlyArray<{
      readonly table: string;
      readonly column: string;
      readonly match: Record<string, string>;
    }> = [
      { table: 'memories', column: 'invalidated_by', match: { id: b1 } },
      { table: 'memories', column: 'superseded_by', match: { id: b2 } },
      {
        table: 'edges',
        column: 'source_memory',
        match: { src: survivorEntityA, dst: survivorEntityB },
      },
      {
        table: 'memory_review_queue',
        column: 'resolved_by',
        match: { memory_a: survivorPairA, memory_b: survivorPairB },
      },
      {
        table: 'reflection_candidates',
        column: 'resolved_by',
        match: { owner_id: survivorId },
      },
      {
        table: 'reflection_candidates',
        column: 'approved_memory_id',
        match: { owner_id: survivorId },
      },
      {
        table: 'rule_candidates',
        column: 'resolved_by',
        match: { memory_id: b1 },
      },
      {
        table: 'portability_candidates',
        column: 'resolved_by',
        match: { owner_id: survivorId },
      },
      {
        table: 'scope_members',
        column: 'granted_by',
        match: { scope: sharedScope, user_id: survivorId },
      },
    ];
    expect(
      [
        ...backRefProbes.map((p) => `${p.table}.${p.column}`),
        ...Object.keys(unreachableBackRefs),
      ].sort(),
      'every declared user back-reference needs a survivor probe or a ' +
        'recorded reason it cannot occur on a surviving row'
    ).toEqual(USER_BACK_REFERENCES.map((r) => `${r.table}.${r.column}`).sort());
    // Anti-vacuity once more: severed-to-null proves nothing unless the
    // reference was really set first.
    for (const probe of backRefProbes) {
      const { data, error } = await db
        .from(probe.table)
        .select(probe.column)
        .match(probe.match)
        .single();
      expect(error, `probe fixture ${probe.table}.${probe.column}`).toBeNull();
      // The column is chosen at runtime, so PostgREST cannot type the row.
      const row = data as unknown as Record<string, unknown>;
      expect(
        row[probe.column],
        `${probe.table}.${probe.column} fixture did not take`
      ).not.toBeNull();
    }

    // Pre-assertion: every table the completeness check will sweep must really
    // hold a row first, or its later zero proves nothing. This is the guard the
    // map-driven sweep alone does not give: an unseeded table passes the sweep
    // VACUOUSLY, which is exactly how two tables once reached live unerased —
    // they were absent from the map, and once added they would still have been
    // swept over empty. A table added to the map from now on fails here until
    // someone either seeds it or records why it cannot be seeded.
    const unseedable: Partial<Record<string, string>> = {
      // Written only by the OAuth authorization endpoint, and consumed (deleted)
      // on redemption; a hand-seeded row would not resemble a real one.
      oauth_codes:
        'issued and consumed by the OAuth flow, not seedable inertly',
      // Rows appear only when a live provider key is installed for the account.
      provider_credentials: 'requires a real installed provider credential',
    };
    for (const table of userDataTables()) {
      const reason = unseedable[table];
      const before = await countForUser(
        db,
        table,
        ACCOUNT_OWNERSHIP_MAP[table],
        userId,
        memoryIds
      );
      if (reason !== undefined) {
        expect(
          before,
          `${table} is declared unseedable (${reason}) but holds rows — ` +
            'remove it from the exemption list and assert it properly'
        ).toBe(0);
        continue;
      }
      expect(
        before,
        `expected seeded rows in ${table} — a mapped table with no fixture is ` +
          'swept vacuously, so erasure of it is never actually proven'
      ).toBeGreaterThan(0);
    }

    // Erase.
    const { data: result, error: rpcError } = await db.rpc('hard_delete_user', {
      p_user_id: userId,
    });
    expect(rpcError).toBeNull();
    const summary = result as { auth_deleted: boolean; memories: number };
    expect(summary.auth_deleted).toBe(true);
    expect(summary.memories).toBeGreaterThanOrEqual(2);

    // Completeness: every table the map counts as user data holds zero rows for
    // the user (owned + transitive deleted, anonymize severed).
    for (const table of userDataTables()) {
      const remaining = await countForUser(
        db,
        table,
        ACCOUNT_OWNERSHIP_MAP[table],
        userId,
        memoryIds
      );
      expect(remaining, `expected zero user rows left in ${table}`).toBe(0);
    }

    // The other user's rows are still here, with every reference to the erased
    // account severed rather than the row carried off with it.
    for (const probe of backRefProbes) {
      const { data, error } = await db
        .from(probe.table)
        .select(probe.column)
        .match(probe.match)
        .maybeSingle();
      expect(error, `${probe.table} after erasure`).toBeNull();
      const row = data as unknown as Record<string, unknown> | null;
      expect(
        row,
        `a ${probe.table} row belonging to the surviving user was deleted ` +
          'along with the departing one'
      ).not.toBeNull();
      expect(
        row![probe.column],
        `${probe.table}.${probe.column} still points at the erased user`
      ).toBeNull();
    }

    // Excluded tables are not user data: erasure leaves them as it found them.
    for (const [table, marker] of Object.entries(excludedMarkers)) {
      const { count, error } = await db
        .from(table)
        .select('*', { count: 'exact', head: true })
        .match(marker.key);
      expect(error, `excluded ${table} after erasure`).toBeNull();
      expect(
        count,
        `${table} is excluded from erasure but its marker row is gone`
      ).toBe(1);
    }

    // The auth principal is gone.
    const { data: gone } = await db.auth.admin.getUserById(departing.user.id);
    expect(gone.user).toBeNull();

    // Idempotent: a second call finds nothing and says so, without erroring.
    const { data: again, error: againError } = await db.rpc(
      'hard_delete_user',
      {
        p_user_id: userId,
      }
    );
    expect(againError).toBeNull();
    expect((again as { auth_deleted: boolean }).auth_deleted).toBe(false);

    // Leave the stand as we found it: the second account exists only to prove
    // the severing, and its memories would otherwise pile up run after run.
    await db.rpc('hard_delete_user', { p_user_id: survivorId });
  });
});
