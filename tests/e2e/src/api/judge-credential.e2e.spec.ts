/**
 * An account's own decision-model key for the rule gate, as the database
 * keeps it: the key lives in the vault, the row its owner may read carries
 * only the provider, the model and a four-character hint, and nothing a
 * signed-in user can call decrypts, writes or withdraws it. Only the server,
 * with the service role, does — the same boundary as the model-provider key.
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
const KEY = 'sq-e2e-judge-key-DO-NOT-LEAK-4455';

const withdraw = async (subjectId: string): Promise<void> => {
  await admin().rpc('revoke_judge_credential', { p_subject_id: subjectId });
};

/** The vault rows holding this subject's judge key, counted as the database owner. */
const secretsOf = (subjectId: string): string =>
  psql(
    `select count(*) from vault.secrets ` +
      `where name = 'judge_credential:${subjectId}'`
  );

test.describe('a judge key in the database', () => {
  test('is never readable, decryptable, writable or withdrawable by the user who owns it', async () => {
    const user = await provisionE2EUser('judge-credential@zm.e2e');
    const subjectId = await entityIdOf(user.id);
    try {
      const { error: storeError } = await admin().rpc('set_judge_credential', {
        p_subject_id: subjectId,
        p_provider: 'subq',
        p_api_key: KEY,
        p_model: 'subq-snap-1.1',
      });
      expect(storeError).toBeNull();
      // The premise: the key is in the vault, so what follows is denial and
      // not an empty table.
      expect(secretsOf(subjectId)).toBe('1');

      const asUser = userRestClient(await passwordGrantToken(user));
      // The row the user may read: provider, model and hint, never the key.
      const { data: visible, error: readError } = await asUser
        .from('judge_credentials')
        .select('provider, model, hint');
      expect(readError).toBeNull();
      expect(visible).toEqual([
        { provider: 'subq', model: 'subq-snap-1.1', hint: '4455' },
      ]);
      const { data: whole } = await asUser
        .from('judge_credentials')
        .select('*');
      expect(JSON.stringify(whole)).not.toContain(KEY);

      // Not through the function that decrypts it, by writing one, or by
      // withdrawing it.
      const decrypt = await asUser.rpc('judge_credential_for', {
        p_subject_id: subjectId,
      });
      expect(decrypt.error?.code).toBe('42501');
      const write = await asUser.rpc('set_judge_credential', {
        p_subject_id: subjectId,
        p_provider: 'typesafe',
        p_api_key: 'ts-e2e-replacement-key-0000',
      });
      expect(write.error?.code).toBe('42501');
      const revoke = await asUser.rpc('revoke_judge_credential', {
        p_subject_id: subjectId,
      });
      expect(revoke.error?.code).toBe('42501');
      expect(secretsOf(subjectId)).toBe('1');

      // Not through the vault itself, whatever the API exposes.
      expect(() =>
        asOwnerSql(user.id, 'select count(*) from vault.decrypted_secrets')
      ).toThrow(/permission denied/u);

      // Withdrawn by the server, the key leaves the vault with its row.
      await withdraw(subjectId);
      const { data: after } = await admin()
        .from('judge_credentials')
        .select('subject_id')
        .eq('subject_id', subjectId);
      expect(after).toEqual([]);
      expect(secretsOf(subjectId)).toBe('0');
    } finally {
      await withdraw(subjectId);
    }
  });
});
