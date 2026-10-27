/**
 * A user's own model-provider key, as the database keeps it: the key lives in
 * the vault, the row a user may read carries only a four-character hint, and
 * nothing a signed-in user can call decrypts or writes it. Only the server,
 * with the service role, stores, replaces and withdraws a key — the way the
 * dashboard's settings route does.
 *
 * Isolated user: a stored key exempts its owner from the budget, which the
 * shared seed users' budget specs must not meet.
 */
import { expect, test } from '@playwright/test';

import { admin, asOwnerSql, psql } from '../helpers/board-store.js';
import {
  entityIdOf,
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

/** Recognisable, and long enough to pass the shape check. */
const KEY = 'sk-ant-e2e-provider-key-DO-NOT-LEAK-7788';
const REPLACEMENT = 'sk-ant-e2e-second-provider-key-VALUE-9900';

const store = async (subjectId: string, key: string): Promise<void> => {
  const { error } = await admin().rpc('set_provider_credential', {
    p_subject_id: subjectId,
    p_provider: 'anthropic',
    p_api_key: key,
  });
  expect(error).toBeNull();
};

const withdraw = async (subjectId: string): Promise<void> => {
  await admin().rpc('revoke_provider_credential', { p_subject_id: subjectId });
};

/** The vault rows holding this subject's key, counted as the database owner. */
const secretsOf = (subjectId: string): string =>
  psql(
    `select count(*) from vault.secrets ` +
      `where name = 'provider_credential:${subjectId}'`
  );

test.describe('a provider key in the database', () => {
  test('is never readable, decryptable or writable by the user who owns it', async () => {
    const user = await provisionE2EUser('provider-credential@zm.e2e');
    const subjectId = await entityIdOf(user.id);
    try {
      await store(subjectId, KEY);
      // The premise: the key is in the vault, so what follows is denial and
      // not an empty table.
      expect(secretsOf(subjectId)).toBe('1');

      const asUser = userRestClient(await passwordGrantToken(user));
      // The row the user may read: the hint, never the key.
      const { data: visible, error: readError } = await asUser
        .from('provider_credentials')
        .select('*');
      expect(readError).toBeNull();
      expect(visible).toHaveLength(1);
      expect((visible?.[0] as { hint: string }).hint).toBe('7788');
      expect(JSON.stringify(visible)).not.toContain(KEY);

      // Not through the function that decrypts it, and not by writing one.
      const decrypt = await asUser.rpc('provider_credential_for', {
        p_subject_id: subjectId,
      });
      expect(decrypt.error?.code).toBe('42501');
      const write = await asUser.rpc('set_provider_credential', {
        p_subject_id: subjectId,
        p_provider: 'anthropic',
        p_api_key: REPLACEMENT,
      });
      expect(write.error?.code).toBe('42501');

      // Not through the vault itself, whatever the API exposes.
      expect(() =>
        asOwnerSql(user.id, 'select count(*) from vault.decrypted_secrets')
      ).toThrow(/permission denied/u);
    } finally {
      await withdraw(subjectId);
    }
  });

  test('replacing keeps one credential and one secret; withdrawing removes both', async () => {
    const user = await provisionE2EUser('provider-credential-swap@zm.e2e');
    const subjectId = await entityIdOf(user.id);
    try {
      await store(subjectId, KEY);
      await store(subjectId, REPLACEMENT);

      const { data: rows } = await admin()
        .from('provider_credentials')
        .select('hint')
        .eq('subject_id', subjectId);
      expect(rows).toEqual([{ hint: '9900' }]);
      // The old value does not linger beside the new one.
      expect(secretsOf(subjectId)).toBe('1');

      await withdraw(subjectId);
      const { data: after } = await admin()
        .from('provider_credentials')
        .select('subject_id')
        .eq('subject_id', subjectId);
      expect(after).toEqual([]);
      expect(secretsOf(subjectId)).toBe('0');
    } finally {
      await withdraw(subjectId);
    }
  });
});
