/**
 * Stand launcher — TWO CONTOURS, one script, never the dev/stage stack.
 *
 * - `test` (default): the isolated Supabase CLI stack `zero-memory-e2e`
 *   (ports 5533x) with dedicated server (:8788) + web (:3102). Every run starts
 *   with `db reset` — clean schema + fresh fixtures. This is the suite's stand.
 * - `review`: the stack `zero-memory-review` (ports 5534x) with its own server
 *   (:8789) + web (:3103), booted from the SAME working tree, so the same
 *   commit — and BOTH halves hot-reload it (the server runs under `bun --watch`),
 *   so the stand keeps tracking what you edit. Its database is a PHYSICAL CLONE
 *   of the live cluster plus the branch's pending migrations, and it stays up.
 *   That accumulation is the pre-promote rehearsal, and it is also the stand
 *   manual acceptance happens on.
 *
 * WHY BOTH: the two loads are incompatible on one stack. `db reset` is the
 * condition of determinism and cannot be given up; acceptance and the migration
 * rehearsal need real data left standing. On a single stack they evict each
 * other — any suite run wipes the clone, and while the clone is needed the suite
 * cannot run. Separate stacks let `--target=both` do both in one command.
 *
 * PERSISTENT by default (fast repeat runs): stacks and app processes are left UP
 * between runs. The slow part — a stack's cold start — is paid once.
 *
 * Usage (from tests/e2e):
 *   bun scripts/run-e2e.ts                      # test contour: reset, run, leave up
 *   bun scripts/run-e2e.ts --grep @smoke
 *   bun scripts/run-e2e.ts --persist            # test contour up, no tests
 *   bun scripts/run-e2e.ts --ephemeral          # tear the test contour down at the end
 *   bun scripts/run-e2e.ts --down               # tear the test contour down, exit
 *   bun scripts/run-e2e.ts --target=review --persist [--refresh]
 *   bun scripts/run-e2e.ts --target=both --refresh   # fresh review stand + full suite
 *   bun scripts/run-e2e.ts --target=both --down
 *   bun scripts/run-e2e.ts --status             # what is up, on what data, from which commit
 *
 * The review contour is refreshed ON DEMAND: `--refresh` re-clones live (and
 * re-applies pending DDL). Without it, an existing clone is reused as-is and its
 * provenance is printed, so staleness is visible rather than assumed away.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
const e2eRoot = resolve(repoRoot, 'tests/e2e');

type ContourKey = 'test' | 'review';

interface Contour {
  key: ContourKey;
  /** Must match `project_id` in the contour's config.toml — it names the
   * stack's containers (`supabase_<service>_<project_id>`). */
  projectId: string;
  /** Supabase CLI `--workdir`: the directory holding `supabase/config.toml`. */
  workdir: string;
  serverPort: number;
  webPort: number;
  /**
   * How the database is brought to a known state at boot:
   * - `reset` — migrations from scratch + fixtures (destructive, every run);
   * - `clone` — physical clone of the live cluster + pending migrations.
   */
  db: 'reset' | 'clone';
  /**
   * Whether this contour's server process reloads source edits on its own. When
   * it does not, a reused process can silently serve code older than the working
   * tree — which is what `sourceChangedSinceBoot` exists to catch.
   */
  serverHotReloads: boolean;
  /** `zm-cluster.sh` subcommand that restores a snapshot into this stack. */
  cloneCommand?: string;
}

const CONTOURS: Record<ContourKey, Contour> = {
  test: {
    key: 'test',
    projectId: 'zero-memory-e2e',
    workdir: e2eRoot,
    serverPort: 8788,
    webPort: 3102,
    db: 'reset',
    // Deliberately not: readiness is gated once, before the suite, so a restart
    // mid-run would race the specs, and MCP Streamable HTTP sessions live in
    // process memory.
    serverHotReloads: false,
  },
  review: {
    key: 'review',
    projectId: 'zero-memory-review',
    workdir: resolve(e2eRoot, 'review'),
    serverPort: 8789,
    webPort: 3103,
    db: 'clone',
    serverHotReloads: true,
    cloneCommand: 'clone-to-review',
  },
};

const serverUrlOf = (contour: Contour): string =>
  `http://localhost:${contour.serverPort}`;
const webUrlOf = (contour: Contour): string =>
  `http://localhost:${contour.webPort}`;

/**
 * Where THIS contour's authentication mail lands, read from its own config so
 * the two cannot drift. Every stack runs its own catcher on a port that differs
 * only in one digit (5532x dev, 5533x test, 5534x review), which is exactly the
 * kind of thing a person gets wrong while wondering why a stand "sends no mail"
 * — the stands print it now instead of leaving it to be remembered.
 *
 * Null when the contour declares no catcher: then mail leaves the machine (or
 * fails), and saying nothing is better than naming a port that catches nothing.
 */
