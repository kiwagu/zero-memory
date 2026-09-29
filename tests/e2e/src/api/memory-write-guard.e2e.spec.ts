/**
 * Who may change a memory once it is written.
 *
 * A shared memory is readable by every member of its scope, and a writer
 * member may retire it: that is how a team forgets a stale fact or closes a
 * loop. Nothing else about it is theirs. Its words, its scope, its visibility
 * and what replaced it stay with the owner, because a rule promoted from a
 * memory is delivered to the owner's sessions as an instruction, and it
 * follows the memory's words and its successor. Whose memory it is changes
 * for no one, the owner included: the rule would change hands with it.
 */
import { expect, test } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  admin,
  asUser,
  makeMember,
  projectScope,
} from '../helpers/board-store.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

/** Memories and rules this file writes, deleted when it is done. */
const markers: string[] = [];
const createdRules: string[] = [];

test.afterAll(async () => {
  if (createdRules.length > 0) {
    await admin().from('rule_candidates').delete().in('id', createdRules);
  }
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

interface Fixture {
  scope: string;
  memoryId: string;
  successorId: string;
  ownerId: string;
  writerId: string;
  ownerToken: string;
  writerToken: string;
}

/**
 * User A's shared memory carrying a promoted rule, a second shared memory of
 * A's that could succeed it, and user B as a writer member of their scope.
 */
const sharedRuleMemory = async (tag: string): Promise<Fixture> => {
  const seed = await readSeedState();
  const ownerToken = await passwordGrantToken(seed.userA);
  const scope = await projectScope(ownerToken, tag, markers);

  const agent = await McpTestClient.connect(ownerToken);
  const writeShared = async (content: string): Promise<string> => {
    const made = await agent.callTool('remember', {
      content,
      kind: 'convention',
      scope,
    });
    expect(made.isError ?? false).toBe(false);
    const { memory_id } = firstJson<{ memory_id: string }>(made);
    markers.push(memory_id);
    const shared = await agent.callTool('share', { memory_id, scope });
    expect(shared.isError ?? false).toBe(false);
    return memory_id;
  };
  let memoryId: string;
  let successorId: string;
  try {
    memoryId = await writeShared(
      `e2e write guard ${tag}: pin the relay firmware before every rollout`
    );
    successorId = await writeShared(
      `e2e write guard ${tag}: the staging relay reboots nightly at 03:00`
    );
  } finally {
    await agent.close();
  }

  const promoted = await asUser(ownerToken).rpc('promote_memory_to_rule', {
    p_memory_id: memoryId,
  });
  expect(promoted.error).toBeNull();
  createdRules.push(
    (promoted.data as { candidate_id: string }[])[0]!.candidate_id
  );

  const { data: owner } = await admin()
    .from('memories')
    .select('owner_id')
    .eq('id', memoryId)
    .single();
  const writerId = await makeMember(scope, seed.userB.id, 'writer');
  return {
    scope,
    memoryId,
    successorId,
    ownerId: (owner as { owner_id: string }).owner_id,
    writerId,
    ownerToken,
    writerToken: await passwordGrantToken(seed.userB),
  };
};

const MEMORY_COLUMNS =
  'owner_id, content, scope, visibility, superseded_by, invalidated_at, invalidated_by';

const memoryRow = async (id: string): Promise<Record<string, unknown>> => {
  const { data, error } = await admin()
    .from('memories')
    .select(MEMORY_COLUMNS)
    .eq('id', id)
    .single();
  expect(error).toBeNull();
  return data as Record<string, unknown>;
};

const ruleOf = async (
  candidateId: string
): Promise<{ memory_id: string; rule_text: string; status: string }> => {
  const { data, error } = await admin()
    .from('rule_candidates')
    .select('memory_id, rule_text, status')
    .eq('id', candidateId)
    .single();
  expect(error).toBeNull();
  return data as { memory_id: string; rule_text: string; status: string };
};

/** A PATCH through the API as the given caller; answers its error code. */
const patch = async (
  client: SupabaseClient,
  id: string,
  values: Record<string, unknown>
): Promise<string | undefined> => {
  const { error } = await client.from('memories').update(values).eq('id', id);
  return error?.code;
};

test.describe('Changing a written memory', () => {
  test("a writer member can retire another member's shared memory, and change nothing else about it", async () => {
    const f = await sharedRuleMemory(`writer-${Date.now()}`);
    const candidateId = createdRules.at(-1)!;
    const memoryBefore = await memoryRow(f.memoryId);
    const ruleBefore = await ruleOf(candidateId);
    expect(memoryBefore.visibility).toBe('shared');
    expect(ruleBefore).toMatchObject({
      memory_id: f.memoryId,
      status: 'promoted',
    });

    const writer = asUser(f.writerToken);
    const refused: Record<string, unknown>[] = [
      // Its words: the rule is the memory's text and would take the new one.
      { content: 'e2e write guard: ship the relay firmware unpinned' },
      // Whose it is: the rule would become the writer's to rewrite.
      { owner_id: f.writerId },
      // What replaced it: the rule would move onto the owner's other memory.
      { superseded_by: f.successorId },
      { scope: `user.${f.writerId.replace('.', '_')}` },
      // A retirement in the owner's name, or in nobody's.
      { invalidated_at: new Date().toISOString(), invalidated_by: f.ownerId },
      { invalidated_at: new Date().toISOString() },
    ];
    for (const values of refused) {
      expect(
        await patch(writer, f.memoryId, values),
        JSON.stringify(values)
      ).toBe('42501');
    }
    expect(await memoryRow(f.memoryId)).toEqual(memoryBefore);
    expect(await ruleOf(candidateId)).toEqual(ruleBefore);

    // The one change that is the writer's: retiring it, as themselves,
    // through the tool a team member uses.
    const agent = await McpTestClient.connect(f.writerToken);
    try {
      const forgot = await agent.callTool('forget', {
        memory_id: f.memoryId,
      });
      expect(forgot.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }
    const retired = await memoryRow(f.memoryId);
    expect(retired.invalidated_at).not.toBeNull();
    expect(retired.invalidated_by).toBe(f.writerId);
  });

  test('the owner cannot hand a memory to another member', async () => {
    const f = await sharedRuleMemory(`handoff-${Date.now()}`);
    const candidateId = createdRules.at(-1)!;

    expect(
      await patch(asUser(f.ownerToken), f.memoryId, { owner_id: f.writerId })
    ).toBe('42501');
    expect((await memoryRow(f.memoryId)).owner_id).toBe(f.ownerId);
    expect((await ruleOf(candidateId)).memory_id).toBe(f.memoryId);
  });
});
