/**
 * A promoted rule follows its memory.
 *
 * A rule is promoted FROM a memory, and memories get replaced: a writer
 * supersedes an outdated one, a reviewer resolves a conflict, hygiene folds a
 * duplicate. The rule must move to the successor on every such path, without
 * losing anything the owner decided about it: the pin, the layer, the
 * delivery address, its place in the delivery TTL and, above all, a curated
 * text. Where the move would cost any of that, the rule stays where it is and
 * stays promoted. These specs pin that down at the database, the way every
 * path reaches it.
 */
import { spawn, spawnSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { admin, asUser, projectScope } from '../helpers/board-store.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { seedOwnedMemory } from '../helpers/rules.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface RuleRow {
  id: string;
  memory_id: string;
  status: string;
  rule_text: string | null;
  target_layer: string;
  applies_scope: string | null;
  pinned: boolean;
  promoted_at: string | null;
  carried_from: string | null;
  carried_at: string | null;
  text_review_since: string | null;
}

const RULE_COLUMNS =
  'id, memory_id, status, rule_text, target_layer, applies_scope, pinned, promoted_at, carried_from, carried_at, text_review_since';

/** A marker unique to one test attempt, so a retry never dedups into the last. */
const fresh = (): string =>
  `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

/** Rule rows this spec created, deleted at the end so briefings stay clean. */
const createdRules: string[] = [];

interface RuleFateReport {
  memory_id: string;
  outcome: string;
  successor_id: string;
  note: string;
}

interface RememberReply {
  memory_id: string;
  deduplicated?: boolean;
  rules?: RuleFateReport[];
}

const rememberReply = async (
  token: string,
  content: string,
  extra: Record<string, unknown> = {}
): Promise<RememberReply> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const write = await mcp.callTool('remember', {
      content,
      kind: 'convention',
      scope: 'personal',
      ...extra,
    });
    expect(write.isError ?? false).toBe(false);
    return firstJson<RememberReply>(write);
  } finally {
    await mcp.close();
  }
};

const remember = async (
  token: string,
  content: string,
  extra: Record<string, unknown> = {}
): Promise<string> => (await rememberReply(token, content, extra)).memory_id;

/** A promoted rule on `memoryId`, as the service role writes one. */
const promote = async (
  memoryId: string,
  fields: Partial<Omit<RuleRow, 'id' | 'memory_id'>> & {
    rule_text: string;
  }
): Promise<RuleRow> => {
  const { data, error } = await admin()
    .from('rule_candidates')
    .insert({
      memory_id: memoryId,
      status: 'promoted',
      resolution: 'promoted',
      promoted_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      target_layer: 'user',
      useful_sessions: 0,
      window_days: 0,
      ...fields,
    })
    .select(RULE_COLUMNS)
    .single();
  expect(error).toBeNull();
  createdRules.push((data as RuleRow).id);
  return data as RuleRow;
};

const ruleOn = async (memoryId: string): Promise<RuleRow | null> => {
  const { data } = await admin()
    .from('rule_candidates')
    .select(RULE_COLUMNS)
    .eq('memory_id', memoryId)
    .maybeSingle();
  return (data as RuleRow | null) ?? null;
};

const ruleById = async (id: string): Promise<RuleRow> => {
  const { data } = await admin()
    .from('rule_candidates')
    .select(RULE_COLUMNS)
    .eq('id', id)
    .single();
  return data as RuleRow;
};

/** Retire `loserId` in favour of `winnerId`, the way review and hygiene do. */
const supersedeDirectly = async (
  loserId: string,
  winnerId: string
): Promise<void> => {
  const { error } = await admin()
    .from('memories')
    .update({
      superseded_by: winnerId,
      invalidated_at: new Date().toISOString(),
      invalidated_by_agent: 'e2e',
    })
    .eq('id', loserId);
  expect(error).toBeNull();
};

const briefedTexts = async (token: string): Promise<string[]> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const briefed = await mcp.callTool('build_context', {
      topic: 'anything at all',
      briefing: true,
    });
    expect(briefed.isError ?? false).toBe(false);
    return firstJson<{ rules: { text: string }[] }>(briefed).rules.map(
      (rule) => rule.text
    );
  } finally {
    await mcp.close();
  }
};

test.afterAll(async () => {
  if (createdRules.length > 0) {
    await admin().from('rule_candidates').delete().in('id', createdRules);
  }
});

test.describe('A promoted rule follows its memory', () => {
  test('a promoted rule can never carry a revoke', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const memoryId = await remember(
      token,
      `rule-follows ${run}: a promoted row with a revoke is refused`
    );
    const rule = await promote(memoryId, { rule_text: 'refused marker' });

    const { error } = await admin()
      .from('rule_candidates')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', rule.id);
    expect(error?.code).toBe('23514');

    // Revoking the way /rules does it is still fine.
    const revoked = await admin()
      .from('rule_candidates')
      .update({
        status: 'revoked',
        resolution: 'revoked',
        revoked_at: new Date().toISOString(),
        revoke_reason: 'e2e',
      })
      .eq('id', rule.id);
    expect(revoked.error).toBeNull();
  });

  test('a rule that is its memory text moves to the successor and takes its text', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const oldText = `rule-follows ${run}: always run the e2e suite before a merge`;
    const newText = `rule-follows ${run}: always run the full e2e suite before any squash`;
    const oldId = await remember(token, oldText);

    // The dashboard promote: the rule text is the memory's own text.
    const promoted = await asUser(token).rpc('promote_memory_to_rule', {
      p_memory_id: oldId,
    });
    expect(promoted.error).toBeNull();
    const before = (await ruleOn(oldId))!;
    createdRules.push(before.id);
    await admin()
      .from('rule_candidates')
      .update({ pinned: true })
      .eq('id', before.id);

    const reply = await rememberReply(token, newText, {
      links: [{ type: 'supersedes', dst: oldId }],
    });
    const newId = reply.memory_id;
    // The writer hears what happened to the rule.
    expect(reply.rules).toEqual([
      expect.objectContaining({
        memory_id: oldId,
        successor_id: newId,
        outcome: 'carried',
      }),
    ]);

    expect(await ruleOn(oldId)).toBeNull();
    const after = await ruleById(before.id);
    expect(after.memory_id).toBe(newId);
    expect(after.rule_text).toBe(newText);
    expect(after.status).toBe('promoted');
    expect(after.pinned).toBe(true);
    expect(after.target_layer).toBe(before.target_layer);
    expect(after.promoted_at).toBe(before.promoted_at);
    expect(after.carried_from).toBe(oldId);
    expect(after.carried_at).not.toBeNull();
    expect(after.text_review_since).toBeNull();

    const texts = await briefedTexts(token);
    expect(texts).toContain(newText);
    expect(texts).not.toContain(oldText);
  });

  test('a curated rule moves but keeps its text, flagged for review', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const curated = `Curated ${run}: squash feature branches, never merge them.`;
    const oldId = await remember(
      token,
      `rule-follows ${run}: the owner prefers squash landings over merge commits`
    );
    const rule = await promote(oldId, { rule_text: curated });

    const newText = `rule-follows ${run}: the owner lands every epic as one squash commit`;
    const reply = await rememberReply(token, newText, {
      links: [{ type: 'supersedes', dst: oldId }],
    });
    const newId = reply.memory_id;
    expect(reply.rules).toEqual([
      expect.objectContaining({
        memory_id: oldId,
        outcome: 'carried_text_kept',
        note: expect.stringContaining(`promote_rule(memory_id: "${newId}"`),
      }),
    ]);

    const after = await ruleById(rule.id);
    expect(after.memory_id).toBe(newId);
    expect(after.rule_text).toBe(curated);
    expect(after.text_review_since).not.toBeNull();
    expect(await briefedTexts(token)).toContain(curated);

    // Setting the text again clears the review flag.
    const repromoted = await asUser(token).rpc('promote_memory_to_rule', {
      p_memory_id: newId,
    });
    expect(repromoted.error).toBeNull();
    const reviewed = await ruleById(rule.id);
    expect(reviewed.text_review_since).toBeNull();
    expect(reviewed.rule_text).toBe(newText);
  });

  test('a project rule keeps its address when the successor lives elsewhere', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const markers: string[] = [];
    const project = await projectScope(token, `rule-follows-${run}`, markers);
    const oldId = await remember(
      token,
      `rule-follows ${run}: this project deploys only from tagged builds`,
      { scope: project }
    );
    const rule = await promote(oldId, {
      rule_text: `rule-follows ${run}: deploy only tagged builds`,
      target_layer: 'project',
    });
    expect(rule.applies_scope).toBeNull();

    const newId = await remember(
      token,
      `rule-follows ${run}: deploys go out only from signed, tagged builds`,
      { links: [{ type: 'supersedes', dst: oldId }] }
    );

    const after = await ruleById(rule.id);
    expect(after.memory_id).toBe(newId);
    expect(after.target_layer).toBe('project');
    expect(after.applies_scope).toBe(project);
    // The curated text was kept, so the reply points at promote_rule to set
    // it again — and doing exactly that must not undo the kept address.
    expect(after.text_review_since).not.toBeNull();

    const mcp = await McpTestClient.connect(token);
    try {
      const corrected = await mcp.callTool('promote_rule', {
        memory_id: newId,
        rule_text: `rule-follows ${run}: deploy only signed, tagged builds`,
      });
      expect(corrected.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
    const reviewed = await ruleById(rule.id);
    expect(reviewed.target_layer).toBe('project');
    expect(reviewed.applies_scope).toBe(project);
    expect(reviewed.text_review_since).toBeNull();
    expect(reviewed.rule_text).toBe(
      `rule-follows ${run}: deploy only signed, tagged builds`
    );

    // The dashboard's re-promote keeps it too.
    const repromoted = await asUser(token).rpc('promote_memory_to_rule', {
      p_memory_id: newId,
    });
    expect(repromoted.error).toBeNull();
    expect((await ruleById(rule.id)).applies_scope).toBe(project);
  });

  test('a successor that already has a rule of its own does not take this one', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const oldId = await remember(
      token,
      `rule-follows ${run}: keep migrations forward-only`
    );
    const winnerId = await remember(
      token,
      `rule-follows ${run}: applied migrations are never edited`
    );
    const oldRule = await promote(oldId, {
      rule_text: `rule-follows ${run}: migrations are forward-only`,
    });
    const winnerRule = await promote(winnerId, {
      rule_text: `rule-follows ${run}: never edit an applied migration`,
    });

    await supersedeDirectly(oldId, winnerId);

    expect((await ruleById(oldRule.id)).memory_id).toBe(oldId);
    expect((await ruleById(winnerRule.id)).memory_id).toBe(winnerId);
    // Nothing is lost: the rule that stayed behind is still delivered.
    const texts = await briefedTexts(token);
    expect(texts).toContain(oldRule.rule_text);
    expect(texts).toContain(winnerRule.rule_text);
  });

  test('a rule never moves to another owner, and a closed loop keeps its rule', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const tokenB = await passwordGrantToken(seed.userB);
    const tokenA = await passwordGrantToken(seed.userA);

    const mineId = await remember(
      tokenB,
      `rule-follows ${run}: my rule stays mine`
    );
    const foreignId = await remember(
      tokenA,
      `rule-follows ${run}: somebody else's memory`
    );
    const mine = await promote(mineId, {
      rule_text: `rule-follows ${run}: my rule stays mine`,
    });
    await supersedeDirectly(mineId, foreignId);
    expect((await ruleById(mine.id)).memory_id).toBe(mineId);
    expect(await ruleOn(foreignId)).toBeNull();

    const loopId = await remember(
      tokenB,
      `rule-follows ${run}: TASK re-run the benchmark next week`,
      { kind: 'task' }
    );
    const evidenceId = await remember(
      tokenB,
      `rule-follows ${run}: the benchmark was re-run and is green`
    );
    const loopRule = await promote(loopId, {
      rule_text: `rule-follows ${run}: re-run the benchmark weekly`,
    });
    await supersedeDirectly(loopId, evidenceId);
    expect((await ruleById(loopRule.id)).memory_id).toBe(loopId);
  });

  test('an unreviewed proposal on the successor gives way to the promoted rule', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const oldId = await remember(
      token,
      `rule-follows ${run}: prefer bun for every script`
    );
    const winnerId = await remember(
      token,
      `rule-follows ${run}: bun runs every script in this repo`
    );
    const rule = await promote(oldId, {
      rule_text: `rule-follows ${run}: prefer bun for every script`,
    });
    const { data: proposal } = await admin()
      .from('rule_candidates')
      .insert({
        memory_id: winnerId,
        status: 'pending',
        rule_text: 'a draft nobody reviewed',
        target_layer: 'user',
        useful_sessions: 3,
        window_days: 14,
      })
      .select('id')
      .single();
    createdRules.push((proposal as { id: string }).id);

    await supersedeDirectly(oldId, winnerId);

    const after = await ruleById(rule.id);
    expect(after.memory_id).toBe(winnerId);
    expect(after.status).toBe('promoted');
    const { data: gone } = await admin()
      .from('rule_candidates')
      .select('id')
      .eq('id', (proposal as { id: string }).id);
    expect(gone).toEqual([]);
  });

  test("a rule that is its memory's text follows that text when it changes", async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const text = `rule-follows ${run}: write commit subjects in English`;
    const verbatimId = await remember(token, text);
    const verbatim = await promote(verbatimId, { rule_text: text });
    const curatedId = await remember(
      token,
      `rule-follows ${run}: commit subjects are one line`
    );
    const curated = await promote(curatedId, {
      rule_text: 'Curated: one-line commit subjects.',
    });

    // The background canonicalization rewrites a memory's content in place.
    const rewritten = `rule-follows ${run}: every commit subject is written in English`;
    await admin()
      .from('memories')
      .update({ content: rewritten })
      .eq('id', verbatimId);
    await admin()
      .from('memories')
      .update({ content: `rule-follows ${run}: subjects stay on one line` })
      .eq('id', curatedId);

    expect((await ruleById(verbatim.id)).rule_text).toBe(rewritten);
    expect((await ruleById(curated.id)).rule_text).toBe(
      'Curated: one-line commit subjects.'
    );
  });
});