const mailUrlOf = (contour: Contour): string | null => {
  try {
    const config = readFileSync(
      resolve(contour.workdir, 'supabase/config.toml'),
      'utf8'
    );
    // `[local_smtp]` is the current CLI name; `[inbucket]` the older one (the
    // container keeps the old name under both).
    const section = /\[(?:local_smtp|inbucket)\]([\s\S]*?)(?=\n\[|$)/.exec(
      config
    );
    if (!section?.[1] || !/^\s*enabled\s*=\s*true/m.test(section[1])) {
      return null;
    }
    const port = /^\s*port\s*=\s*(\d+)/m.exec(section[1]);
    return port ? `http://localhost:${port[1]}` : null;
  } catch {
    return null;
  }
};

const rawArgs = process.argv.slice(2);
const LAUNCHER_FLAGS = new Set([
  '--persist',
  '--ephemeral',
  '--down',
  '--refresh',
  '--status',
]);
const has = (flag: string): boolean => rawArgs.includes(flag);
const persist = has('--persist');
const ephemeral = has('--ephemeral');
const downOnly = has('--down');
const refresh = has('--refresh');
const statusOnly = has('--status');

const targetArg = rawArgs.find((arg) => arg.startsWith('--target='));
const target = (targetArg?.split('=')[1] ?? 'test') as
  ContourKey | 'both' | string;
if (!['test', 'review', 'both'].includes(target)) {
  console.error(`unknown --target=${target} (use test, review or both)`);
  process.exit(2);
}
// The suite resets and seeds its stack, so it may only ever address the test
// contour. `--target=review` therefore stands the contour up (or tears it down)
// and never runs Playwright — the guard is here rather than in a convention,
// because getting it wrong destroys a clone of live data.
if (target === 'review' && !persist && !downOnly && !statusOnly) {
  console.error(
    'The suite must never run against the review clone. Use ' +
      '--target=review --persist (stand it up) or --down (tear it down); ' +
      'use --target=both to run the suite on the test contour alongside it.'
  );
  process.exit(2);
}
if (ephemeral && target !== 'test') {
  console.error(
    '--ephemeral applies to the test contour only; tear the review stand down ' +
      'deliberately with --target=review --down.'
  );
  process.exit(2);
}

// Everything that is not a launcher flag is forwarded to Playwright (e.g.
// `--grep @smoke`, `--headed`, `--project=api`).
const pwArgs = rawArgs.filter(
  (arg) => !LAUNCHER_FLAGS.has(arg) && !arg.startsWith('--target=')
);

// Documentation shots overwrite images that ship with the docs site, and the
// framing of those images is a human decision — a suite run must never touch
// them as a side effect. They stay capturable on demand (`bun run
// e2e:screenshots`, which passes its own --grep), so this only removes them
// from runs that did not ask for them.
const asksForShots = pwArgs.some((arg) => arg.includes('docs-shot'));
if (!asksForShots) {
  pwArgs.push('--grep-invert', '@docs-shot');
}

interface AppsState {
  serverPid: number;
  webPid: number;
  /** When these processes were started, so a later run can tell whether the
   * sources they loaded have moved since. Absent in state written before this
   * field existed — treated as "unknown", never as "fresh". */
  bootedAt?: number;
  /** Commit the tree was on at boot, for the status report. */
  head?: string;
}

const runtimeDirOf = (contour: Contour): string =>
  resolve(e2eRoot, '.runtime', contour.key);
const appsStatePathOf = (contour: Contour): string =>
  resolve(runtimeDirOf(contour), 'apps.json');
/** Pre-two-contour location of the test contour's state; read once so an
 * already-running stand from before this change is still killable. */
const legacyAppsStatePath = resolve(e2eRoot, '.runtime/apps.json');

/** Runs a Supabase CLI command against a contour's workdir, inheriting stdio. */
const supabase = (
  contour: Contour,
  args: string[],
  allowFailure = false
): boolean => {
  const result = spawnSync(
    'bunx',
    ['supabase', ...args, '--workdir', contour.workdir],
    { cwd: repoRoot, stdio: allowFailure ? 'ignore' : 'inherit' }
  );
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `supabase ${args.join(' ')} failed for the ${contour.key} contour (exit ${result.status})`
    );
  }
  return result.status === 0;
};

const isStackUp = (contour: Contour): boolean =>
  supabase(contour, ['status'], true);

/** Parses `supabase status -o env` into a map. */
const stackEnv = (contour: Contour): Map<string, string> => {
  const result = spawnSync(
    'bunx',
    ['supabase', 'status', '-o', 'env', '--workdir', contour.workdir],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`supabase status failed — is the ${contour.key} stack up?`);
  }
  const map = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      map.set(match[1], match[2]);
    }
  }
  return map;
};

const httpUp = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
};

