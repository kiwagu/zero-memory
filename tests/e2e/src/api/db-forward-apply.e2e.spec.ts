/**
 * db-forward-apply.sh against the isolated stack: the deploy-time migration
 * applier must apply exactly the pending tail with CLI-compatible
 * bookkeeping, be idempotent, and refuse a diverged or out-of-order series.
 *
 * The spec drives the real script with ZM_MIGRATIONS_DIR pointing at a
 * temporary copy of the series, so the checked-in migrations are never
 * mutated and the synthetic migration is dropped again before the spec ends.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(root, 'infra/prod/scripts/db-forward-apply.sh');
const realSeries = join(root, 'supabase/migrations');
// The isolated stack's Postgres — fixed ports and CLI-default credentials
// from tests/e2e/supabase/config.toml, like the rest of the api helpers.
const dbUrl = 'postgresql://postgres:postgres@127.0.0.1:55332/postgres';

// Sorts after every real version, well clear of anything a future series
// could plausibly use.
const syntheticVersion = '99991231235958';
const syntheticName = 'zz_forward_apply_rehearsal';
const syntheticFile = `${syntheticVersion}_${syntheticName}.sql`;
const syntheticBody =
  'create table public.zz_forward_apply_rehearsal (id integer primary key);\n';

const applier = (
  migrationsDir: string,
  mode?: 'pending'
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('bash', mode ? [script, mode] : [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPABASE_DB_URL: dbUrl,
      ZM_MIGRATIONS_DIR: migrationsDir,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

// The same vehicle the script itself uses, so the assertions cannot pass
// through a different client than the code under test.
const sql = (query: string): string => {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '-i',
      'supabase/postgres:17.6.1.136',
      'psql',
      dbUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-tA',
      '-c',
      query,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
};

const cleanupSynthetic = (): void => {
  sql('drop table if exists public.zz_forward_apply_rehearsal');
  sql(
    `delete from supabase_migrations.schema_migrations where version = '${syntheticVersion}'`
  );
};

test.describe('deploy-time migration applier', () => {
  test('is a no-op on a current schema and applies a pending tail exactly once', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'zm-forward-apply-'));
    try {
      cpSync(realSeries, tmp, { recursive: true });

      // Current schema: nothing pending, apply mode says so and exits 0.
      const quietPending = applier(tmp, 'pending');
      expect(quietPending.status).toBe(0);
      expect(quietPending.stdout.trim()).toBe('');
      const quietApply = applier(tmp);
      expect(quietApply.status).toBe(0);
      expect(quietApply.stdout).toContain('schema current');

      // One synthetic migration beyond the watermark: pending lists exactly
      // it, apply advances the watermark and records CLI-shaped bookkeeping.
      writeFileSync(join(tmp, syntheticFile), syntheticBody);
      const pending = applier(tmp, 'pending');
      expect(pending.status).toBe(0);
      expect(pending.stdout.trim()).toBe(syntheticFile);

      const apply = applier(tmp);
      expect(apply.status).toBe(0);
      expect(apply.stdout).toContain(`applying ${syntheticFile}`);
      expect(apply.stdout).toContain(`schema advanced to ${syntheticVersion}`);

      expect(
        sql(
          "select to_regclass('public.zz_forward_apply_rehearsal') is not null"
        )
      ).toBe('t');
      expect(
        sql(
          `select name || '|' || (statements[1] like '%create table%')::text
           from supabase_migrations.schema_migrations
           where version = '${syntheticVersion}'`
        )
      ).toBe(`${syntheticName}|true`);

      // Idempotence: a second run finds nothing to do.
      const again = applier(tmp);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('schema current');
    } finally {
      cleanupSynthetic();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refuses a diverged history instead of guessing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'zm-forward-apply-'));
    try {
      cpSync(realSeries, tmp, { recursive: true });
      // Drop one APPLIED migration from the local copy: the applied history
      // now names a version the series does not carry.
      const applied = sql(
        'select version from supabase_migrations.schema_migrations order by version limit 1'
      );
      const victim = spawnSync('bash', ['-c', `ls ${tmp}/${applied}_*.sql`])
        .stdout?.toString()
        .trim();
      expect(victim).toBeTruthy();
      rmSync(victim!);

      const result = applier(tmp, 'pending');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('history diverged');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refuses an unapplied file behind the watermark', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'zm-forward-apply-'));
    try {
      cpSync(realSeries, tmp, { recursive: true });
      // Older than every applied version, therefore behind the watermark.
      writeFileSync(
        join(tmp, '19990101000000_zz_out_of_order.sql'),
        'select 1;\n'
      );
      const result = applier(tmp, 'pending');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('out-of-order');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