/** SQL as the database owner on the test contour, the statements in one go. */
const sqlArgs = (statement: string): string[] => [
  'exec',
  '-i',
  'supabase_db_zero-memory-e2e',
  'psql',
  '-U',
  'postgres',
  '-d',
  'postgres',
  '-v',
  'ON_ERROR_STOP=1',
  '-Atc',
  statement,
];

/** Runs `statement` in the background; resolves with its exit status. */
const sqlInBackground = (
  statement: string
): Promise<{ status: number | null; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn('docker', sqlArgs(statement));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });

const sqlNow = (statement: string): string => {
  const result = spawnSync('docker', sqlArgs(statement), { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`psql: ${result.stderr}`);
  }
  return result.stdout.trim();
};

/** Polls `probe` until it holds, or fails the test after 20 s. */
const until = async (what: string, probe: () => boolean): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (probe()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Whether a backend running a statement tagged `marker` waits as `where`. */
const waiting = (marker: string, where: string): boolean =>
  sqlNow(
    `select count(*) from pg_stat_activity where ${where} ` +
      `and query like '%${marker}%' and pid <> pg_backend_pid()`
  ) === '1';

/**
 * A barrier the test controls: a session holding an advisory lock that a
 * transaction under test takes right after the statements it must hold,
 * so that transaction stays open, uncommitted, for exactly as long as the
 * test needs — no timed sleeps. `release` ends the holding session.
 */
const barrier = async (tag: string) => {
  const key = Math.floor(Math.random() * 2_000_000_000);
  const marker = `gate-${tag}`;
  const holder = sqlInBackground(
    `/* ${marker} */ select pg_advisory_lock(${key}); select pg_sleep(60);`
  );
  await until(`${marker} to hold its lock`, () =>
    waiting(marker, "wait_event = 'PgSleep'")
  );
  return {
    /** The statement a transaction runs to wait at the barrier. */
    wait: `select pg_advisory_xact_lock(${key});`,
    release: async (): Promise<void> => {
      sqlNow(
        `select pg_terminate_backend(pid) from pg_stat_activity ` +
          `where query like '%${marker}%' and pid <> pg_backend_pid()`
      );
      await holder;
    },
  };
};

/** Resolves once `promise` settled, so its state can be polled. */
const settled = (promise: Promise<unknown>) => {
  const state = { done: false };
  void promise.finally(() => {
    state.done = true;
  });
  return state;
};

test.describe('Delivery and concurrency', () => {
  test("newer rules of other projects never crowd a project's rule out of its briefing", async () => {
    const run = fresh();
    // A user of its own: the crowd below is over a thousand promoted rules.
    const user = await provisionE2EUser(`e2e-rule-crowd-${run}@zm.e2e`);
    const token = await passwordGrantToken(user);
    const markers: string[] = [];
    const project = await projectScope(token, `rule-crowd-${run}`, markers);

    const ownId = await seedOwnedMemory(user, `rule-crowd ${run}: own anchor`);
    const ownText = `rule-crowd ${run}: the rule of this project`;
    await promote(ownId, {
      rule_text: ownText,
      target_layer: 'project',
      applies_scope: project,
      promoted_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });

    // More, and newer, rules for another project than one PostgREST response
    // carries (its max-rows cap is 1000): a reader that reads a single page
    // before filtering by project never sees this project's rule.
    const { data: profile } = await admin()
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();
    const ownerId = (profile as { id: string }).id;
    const crowd = 1001;
    for (let offset = 0; offset < crowd; offset += 500) {
      const size = Math.min(500, crowd - offset);
      const { data: anchors, error } = await admin()
        .from('memories')
        .insert(
          Array.from({ length: size }, (_, i) => ({
            content: `rule-crowd ${run}: crowd anchor ${offset + i}`,
            kind: 'convention',
            scope: `user.${ownerId.replace('.', '_')}`,
            owner_id: ownerId,
          }))
        )
        .select('id');
      expect(error).toBeNull();
      const { error: rulesError } = await admin()
        .from('rule_candidates')
        .insert(
          (anchors as { id: string }[]).map((anchor, i) => ({
            memory_id: anchor.id,
            status: 'promoted',
            resolution: 'promoted',
            promoted_at: new Date().toISOString(),
            resolved_at: new Date().toISOString(),
            rule_text: `rule-crowd ${run}: crowd rule ${offset + i}`,
            target_layer: 'project',
            applies_scope: `proj.e2e_crowd_${run}`,
            useful_sessions: 0,
            window_days: 0,
          }))
        );
      expect(rulesError).toBeNull();
    }

    const mcp = await McpTestClient.connect(token);
    try {
      const briefed = await mcp.callTool('build_context', {
        topic: 'anything about this project',
        briefing: true,
        scopes: [project],
      });
      expect(briefed.isError ?? false).toBe(false);
      const texts = firstJson<{ rules: { text: string }[] }>(briefed).rules.map(
        (rule) => rule.text
      );
      expect(texts).toContain(ownText);
    } finally {
      await mcp.close();
    }
  });

  test('a rewrite of the successor that races the supersede still reaches the rule', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const oldText = `rule-race ${run}: the old words`;
    const oldId = await remember(token, oldText);
    const rule = await promote(oldId, { rule_text: oldText });
    const successorId = await remember(
      token,
      `rule-race ${run}: the successor, before its rewrite`
    );
    const rewritten = `rule-race ${run}: the successor, rewritten`;

    // One transaction rewrites the successor, as the canonicalization does,
    // and is held open at a barrier with the write uncommitted. The
    // supersede runs while it is held: it must wait for the rewrite, and the
    // rule must end on the successor with its final text.
    const gate = await barrier(`race-${run}`);
    const marker = `race-${run}`;
    const rewrite = sqlInBackground(
      `/* ${marker} */ begin; update public.memories set content = ` +
        `'${rewritten}' where id = '${successorId}'; ${gate.wait} commit;`
    );
    await until('the rewrite to wait at the barrier', () =>
      waiting(marker, "wait_event = 'advisory'")
    );
    const supersedeMarker = `race-move-${run}`;
    const supersede = sqlInBackground(
      `/* ${supersedeMarker} */ update public.memories set superseded_by = ` +
        `'${successorId}', invalidated_at = now() where id = '${oldId}';`
    );
    const supersedeState = settled(supersede);
    // It either waits on the successor's row, or (without the lock) is done.
    await until(
      'the supersede to wait on the successor or finish',
      () =>
        supersedeState.done ||
        waiting(supersedeMarker, "wait_event_type = 'Lock'")
    );
    await gate.release();
    expect((await rewrite).status).toBe(0);
    expect((await supersede).status).toBe(0);

    const after = await ruleById(rule.id);
    expect(after.memory_id).toBe(successorId);
    expect(after.rule_text).toBe(rewritten);
  });

  test('two supersedes onto one successor at once both go through', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const firstId = await remember(token, `rule-pair ${run}: the first old`);
    const secondId = await remember(token, `rule-pair ${run}: the second old`);
    const successorId = await remember(
      token,
      `rule-pair ${run}: the successor`
    );
    const first = await promote(firstId, {
      rule_text: `rule-pair ${run}: the first rule`,
    });
    const second = await promote(secondId, {
      rule_text: `rule-pair ${run}: the second rule`,
    });

    // Each supersede's foreign-key check takes a KEY SHARE lock on the
    // successor before the rule moves. Both hold one here at the same time —
    // the first is held open at a barrier with its KEY SHARE taken while the
    // second runs — and the move's own lock on the successor must not
    // conflict with them.
    const gate = await barrier(`pair-${run}`);
    const firstMarker = `pair-a-${run}`;
    const firstTx = sqlInBackground(
      `/* ${firstMarker} */ begin; select 1 from public.memories ` +
        `where id = '${successorId}' for key share; ${gate.wait} ` +
        `update public.memories set superseded_by = '${successorId}', ` +
        `invalidated_at = now() where id = '${firstId}'; commit;`
    );
    await until('the first supersede to wait at the barrier', () =>
      waiting(firstMarker, "wait_event = 'advisory'")
    );
    const secondMarker = `pair-b-${run}`;
    const secondTx = sqlInBackground(
      `/* ${secondMarker} */ begin; select 1 from public.memories ` +
        `where id = '${successorId}' for key share; update public.memories ` +
        `set superseded_by = '${successorId}', invalidated_at = now() ` +
        `where id = '${secondId}'; commit;`
    );
    const secondState = settled(secondTx);
    // It either finishes, or (with a lock that conflicts with KEY SHARE)
    // waits on the successor — the moment the two would deadlock.
    await until(
      'the second supersede to finish or wait on the successor',
      () =>
        secondState.done || waiting(secondMarker, "wait_event_type = 'Lock'")
    );
    await gate.release();
    const [a, b] = await Promise.all([firstTx, secondTx]);
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);

    // One rule moved; the other found the successor taken and stayed.
    const moved = [await ruleById(first.id), await ruleById(second.id)].filter(
      (row) => row.memory_id === successorId
    );
    expect(moved).toHaveLength(1);
  });
});

