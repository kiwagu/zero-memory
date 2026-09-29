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
 *
 * Publishing into a scope takes write access to it, and a retirement or a
 * share names whoever makes it, however the row gets there.
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

interface ScopeFixture {
  scope: string;
  ownerId: string;
  memberId: string;
  ownerToken: string;
  memberToken: string;
}

/** User A's project scope, with user B as a member in the given role. */
const scopeWithMember = async (
  tag: string,
  role: 'reader' | 'writer'
): Promise<ScopeFixture> => {
  const seed = await readSeedState();
  const ownerToken = await passwordGrantToken(seed.userA);
  const scope = await projectScope(ownerToken, tag, markers);
  const { data: owner } = await admin()
    .from('profiles')
    .select('id')
    .eq('user_id', seed.userA.id)
    .single();
  return {
    scope,
    ownerId: (owner as { id: string }).id,
    memberId: await makeMember(scope, seed.userB.id, role),
    ownerToken,
    memberToken: await passwordGrantToken(seed.userB),
  };
};

interface RuleFixture extends ScopeFixture {
  memoryId: string;
  successorId: string;
  candidateId: string;
}

/**
 * User A's shared memory carrying a promoted rule, a second shared memory of
 * A's that could succeed it, and user B as a writer member of their scope.
 */
const sharedRuleMemory = async (tag: string): Promise<RuleFixture> => {
  const f = await scopeWithMember(tag, 'writer');
  const agent = await McpTestClient.connect(f.ownerToken);
  const writeShared = async (content: string): Promise<string> => {
    const made = await agent.callTool('remember', {
      content,
      kind: 'convention',
      scope: f.scope,
    });
    expect(made.isError ?? false).toBe(false);
    const { memory_id } = firstJson<{ memory_id: string }>(made);
    markers.push(memory_id);
    const shared = await agent.callTool('share', {
      memory_id,
      scope: f.scope,
    });
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

  const promoted = await asUser(f.ownerToken).rpc('promote_memory_to_rule', {
    p_memory_id: memoryId,
  });
  expect(promoted.error).toBeNull();
  const candidateId = (promoted.data as { candidate_id: string }[])[0]!
    .candidate_id;
  createdRules.push(candidateId);
  return { ...f, memoryId, successorId, candidateId };
};

const MEMORY_COLUMNS =
  'owner_id, content, scope, visibility, superseded_by, invalidated_at, invalidated_by, shared_by';

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

/** A row inserted through the API as the given caller, the way an attacker would. */
const insert = async (
  client: SupabaseClient,
  values: Record<string, unknown>
): Promise<{ id?: string; code?: string }> => {
  const { data, error } = await client
    .from('memories')
    .insert({ kind: 'fact', ...values })
    .select('id')
    .single();
  const id = (data as { id: string } | null)?.id;
  if (id) {
    markers.push(id);
  }
  return { id, code: error?.code };
};

const shareStamp = (by: string): Record<string, unknown> => ({
  visibility: 'shared',
  shared_at: new Date().toISOString(),
  shared_by: by,
});

test.describe('Changing a written memory', () => {
  test("a writer member can retire another member's shared memory, and change nothing else about it", async () => {
    const f = await sharedRuleMemory(`writer-${Date.now()}`);
    const memoryBefore = await memoryRow(f.memoryId);
    const ruleBefore = await ruleOf(f.candidateId);
    expect(memoryBefore.visibility).toBe('shared');
    expect(ruleBefore).toMatchObject({
      memory_id: f.memoryId,
      status: 'promoted',
    });

    const writer = asUser(f.memberToken);
    const refused: Record<string, unknown>[] = [
      // Its words: the rule is the memory's text and would take the new one.
      { content: 'e2e write guard: ship the relay firmware unpinned' },
      // Whose it is: the rule would become the writer's to rewrite.
      { owner_id: f.memberId },
      // What replaced it: the rule would move onto the owner's other memory.
      { superseded_by: f.successorId },
      { scope: `user.${f.memberId.replaceAll('.', '_')}` },
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
    expect(await ruleOf(f.candidateId)).toEqual(ruleBefore);

    // The one change that is the writer's: retiring it, as themselves,
    // through the tool a team member uses.
    const agent = await McpTestClient.connect(f.memberToken);
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
    expect(retired.invalidated_by).toBe(f.memberId);
  });

  test('the owner cannot hand a memory to another member, or retire or share it in their name', async () => {
    const f = await sharedRuleMemory(`handoff-${Date.now()}`);
    const before = await memoryRow(f.memoryId);
    const owner = asUser(f.ownerToken);

    const refused: Record<string, unknown>[] = [
      { owner_id: f.memberId },
      { invalidated_at: new Date().toISOString(), invalidated_by: f.memberId },
      { shared_by: f.memberId },
    ];
    for (const values of refused) {
      expect(
        await patch(owner, f.memoryId, values),
        JSON.stringify(values)
      ).toBe('42501');
    }
    expect(await memoryRow(f.memoryId)).toEqual(before);
    expect((await ruleOf(f.candidateId)).memory_id).toBe(f.memoryId);
  });

  test('a reader member cannot publish into the scope by sharing a memory of their own', async () => {
    const f = await scopeWithMember(`reader-${Date.now()}`, 'reader');
    const reader = asUser(f.memberToken);

    // A private memory may sit in any scope, so the reader can put one here.
    const written = await insert(reader, {
      content: `e2e write guard reader ${Date.now()}: deploys freeze on Fridays`,
      scope: f.scope,
      visibility: 'private',
    });
    expect(written.code).toBeUndefined();
    const id = written.id!;

    expect(await patch(reader, id, shareStamp(f.memberId))).toBe('42501');
    expect((await memoryRow(id)).visibility).toBe('private');

    // The same flip goes through once the member may write the scope.
    await makeMember(f.scope, (await readSeedState()).userB.id, 'writer');
    expect(await patch(reader, id, shareStamp(f.memberId))).toBeUndefined();
    expect((await memoryRow(id)).visibility).toBe('shared');
  });

  test("a new memory cannot arrive retired or shared in another member's name", async () => {
    const f = await scopeWithMember(`insert-${Date.now()}`, 'writer');
    const writer = asUser(f.memberToken);
    const content = (label: string): string =>
      `e2e write guard insert ${Date.now()}: ${label}`;

    expect(
      (
        await insert(writer, {
          content: content('retired by someone else'),
          scope: f.scope,
          visibility: 'private',
          invalidated_at: new Date().toISOString(),
          invalidated_by: f.ownerId,
        })
      ).code
    ).toBe('42501');
    expect(
      (
        await insert(writer, {
          content: content('shared by someone else'),
          scope: f.scope,
          ...shareStamp(f.ownerId),
        })
      ).code
    ).toBe('42501');

    // In their own name, the writer's shared insert is accepted.
    const own = await insert(writer, {
      content: content('shared by the writer'),
      scope: f.scope,
      ...shareStamp(f.memberId),
    });
    expect(own.code).toBeUndefined();
  });
});
