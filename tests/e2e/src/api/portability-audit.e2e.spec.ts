/**
 * Portability audit (project→core re-scope proposals), LLM-free half: the
 * deterministic rollup prefilter (`find_portability_candidates`), the
 * one-candidacy claim, and the owner's resolution through the SECURITY
 * DEFINER RPC `resolve_portability_candidate` — approval re-scopes the
 * memory into the owner's core scope and both outcomes leave an audit_log
 * entry (the dataset a later pass joins against usage evidence). Exercised
 * under a real user JWT, exactly the surface the web server action uses.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** ltree label of an entity id (dots/hyphens fold to underscores). */
const scopeLabel = (entityId: string): string =>
  entityId.toLowerCase().replace(/[-.]/g, '_');

/** Domain usr_ id of a provisioned e2e user. */
const profileId = async (authUserId: string): Promise<string> => {
  const { data } = await adminClient()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  return data!.id as string;
};

/** Create an owned project-scope memory via MCP and return its id. */
const rememberProjectFact = async (
  token: string,
  content: string,
  scope: string,
  kind = 'fact'
): Promise<string> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const write = await mcp.callTool('remember', {
      content,
      kind,
      scope,
    });
    return firstJson<{ memory_id: string }>(write).memory_id;
  } finally {
    await mcp.close();
  }
};

/** Rollup rows for one owner (service-role, like the detector). */
const rollupFor = async (ownerId: string): Promise<string[]> => {
  const { data, error } = await adminClient().rpc(
    'find_portability_candidates',
    { p_owner: ownerId, p_limit: 50 }
  );
  expect(error).toBeNull();
  return ((data ?? []) as Array<{ memory_id: string }>).map(
    (row) => row.memory_id
  );
};