const waitForHttp = async (url: string, label: string): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await httpUp(url)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not become ready at ${url} within 120s`);
};

const readAppsState = (contour: Contour): AppsState | null => {
  for (const path of [
    appsStatePathOf(contour),
    ...(contour.key === 'test' ? [legacyAppsStatePath] : []),
  ]) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AppsState;
    } catch {
      // not this one
    }
  }
  return null;
};

/** Kills the recorded detached app process groups, if any, and clears state. */
const killApps = (contour: Contour): void => {
  const state = readAppsState(contour);
  if (state) {
    for (const pid of [state.serverPid, state.webPid]) {
      try {
        // Negative pid: kill the whole group (detached apps are group leaders,
        // so this also reaps next's turbopack workers).
        process.kill(-pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  for (const path of [
    appsStatePathOf(contour),
    ...(contour.key === 'test' ? [legacyAppsStatePath] : []),
  ]) {
    try {
      rmSync(path);
    } catch {
      // no state file
    }
  }
};

const gitHead = (): string => {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return (result.stdout ?? '').trim() || 'unknown';
};

/**
 * True when any server source is newer than the moment the apps booted.
 *
 * This is the mechanism behind the most-rediscovered failure of this harness: a
 * reused server process loaded its code ONCE, so after an edit (or a checkout)
 * the suite validates the OLD server while the hot-reloading web half already
 * shows the new behaviour — the failure then reads as a feature bug rather than
 * a stale process. A commit hash cannot catch it (uncommitted edits are the
 * common case), so this compares file mtimes against the boot time.
 *
 * `-print -quit` stops at the first hit, so the cost is a stat walk, not a scan.
 */
const sourceChangedSinceBoot = (bootedAt: number): boolean => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `find apps/server/src packages/*/src -type f -newermt @${Math.floor(bootedAt / 1000)} -print -quit 2>/dev/null`,
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  return (result.stdout ?? '').trim().length > 0;
};

/** Last lines of an app's log, for an error message that would otherwise say
 * only "the port never answered". */
const logTail = (contour: Contour, name: string, lines = 12): string => {
  try {
    return readFileSync(resolve(runtimeDirOf(contour), `${name}.log`), 'utf8')
      .trimEnd()
      .split('\n')
      .slice(-lines)
      .join('\n');
  } catch {
    return '(no log file)';
  }
};