test.describe('The writer hears what happened to a rule', () => {
  test('a write absorbed into a memory that has its own rule leaves the old rule in place', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const oldId = await remember(
      token,
      `rule-follows ${run}: tests run on the e2e contour`
    );
    const oldRule = await promote(oldId, {
      rule_text: `rule-follows ${run}: run tests on the e2e contour`,
    });
    const absorbingText = `rule-follows ${run}: every test runs on the isolated e2e contour, never on live`;
    const absorbingId = await remember(token, absorbingText);
    await promote(absorbingId, { rule_text: absorbingText });

    // The same words again: the write is absorbed into the memory that
    // already has a rule, and its declared supersede still retires the old.
    const reply = await rememberReply(token, absorbingText, {
      links: [{ type: 'supersedes', dst: oldId }],
    });

    expect(reply.deduplicated).toBe(true);
    expect(reply.memory_id).toBe(absorbingId);
    expect(reply.rules).toEqual([
      expect.objectContaining({
        memory_id: oldId,
        successor_id: absorbingId,
        outcome: 'not_carried',
        note: expect.stringContaining('(promoted)'),
      }),
    ]);
    expect((await ruleById(oldRule.id)).memory_id).toBe(oldId);
    expect(await briefedTexts(token)).toContain(oldRule.rule_text);
  });

  test('forgetting a memory leaves its rule live and says so', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const memoryId = await remember(
      token,
      `rule-follows ${run}: review every migration twice`
    );
    const rule = await promote(memoryId, {
      rule_text: `rule-follows ${run}: review every migration twice`,
    });

    const mcp = await McpTestClient.connect(token);
    try {
      const forgot = await mcp.callTool('forget', { memory_id: memoryId });
      expect(forgot.isError ?? false).toBe(false);
      expect(
        firstJson<{ rule?: { outcome: string; note: string } }>(forgot).rule
      ).toEqual({
        outcome: 'kept_live',
        note: expect.stringContaining('/rules'),
      });
    } finally {
      await mcp.close();
    }

    expect((await ruleById(rule.id)).status).toBe('promoted');
    expect(await briefedTexts(token)).toContain(rule.rule_text);
  });
});