/** File a pending proposal the way the detector does after a judge pass. */
const fileProposal = async (
  ownerId: string,
  memoryId: string,
  fromScope: string,
  toScope: string
): Promise<string> => {
  const { data, error } = await adminClient()
    .from('portability_candidates')
    .insert({
      owner_id: ownerId,
      memory_id: memoryId,
      from_scope: fromScope,
      to_scope: toScope,
      judge_confidence: 0.91,
      judge_rationale: 'e2e: portable world fact',
      judge_model: 'e2e-judge',
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  return data!.id as string;
};

test.describe('portability audit (rollup + owner resolution)', () => {
  const seededMemories: string[] = [];

  // Later feed specs assert the seeded fixtures on page ONE of the owner's
  // feed; leaving these markers behind would push the fixtures off it.
  test.afterAll(async () => {
    if (seededMemories.length > 0) {
      await adminClient().from('memories').delete().in('id', seededMemories);
    }
  });

  test('rollup covers exactly the world-facing kinds', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const ownerId = await profileId(seed.userA.id);
    const fromScope = `proj.${scopeLabel(ownerId)}.portability_e2e`;
    const stamp = Date.now();

    // One memory per kind. gotcha belongs in: a pitfall about a public tool
    // is the class that gets rediscovered project after project. convention
    // and preference stay out — their oracle is the owner, not the world.
    const included = await Promise.all(
      (['fact', 'reference', 'gotcha'] as const).map((kind) =>
        rememberProjectFact(
          token,
          `portability kinds marker ${kind} ${stamp}: pnpm keeps its store outside the project`,
          fromScope,
          kind
        )
      )
    );
    const excluded = await Promise.all(
      (['convention', 'preference'] as const).map((kind) =>
        rememberProjectFact(
          token,
          `portability kinds marker ${kind} ${stamp}: we keep the store outside the project`,
          fromScope,
          kind
        )
      )
    );
    seededMemories.push(...included, ...excluded);

    // The SQL filter is the enforcing copy of PORTABILITY_SUBJECT_KINDS;
    // this assertion fails if the two ever drift apart.
    const candidates = await rollupFor(ownerId);
    for (const memoryId of included) {
      expect(candidates).toContain(memoryId);
    }
    for (const memoryId of excluded) {
      expect(candidates).not.toContain(memoryId);
    }
  });

  test('rollup lists a private project fact; approval re-scopes it into core and audits', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const ownerId = await profileId(seed.userA.id);
    const label = scopeLabel(ownerId);
    const fromScope = `proj.${label}.portability_e2e`;
    const toScope = `user.${label}.core`;

    const memoryId = await rememberProjectFact(
      token,
      `portability marker approve ${Date.now()}: Bun loads .env only from the cwd`,
      fromScope
    );
    seededMemories.push(memoryId);

    // The deterministic prefilter sees the live private project fact…
    expect(await rollupFor(ownerId)).toContain(memoryId);

    // …until a candidacy claims it (one candidacy per memory, ever).
    const candidateId = await fileProposal(
      ownerId,
      memoryId,
      fromScope,
      toScope
    );
    expect(await rollupFor(ownerId)).not.toContain(memoryId);

    // Owner approves under their JWT: the memory moves into core.
    const { data: resolved, error } = await userRestClient(token).rpc(
      'resolve_portability_candidate',
      { p_candidate_id: candidateId, p_approve: true }
    );
    expect(error).toBeNull();
    expect(
      (resolved as Array<{ status: string; to_scope: string }>)[0]
    ).toMatchObject({ status: 'approved', to_scope: toScope });

    const { data: memory } = await adminClient()
      .from('memories')
      .select('scope')
      .eq('id', memoryId)
      .single();
    expect(String(memory!.scope)).toBe(toScope);

    // The decision is audited with the dataset fields (from→to, confidence).
    const { data: audits } = await adminClient()
      .from('audit_log')
      .select('command, actor_id, author_kind, payload')
      .eq('command', 'portability.approve')
      .contains('payload', { memory_id: memoryId });
    expect(audits).toHaveLength(1);
    expect(audits![0]).toMatchObject({
      actor_id: ownerId,
      author_kind: 'human',
    });
    expect(audits![0]!.payload).toMatchObject({
      candidate: candidateId,
      from_scope: fromScope,
      to_scope: toScope,
      confidence: 0.91,
    });
  });

  test('dismissal is terminal, audited, and leaves the memory in place', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const ownerId = await profileId(seed.userA.id);
    const label = scopeLabel(ownerId);
    const fromScope = `proj.${label}.portability_e2e`;
    const toScope = `user.${label}.core`;

    const memoryId = await rememberProjectFact(
      token,
      `portability marker dismiss ${Date.now()}: our staging cluster lives in region X`,
      fromScope
    );
    seededMemories.push(memoryId);
    const candidateId = await fileProposal(
      ownerId,
      memoryId,
      fromScope,
      toScope
    );

    const { error } = await userRestClient(token).rpc(
      'resolve_portability_candidate',
      { p_candidate_id: candidateId, p_approve: false }
    );
    expect(error).toBeNull();

    // Memory untouched; candidacy closed; the memory never re-enters the
    // rollup (dismissals are terminal).
    const { data: memory } = await adminClient()
      .from('memories')
      .select('scope')
      .eq('id', memoryId)
      .single();
    expect(String(memory!.scope)).toBe(fromScope);
    const { data: row } = await adminClient()
      .from('portability_candidates')
      .select('status, resolution')
      .eq('id', candidateId)
      .single();
    expect(row).toMatchObject({
      status: 'dismissed',
      resolution: 'dismissed_by_owner',
    });
    expect(await rollupFor(ownerId)).not.toContain(memoryId);

    const { data: audits } = await adminClient()
      .from('audit_log')
      .select('command')
      .eq('command', 'portability.dismiss')
      .contains('payload', { memory_id: memoryId });
    expect(audits).toHaveLength(1);
  });

  test("a stranger cannot resolve someone else's proposal", async () => {
    const seed = await readSeedState();
    const ownerToken = await passwordGrantToken(seed.userA);
    const ownerId = await profileId(seed.userA.id);
    const label = scopeLabel(ownerId);
    const fromScope = `proj.${label}.portability_e2e`;

    const memoryId = await rememberProjectFact(
      ownerToken,
      `portability marker stranger ${Date.now()}: TypeScript satisfies narrows without widening`,
      fromScope
    );
    seededMemories.push(memoryId);
    const candidateId = await fileProposal(
      ownerId,
      memoryId,
      fromScope,
      `user.${label}.core`
    );

    const strangerToken = await passwordGrantToken(seed.userB);
    const { error } = await userRestClient(strangerToken).rpc(
      'resolve_portability_candidate',
      { p_candidate_id: candidateId, p_approve: true }
    );
    expect(error).not.toBeNull();

    // The proposal is still pending and the memory did not move.
    const { data: row } = await adminClient()
      .from('portability_candidates')
      .select('status')
      .eq('id', candidateId)
      .single();
    expect(row!.status).toBe('pending');
    const { data: memory } = await adminClient()
      .from('memories')
      .select('scope')
      .eq('id', memoryId)
      .single();
    expect(String(memory!.scope)).toBe(fromScope);
  });
});