/** Spawns a long-running, detached app process that outlives this launcher. */
const spawnApp = (
  contour: Contour,
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): number => {
  const logFd = openSync(resolve(runtimeDirOf(contour), `${name}.log`), 'w');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${contour.key} ${name}`);
  }
  return child.pid;
};

const teardown = (contour: Contour): void => {
  killApps(contour);
  supabase(contour, ['stop', '--no-backup'], true);
};

const containerRunning = (name: string): boolean => {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
    { encoding: 'utf8' }
  );
  return (result.stdout ?? '').includes(name);
};

/**
 * True when the contour's config.toml asks for the mail catcher. Text match
 * rather than a TOML parse: this launcher deliberately has no dependencies
 * beyond node built-ins.
 */
const mailCatcherConfigured = (contour: Contour): boolean =>
  /\[local_smtp\][^[]*enabled\s*=\s*true/.test(
    readFileSync(resolve(contour.workdir, 'supabase/config.toml'), 'utf8')
  );

/**
 * Reusing a running stack is what makes repeat runs fast — but it also means a
 * service NEWLY enabled in config.toml never appears, because only `supabase
 * start` reads that. The failure is then a spec timing out on mail that nothing
 * was ever going to send. Detect exactly that case and pay for one restart.
 */
const restartIfStackPredatesConfig = (contour: Contour): void => {
  if (!mailCatcherConfigured(contour)) {
    return;
  }
  if (containerRunning(`supabase_inbucket_${contour.projectId}`)) {
    return;
  }
  console.log(
    `→ [${contour.key}] config enables the mail catcher but it is not running ` +
      '(the reused stack predates that change) — restarting the stack once…'
  );
  supabase(contour, ['stop', '--no-backup'], true);
  supabase(contour, ['start']);
};

const psql = (contour: Contour, sql: string): string => {
  const result = spawnSync(
    'docker',
    [
      'exec',
      `supabase_db_${contour.projectId}`,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tAc',
      sql,
    ],
    { encoding: 'utf8' }
  );
  return (result.stdout ?? '').trim();
};

/** Ensures a stack is running, without touching its data. */
const ensureStackUp = (contour: Contour): void => {
  if (isStackUp(contour)) {
    console.log(
      `→ [${contour.key}] Supabase stack already up (${contour.projectId}) — reusing it.`
    );
    restartIfStackPredatesConfig(contour);
    return;
  }
  console.log(
    `→ [${contour.key}] starting isolated Supabase stack (${contour.projectId})…`
  );
  supabase(contour, ['start']);
};

/**
 * `db reset` restarts sibling containers (auth, rest, …) and they can come back
 * on new container IPs. Kong resolves upstreams at config load, so it may keep
 * proxying to the OLD addresses and 502 every /auth/v1/* health probe until the
 * 120s gate gives up. Bouncing Kong makes it re-resolve — deterministic instead
 * of IP-reuse luck.
 */
const bounceKong = (contour: Contour): void => {
  console.log(`→ [${contour.key}] bouncing Kong so it re-resolves upstreams…`);
  spawnSync('docker', ['restart', `supabase_kong_${contour.projectId}`], {
    stdio: 'ignore',
  });
};

/**
 * Test contour: clean schema + fresh fixtures for a deterministic run.
 *
 * The reset is retried ONCE, and the reason is diagnosed rather than
 * superstitious: when the stack is REUSED instead of freshly created, the
 * still-running realtime service races the recreated database. Its container
 * log shows a duplicate insert into `tenants_external_id_index` and a read of
 * a `realtime.schema_migrations` that does not exist yet, while the CLI
 * reports only `error running container: exit 1`. Seen four times in one day,
 * every time on a reused stack, and clearing on either a retry or a full
 * teardown. Restarting realtime first is what makes the retry a fix rather
 * than a coin flip. A retry costs seconds; the failure costs a whole run, and
 * once it cost a release attempt.
 */
const resetDatabase = (contour: Contour): void => {
  console.log(
    `→ [${contour.key}] resetting DB (fast: migrations from scratch, clean fixtures)…`
  );
  const attempt = (): boolean =>
    spawnSync(
      'bunx',
      ['supabase', 'db', 'reset', '--workdir', contour.workdir],
      { cwd: repoRoot, stdio: 'inherit' }
    ).status === 0;
  if (!attempt()) {
    console.log(
      `→ [${contour.key}] reset failed on a reused stack — restarting realtime and retrying once…`
    );
    spawnSync('docker', ['restart', `supabase_realtime_${contour.projectId}`], {
      stdio: 'ignore',
    });
    if (!attempt()) {
      throw new Error(
        `supabase db reset failed twice for the ${contour.key} contour`
      );
    }
  }
  bounceKong(contour);
};

const snapshotDir = (): string =>
  resolve(repoRoot, process.env.ZM_SNAPSHOT_DIR ?? '.snapshots');

/**
 * Newest existing snapshot if it is younger than the reuse window, else null so
 * `zm-cluster.sh` takes a fresh one. Without a window, a stand refreshed a few
 * times an hour fills the snapshot directory with copies of one and the same
 * live state; with it, the second refresh in a row costs nothing.
 */
const reusableSnapshot = (): { path: string; ageMinutes: number } | null => {
  const reuseMinutes = Number(process.env.ZM_SNAPSHOT_REUSE_MIN ?? 30);
  let newest: { path: string; mtimeMs: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(snapshotDir());
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('_zm-cluster.tar.gz')) {
      continue;
    }
    const path = resolve(snapshotDir(), entry);
    const { mtimeMs } = statSync(path);
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs };
    }
  }
  if (!newest) {
    return null;
  }
  const ageMinutes = (Date.now() - newest.mtimeMs) / 60_000;
  return ageMinutes <= reuseMinutes ? { path: newest.path, ageMinutes } : null;
};

/** True when this stack's database carries a clone rather than fixtures: a
 * freshly initialised stack has no auth users at all (seeding is off). */
const carriesClone = (contour: Contour): boolean =>
  Number(psql(contour, 'select count(*) from auth.users') || '0') > 0;

const receiptPath = (contour: Contour): string =>
  resolve(runtimeDirOf(contour), 'clone.json');

/**
 * What the review contour did, in a form another tool can CHECK rather than
 * trust. The promote gate reads this to answer "was the series about to reach
 * live actually rehearsed on live's data, recently, from live's current schema?"
 * — which is why it records the watermark it started from and the versions it
 * applied, not just a timestamp.
 */
interface RehearsalReceipt {
  snapshot: string;
  clonedAt: string;
  /** The clone's schema right after restoring it = LIVE's watermark then. */
  liveWatermark: string;
  rehearsedAt?: string;
  head?: string;
  /** Versions applied ON TOP of the clone — the rehearsed pending series. */
  appliedVersions?: string[];
}

const readReceipt = (contour: Contour): RehearsalReceipt | null => {
  try {
    return JSON.parse(
      readFileSync(receiptPath(contour), 'utf8')
    ) as RehearsalReceipt;
  } catch {
    return null;
  }
};

/** Every version in the stack's migration ledger, oldest first. */
const ledgerVersions = (contour: Contour): string[] =>
  psql(
    contour,
    'select version from supabase_migrations.schema_migrations order by version'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Records what the rehearsal proved, after `migration up` has succeeded. Without
 * a receipt carrying the clone's starting watermark there is nothing to check
 * against, so an untracked clone is reported as such instead of being counted as
 * a rehearsal — the promote gate must refuse in that case, not guess.
 */
const recordRehearsal = (contour: Contour): void => {
  const receipt = readReceipt(contour);
  if (!receipt) {
    console.log(
      `  (no clone provenance for the ${contour.key} stack — the promote gate ` +
        'will refuse until it is re-cloned with --refresh)'
    );
    return;
  }
  const applied = ledgerVersions(contour).filter(
    (version) => version > receipt.liveWatermark
  );
  writeFileSync(
    receiptPath(contour),
    JSON.stringify({
      ...receipt,
      rehearsedAt: new Date().toISOString(),
      head: gitHead(),
      appliedVersions: applied,
    })
  );
  console.log(
    applied.length
      ? `  rehearsed ${applied.length} pending migration(s) on live data: ${applied.join(', ')}`
      : '  no pending migrations to rehearse — the clone is already at the tree.'
  );
};

/**
 * Review contour: the live cluster cloned in, then the branch's pending
 * migrations applied on top. Applying pending DDL to real data IS the
 * pre-promote rehearsal, so a failure here is the command's failure — it is
 * meant to be observable, not a separate manual step.
 */
const cloneDatabase = (contour: Contour): void => {
  if (!contour.cloneCommand) {
    throw new Error(`the ${contour.key} contour has no clone command`);
  }
  const reusable = reusableSnapshot();
  if (reusable) {
    console.log(
      `→ [${contour.key}] reusing a snapshot taken ${Math.round(reusable.ageMinutes)} min ago ` +
        `(ZM_SNAPSHOT_REUSE_MIN); pass a longer window or delete it to force a fresh one.`
    );
  } else {
    console.log(
      `→ [${contour.key}] taking a fresh snapshot of the live cluster…`
    );
  }
  const args = [
    resolve(repoRoot, 'scripts/zm-cluster.sh'),
    contour.cloneCommand,
    ...(reusable ? [reusable.path] : []),
  ];
  const clone = spawnSync('bash', args, { cwd: repoRoot, stdio: 'inherit' });
  if (clone.status !== 0) {
    throw new Error(
      `cloning the live cluster into the ${contour.key} stack failed (exit ${clone.status})`
    );
  }
  // Read BEFORE applying anything: at this instant the clone's ledger is live's
  // ledger, and that watermark is what makes the receipt checkable later.
  const liveWatermark = ledgerVersions(contour).at(-1) ?? '';
  writeFileSync(
    receiptPath(contour),
    JSON.stringify({
      snapshot: reusable?.path ?? 'fresh',
      clonedAt: new Date().toISOString(),
      liveWatermark,
    })
  );

  console.log(
    `→ [${contour.key}] applying pending migrations to the clone (the pre-promote rehearsal)…`
  );
  supabase(contour, ['migration', 'up']);
  recordRehearsal(contour);
  bounceKong(contour);
};

/** Brings a contour's database to its known state per the contour's mode. */
const ensureDatabase = (contour: Contour): void => {
  if (contour.db === 'reset') {
    resetDatabase(contour);
    return;
  }
  if (refresh || !carriesClone(contour)) {
    cloneDatabase(contour);
    return;
  }
  const receipt = readReceipt(contour);
  console.log(
    `→ [${contour.key}] reusing the existing clone` +
      (receipt ? ` (cloned ${receipt.clonedAt})` : ' (provenance unknown)') +
      ' — pass --refresh to re-clone live.'
  );
  // Still applied: the working tree may have gained migrations since the clone,
  // and `migration up` is a no-op when it has not.
  console.log(`→ [${contour.key}] applying any migrations the clone lacks…`);
  supabase(contour, ['migration', 'up']);
  recordRehearsal(contour);
};

const describeData = (contour: Contour): string => {
  const memories = psql(contour, 'select count(*) from public.memories');
  const users = psql(contour, 'select count(*) from auth.users');
  const version = psql(
    contour,
    'select max(version) from supabase_migrations.schema_migrations'
  );
  return `${memories} memories, ${users} users, schema at ${version}`;
};

interface StackKeys {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

const readStackKeys = (contour: Contour): StackKeys => {
  const env = stackEnv(contour);
  const apiUrl = env.get('API_URL');
  const anonKey = env.get('ANON_KEY');
  const serviceRoleKey = env.get('SERVICE_ROLE_KEY');
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      `the ${contour.key} stack status did not expose API_URL/ANON/SERVICE keys`
    );
  }
  return { apiUrl, anonKey, serviceRoleKey };
};

/** Reuses healthy apps, otherwise (re)boots them detached. */
const ensureApps = async (
  contour: Contour,
  { apiUrl, anonKey, serviceRoleKey }: StackKeys
): Promise<void> => {
  const serverUrl = serverUrlOf(contour);
  const webUrl = webUrlOf(contour);
  if (
    (await httpUp(`${serverUrl}/healthz`)) &&
    (await httpUp(`${webUrl}/login`))
  ) {
    // Healthy is not the same as current. A contour whose server does not
    // hot-reload must not be reused once its sources have moved, or the run
    // silently exercises the previous code.
    const state = readAppsState(contour);
    const stale =
      !contour.serverHotReloads &&
      (state?.bootedAt === undefined || sourceChangedSinceBoot(state.bootedAt));
    if (!stale) {
      console.log(`→ [${contour.key}] server + web already up — reusing them.`);
      return;
    }
    console.log(
      `→ [${contour.key}] server + web are up but the sources moved since they ` +
        'booted — rebooting them so the run exercises the current tree.'
    );
  }

  // Replace any half-up/stale processes we previously started before rebooting.
  killApps(contour);

  // App env pointed at this contour's stack. process env wins over each app's
  // own .env (verified for Bun and @next/env), so the dev/stage .env files are
  // left untouched and these values take effect.
  const supabaseEnv: Record<string, string> = {
    SUPABASE_URL: apiUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  };

  // Extraction now defaults OFF (metrics-only is the standing posture), but the
  // e2e suite exists to exercise the ingest→extraction→budget path — so the
  // TEST server runs extraction with the keyless deterministic extractor
  // (matches CI's env). Without this, ingest_conversation short-circuits before
  // the budget gate and the budget-degradation specs never see
  // budget_exhausted. The REVIEW server is deliberately left at the product
  // default so acceptance sees the standing posture; set ZM_INGEST_EXTRACT in
  // the calling shell when the epic under review needs it on.
  const extractionEnv: Record<string, string> =
    contour.key === 'test'
      ? { ZM_INGEST_EXTRACT: 'on', ZM_EXTRACTOR: 'deterministic' }
      : {};

  // The web half is `next dev` on both contours and hot-reloads source edits,
  // so a plain server process makes the two halves reload ASYMMETRICALLY — the
  // UI shows the change while the server still runs the code it loaded at boot,
  // which reads as a data bug rather than a stale process.
  //
  // The REVIEW contour therefore runs the server under `bun --watch`: it is a
  // stand to look at, nothing asserts against it, and a restart costs only a
  // re-warmed embedder and any MCP session held against it.
  //
  // The TEST contour must NOT: readiness is gated once, before the suite, so a
  // restart mid-run would race the specs and cost the run its reproducibility.
  // Its in-process state is load-bearing too — MCP Streamable HTTP sessions live
  // in process memory, and a reload drops them mid-session.
  const serverArgs =
    contour.key === 'review' ? ['--watch', 'src/index.ts'] : ['src/index.ts'];

  console.log(
    `→ [${contour.key}] booting server on ${serverUrl}` +
      (contour.key === 'review' ? ' (hot-reloading)' : '') +
      '…'
  );
  const serverPid = spawnApp(
    contour,
    'server',
    'bun',
    serverArgs,
    resolve(repoRoot, 'apps/server'),
    {
      ...supabaseEnv,
      ...extractionEnv,
      PORT: String(contour.serverPort),
      ZM_PUBLIC_URL: serverUrl,
    }
  );

  console.log(`→ [${contour.key}] booting web on ${webUrl}…`);
  const webPid = spawnApp(
    contour,
    'web',
    'bunx',
    ['next', 'dev', '--turbopack', '-p', String(contour.webPort)],
    resolve(repoRoot, 'apps/web'),
    {
      NEXT_PUBLIC_SUPABASE_URL: apiUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      // The web app calls this contour's MCP server for embed-on-write (merge
      // action). ZM_SERVER_URL is the full MCP endpoint (watcher/hooks
      // convention).
      ZM_SERVER_URL: `${serverUrl}/mcp`,
      // The stand publishes legal documents, because the consent gate in
      // front of sign-up is only exercised when a deployment has some. Both
      // accepted address shapes are represented: a site-root path served by
      // the edge, and an absolute URL somewhere else.
      ZM_TERMS_URL: '/terms',
      ZM_PRIVACY_URL: 'https://example.test/privacy',
      ZM_TERMS_VERSION: 'e2e-1',
      // Keep the Next dev-tools badge out of documentation screenshots —
      // both stands are photographed and hand-inspected surfaces.
      ZM_DEV_INDICATORS: 'off',
      // Next refuses a second dev server for the same project directory — it
      // locks its dist dir, and the failure surfaces only in the app log
      // ("Another next dev server is already running") while the launcher just
      // times out waiting for /login. The two contours serve the same working
      // tree simultaneously by design, so the review one gets its own dist dir
      // (next.config.ts reads NEXT_DIST_DIR, defaulting to `.next`).
      ...(contour.key === 'test' ? {} : { NEXT_DIST_DIR: '.next-review' }),
    }
  );

  writeFileSync(
    appsStatePathOf(contour),
    JSON.stringify({
      serverPid,
      webPid,
      bootedAt: Date.now(),
      head: gitHead(),
    })
  );

  // An app that dies at startup does so in its own log file, while the launcher
  // only sees a port that never answers — so a readiness timeout carries the
  // log's tail rather than sending the reader off to find it.
  try {
    await Promise.all([
      waitForHttp(`${serverUrl}/healthz`, `${contour.key} server`),
      waitForHttp(`${webUrl}/login`, `${contour.key} web`),
    ]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n` +
        `--- ${contour.key} server log (tail) ---\n${logTail(contour, 'server')}\n` +
        `--- ${contour.key} web log (tail) ---\n${logTail(contour, 'web')}`,
      { cause: error }
    );
  }
};

