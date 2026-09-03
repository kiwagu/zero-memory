/**
 * Refuses a promote whose schema change was never rehearsed on live's data.
 *
 * WHAT IT PROTECTS AGAINST. A migration validated on the test stack proves only
 * that the series applies to an EMPTY database: `db reset` builds it from
 * scratch against fixtures. The failures that matter come from the data —
 * `not null` on a column that has nulls, a unique index on rows that already
 * duplicate, a `check` the accumulated rows violate, a type change that dies on
 * one real value, a backfill that holds a lock for minutes at real volume. None
 * of those can surface where there is nothing to contradict them.
 *
 * So the accumulated pending series has to be applied to a physical clone of
 * live first. That is exactly what the review contour does
 * (`bun --cwd tests/e2e run review:stack -- --refresh`), and it leaves a receipt
 * this gate can CHECK rather than trust: the watermark the clone started from,
 * the versions applied on top, and when.
 *
 * THE CHECK, in order — every leg has to hold:
 *   1. nothing pending against live  → pass (a code-only promote needs no rehearsal)
 *   2. a receipt exists and names a rehearsal
 *   3. it started from live's CURRENT watermark (live moved ⇒ stale rehearsal)
 *   4. it covers EVERY pending version (a later migration is not covered by an
 *      earlier rehearsal)
 *   5. it is younger than ZM_REHEARSAL_MAX_AGE_H (default 24) — live's data
 *      drifts, and a week-old rehearsal answers a question about a week-old
 *      corpus
 *
 * Usage:
 *   bun scripts/rehearsal-gate.ts [migrations-dir]   # defaults to this repo's
 *
 * Deliberate override, for the operator only: ZM_SKIP_REHEARSAL_GATE=1. It says
 * so loudly, because skipping it means migrating the serving database on a path
 * nobody walked.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const migrationsDir = resolve(root, process.argv[2] ?? 'supabase/migrations');
const receiptPath = resolve(root, 'tests/e2e/.runtime/review/clone.json');
const liveDb = process.env.LIVE_DB ?? 'supabase_db_zero-memory';
const maxAgeHours = Number(process.env.ZM_REHEARSAL_MAX_AGE_H ?? 24);

interface RehearsalReceipt {
  clonedAt?: string;
  liveWatermark?: string;
  rehearsedAt?: string;
  head?: string;
  appliedVersions?: string[];
}

// The annotation on the BINDING is not redundant with the one on the arrow:
// TypeScript only treats a call as terminating — and narrows what follows —
// when the called value's declaration carries an explicit type. Without it
// every guard below has to re-check what `fail` already made impossible.
const fail: (reason: string, remedy: string) => never = (reason, remedy) => {
  process.stderr.write(
    `\n✗ pre-promote rehearsal gate: ${reason}\n\n  ${remedy}\n\n` +
      '  The rehearsal applies the pending series to a physical clone of live,\n' +
      '  which is the only place the data-shaped failures can show up before\n' +
      '  they reach the serving database.\n\n' +
      '  Deliberate override (says what it is doing): ZM_SKIP_REHEARSAL_GATE=1\n\n'
  );
  process.exit(1);
};

/** Read-only query against the serving cluster. */
const liveWatermark = (): string => {
  const result = spawnSync(
    'docker',
    [
      'exec',
      liveDb,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tAc',
      'select coalesce(max(version), $$$$) from supabase_migrations.schema_migrations',
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail(
      `could not read the live migration ledger from ${liveDb}`,
      'Is the live stack up? Set LIVE_DB if its container is named differently.'
    );
  }
  return (result.stdout ?? '').trim();
};

/** Migration versions present in the tree, oldest first. */
const treeVersions = (): string[] =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.split('_')[0] ?? '')
    .filter((version) => /^\d+$/.test(version))
    .sort();

const main = (): void => {
  if (process.env.ZM_SKIP_REHEARSAL_GATE === '1') {
    process.stdout.write(
      '⚠ ZM_SKIP_REHEARSAL_GATE=1 — promoting a schema change that was NOT\n' +
        '  rehearsed on live data. The pre-promote snapshot is your only undo.\n'
    );
    return;
  }

  const watermark = liveWatermark();
  const pending = treeVersions().filter((version) => version > watermark);
  if (pending.length === 0) {
    process.stdout.write(
      `✓ rehearsal gate: nothing pending against live (watermark ${watermark || 'empty'}) — code-only promote.\n`
    );
    return;
  }

  let receipt: RehearsalReceipt | null = null;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as RehearsalReceipt;
  } catch {
    receipt = null;
  }

  const remedy =
    'Rehearse it: cd tests/e2e && bun run review:stack -- --refresh';

  if (!receipt?.rehearsedAt || !receipt.appliedVersions) {
    fail(
      `${pending.length} migration(s) would reach live unrehearsed: ${pending.join(', ')}`,
      remedy
    );
  }
  if (receipt.liveWatermark !== watermark) {
    fail(
      `the rehearsal started from schema ${receipt.liveWatermark || 'empty'} but live is now at ${watermark || 'empty'} — it proved something about a different database`,
      remedy
    );
  }
  const uncovered = pending.filter(
    (version) => !receipt?.appliedVersions?.includes(version)
  );
  if (uncovered.length > 0) {
    fail(
      `the rehearsal did not cover ${uncovered.join(', ')} — those were added after it ran`,
      remedy
    );
  }
  const ageHours =
    (Date.now() - Date.parse(receipt.rehearsedAt)) / (60 * 60 * 1000);
  if (!(ageHours <= maxAgeHours)) {
    fail(
      `the rehearsal is ${Math.round(ageHours)}h old (limit ${maxAgeHours}h, ZM_REHEARSAL_MAX_AGE_H) — live's data has moved since`,
      remedy
    );
  }

  process.stdout.write(
    `✓ rehearsal gate: ${pending.length} pending migration(s) rehearsed on a clone of live ` +
      `${Math.round(ageHours * 10) / 10}h ago at ${receipt.head ?? 'unknown'} — ${pending.join(', ')}\n`
  );
};

main();