test.describe('promote_rule and a revoked rule', () => {
  test('a forced re-promote of a revoked rule reaches the next briefing', async () => {
    const run = fresh();
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const text = `rule-follows ${run}: revoked by accident, promoted again`;
    const memoryId = await remember(
      token,
      `rule-follows ${run}: a rule the owner revoked by accident`
    );
    const rule = await promote(memoryId, { rule_text: text });

    // Revoked on /rules.
    await admin()
      .from('rule_candidates')
      .update({
        status: 'revoked',
        resolution: 'revoked',
        revoked_at: new Date().toISOString(),
        revoke_reason: 'by accident',
      })
      .eq('id', rule.id);
    expect(await briefedTexts(token)).not.toContain(text);

    const mcp = await McpTestClient.connect(token);
    try {
      const promoted = await mcp.callTool('promote_rule', {
        memory_id: memoryId,
        rule_text: text,
        force: true,
      });
      expect(promoted.isError ?? false).toBe(false);
      expect(firstJson<{ status: string }>(promoted).status).toBe('promoted');
    } finally {
      await mcp.close();
    }

    const { data: row } = await admin()
      .from('rule_candidates')
      .select('status, revoked_at, revoke_reason')
      .eq('id', rule.id)
      .single();
    expect(row).toEqual({
      status: 'promoted',
      revoked_at: null,
      revoke_reason: null,
    });
    expect(await briefedTexts(token)).toContain(text);
  });
});