/** Stands a contour up: stack, database, apps. */
const bringUp = async (contour: Contour): Promise<void> => {
  await mkdir(runtimeDirOf(contour), { recursive: true });
  ensureStackUp(contour);
  ensureDatabase(contour);

  const keys = readStackKeys(contour);
  // A reset or a clone restarts the stack's containers. Wait for GoTrue +
  // PostgREST to answer again BEFORE anything uses them — otherwise global
  // setup calls admin.createUser against a still-restarting auth service and
  // gets an empty `{}` error. On a cold run the app-readiness wait hid this; on
  // a warm reuse there is no such wait, so this gate is what makes the
  // database→run handoff deterministic.
  await waitForHttp(`${keys.apiUrl}/auth/v1/health`, `${contour.key} auth`);
  await waitForHttp(`${keys.apiUrl}/rest/v1/`, `${contour.key} rest`);

  await ensureApps(contour, keys);
};

// Version-honesty preflight: the watcher binary reports its package version to
// clients, so a change to its runtime dependency closure must carry a bump.
// build-watcher.sh runs the same gate, but that fires at BUILD/PROMOTE — too
// late, it blocks the release. Running it here makes a missing bump surface
// during stand/CI validation instead, so the bump happens in the test env and
// the eventual promote just passes. Fail fast, before the heavy stack boots.
// Bypass a deliberate non-release run with ZM_SKIP_WATCHER_VERSION_GATE=1.
const watcherVersionGate = (): void => {
  console.log('→ watcher version-honesty gate…');
  const result = spawnSync('bun', ['scripts/watcher-version-gate.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      'watcher version-gate failed — bump before validating:\n' +
        '  bun scripts/bump-watcher-version.ts <patch|minor|major>\n' +
        '(or set ZM_SKIP_WATCHER_VERSION_GATE=1 for a deliberate non-release run)'
    );
  }
};

// Workspace packages that ship a BUILD are imported at runtime from `dist`
// while typechecking from source — a deliberate split that keeps typecheck fast
// and build-free. `turbo run test:e2e` covers it with a `^build` dependency,
// but this launcher is the fast iteration path and is normally invoked
// directly, where nothing rebuilds. An edit to such a package then runs STALE
// while typecheck passes on the new source, so the two gates disagree and
// neither points at the cause: the failure reads as if the edit never happened.
// Unconditional because turbo caches it into a ~0.2s no-op when nothing moved.
const buildWorkspaceDeps = (): void => {
  console.log('→ building workspace deps (a no-op when nothing changed)…');
  const result = spawnSync(
    'bunx',
    [
      'turbo',
      'run',
      'build',
      // Dependencies of everything this launcher runs: the specs themselves
      // plus the two apps it boots.
      '--filter=@workspace/e2e^...',
      '--filter=server^...',
      '--filter=web^...',
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(
      'workspace dependency build failed — fix it before running e2e, or the ' +
        'suite would silently exercise the previous build'
    );
  }
};

const contoursFor = (): Contour[] =>
  target === 'both'
    ? [CONTOURS.review, CONTOURS.test]
    : [CONTOURS[target as ContourKey]];

const reportReviewStand = (contour: Contour): void => {
  console.log(
    `\n✓ review stand is up on the current commit — LIVE data, LIVE credentials.\n` +
      `  ${describeData(contour)}\n` +
      `  server + web hot-reload this working tree.\n` +
      `  server: ${serverUrlOf(contour)}  web: ${webUrlOf(contour)}\n` +
      (mailUrlOf(contour)
        ? `  mail:   ${mailUrlOf(contour)} (this stand's catcher — every stack has its own)\n`
        : '') +
      `  Refresh the clone: bun run review:stack -- --refresh\n` +
      `  Stop:              bun run review:down`
  );
};

/**
 * What is up, on what data, from which commit — in one command.
 *
 * Exists so a session that did not stand these contours up can DISCOVER their
 * state instead of being told it: everything a reader would otherwise ask about
 * (which stand serves which port, how old the clone is, whether a reused process
 * predates the tree) is printed here.
 */
const reportStatus = async (): Promise<void> => {
  console.log(`working tree at ${gitHead()}\n`);
  for (const contour of [CONTOURS.test, CONTOURS.review]) {
    const stackUp = isStackUp(contour);
    const serverUp = await httpUp(`${serverUrlOf(contour)}/readyz`);
    const webUp = await httpUp(`${webUrlOf(contour)}/login`);
    const state = readAppsState(contour);
    console.log(
      `[${contour.key}] ${contour.projectId}` +
        `\n  stack:  ${stackUp ? 'up' : 'down'}` +
        `\n  server: ${serverUp ? `up ${serverUrlOf(contour)}` : 'down'}` +
        `  web: ${webUp ? `up ${webUrlOf(contour)}` : 'down'}` +
        `\n  mail:   ${mailUrlOf(contour) ?? 'no catcher declared'}` +
        `\n  db:     ${contour.db === 'reset' ? 'reset per run (fixtures)' : 'clone of live + pending migrations'}`
    );
    if (stackUp) {
      console.log(`  data:   ${describeData(contour)}`);
    }
    if (contour.db === 'clone') {
      const receipt = readReceipt(contour);
      console.log(
        `  clone:  ${receipt ? `taken ${receipt.clonedAt}` : 'provenance unknown'}` +
          ' — refresh with: bun run review:stack -- --refresh'
      );
      console.log(
        `  ready:  ${
          receipt?.rehearsedAt
            ? `rehearsed ${receipt.rehearsedAt}` +
              ` (${receipt.appliedVersions?.length ?? 0} pending migration(s) on live data)`
            : 'NOT rehearsed — the promote gate will refuse'
        }`
      );
    }
    if (serverUp || webUp) {
      // Three states, not two: an unknown boot time must never read as "current"
      // — the reuse path treats it as stale, and this report has to agree with
      // the behaviour rather than flatter it.
      const freshness = contour.serverHotReloads
        ? 'hot-reloads the tree'
        : state?.bootedAt === undefined
          ? 'boot time unknown — the next run reboots it to be sure'
          : sourceChangedSinceBoot(state.bootedAt)
            ? 'STALE — sources moved since boot, the next run reboots it'
            : 'matches the tree';
      console.log(
        `  code:   booted at ${state?.head ?? 'unknown'}; server ${freshness}`
      );
    }
    console.log('');
  }
};

const main = async (): Promise<number> => {
  if (statusOnly) {
    await reportStatus();
    return 0;
  }

  if (downOnly) {
    for (const contour of contoursFor()) {
      console.log(`→ [${contour.key}] tearing the stack + apps down…`);
      if (contour.db === 'clone') {
        console.log('  (the cloned cluster is discarded with the volume)');
      }
      teardown(contour);
    }
    return 0;
  }

  watcherVersionGate();
  buildWorkspaceDeps();

  // Review first, so a green suite afterwards also demonstrates that a test run
  // leaves the clone alone.
  const review = contoursFor().find((contour) => contour.db === 'clone');
  if (review) {
    await bringUp(review);
    reportReviewStand(review);
  }

  const test = contoursFor().find((contour) => contour.key === 'test');
  if (!test) {
    return 0;
  }

  await bringUp(test);

  if (persist) {
    console.log(
      `\n✓ test stack + apps are up and will be reused.\n` +
        `  server: ${serverUrlOf(test)}  web: ${webUrlOf(test)}\n` +
        (mailUrlOf(test) ? `  mail:   ${mailUrlOf(test)}\n` : '') +
        `  Iterate: bun run pw -- --grep @smoke   (E2E_SERVER_URL/E2E_WEB_URL preset)\n` +
        `  Stop:    bun run e2e:down`
    );
    return 0;
  }

  const keys = readStackKeys(test);
  // Counted before and after the suite: the whole point of the third stack is
  // that a run on the test contour cannot touch the review clone, and this is
  // the cheapest way to show it rather than assert it in prose.
  const reviewUsersBefore = review
    ? psql(review, 'select count(*) from auth.users')
    : null;

  console.log('→ running Playwright…\n');
  const result = spawnSync(
    'bunx',
    ['playwright', 'test', '--config=playwright.config.ts', ...pwArgs],
    {
      cwd: e2eRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        SUPABASE_URL: keys.apiUrl,
        SUPABASE_ANON_KEY: keys.anonKey,
        SUPABASE_SERVICE_ROLE_KEY: keys.serviceRoleKey,
        E2E_SERVER_URL: serverUrlOf(test),
        E2E_WEB_URL: webUrlOf(test),
      },
    }
  );

  if (review && reviewUsersBefore !== null) {
    const after = psql(review, 'select count(*) from auth.users');
    console.log(
      after === reviewUsersBefore
        ? `\n✓ review clone untouched by the run (${after} users before and after).`
        : `\n✗ review clone CHANGED during the run (${reviewUsersBefore} → ${after} users) — the contours are not isolated.`
    );
    if (after !== reviewUsersBefore) {
      return 1;
    }
  }

  if (ephemeral) {
    console.log('→ --ephemeral: tearing the test stack + apps down…');
    teardown(test);
  } else {
    console.log(
      `\n✓ test stack + apps left up for the next run (fast repeat).` +
        ` Stop with: bun run e2e:down`
    );
  }
  return result.status ?? 1;
};

// Signals leave the persistent env as-is (default is persist); use --down /
// e2e:down to tear it down deliberately.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(130));
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
