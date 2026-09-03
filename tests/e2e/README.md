# E2E harness

Single Playwright workspace with two projects in one config — the two upper
layers of the test pyramid (units live in vitest, `bun run test`):

- **`api`** — the **integration** layer, no browser: server + DB + auth wired
  together. OAuth surface (DCR → authorize → token, negatives, rate limit),
  MCP tools over streamable HTTP, RLS scope isolation via an external client.
- **`web`** — the **e2e** layer, chromium against the dashboard: login form,
  memory feed, fact card with provenance.

Whole stack in one shot: `bun run test:all` (units → integration → e2e).

Policy references:

- Rule (mandatory coverage, 2–3 e2e per feature, reconcile-on-change):
  `/.cursor/rules/e2e-required-for-critical-flows.mdc`
- Skill (agent workflow/playbook): `/.claude/skills/e2e-dx-workflow/SKILL.md`

## Two contours: test and review

[scripts/run-e2e.ts](scripts/run-e2e.ts) is one launcher with a `--target`:

| contour          | stack                | ports | server / web    | database at boot                     |
| ---------------- | -------------------- | ----- | --------------- | ------------------------------------ |
| `test` (default) | `zero-memory-e2e`    | 5533x | `:8788`/`:3102` | `db reset` — clean schema + fixtures |
| `review`         | `zero-memory-review` | 5534x | `:8789`/`:3103` | physical clone of live + pending DDL |

They exist separately because their loads are incompatible on one stack.
`db reset` is the condition of determinism and cannot be given up, while manual
acceptance and the pre-promote migration rehearsal both need a clone of live
left standing. On one stack they evict each other — a suite run wipes the clone,
and while the clone is needed the suite cannot run.

Both contours boot their apps from the SAME working tree, so both are on the
current commit. Applying the branch's pending migrations to the clone IS the
pre-promote rehearsal, which is why a failed accumulation fails the command.

**Reload differs by contour, on purpose.** `next dev` hot-reloads on both. The
review server also runs under `bun --watch`, so both halves of that stand track
the tree you are editing — otherwise the UI would show a change while the server
still ran the code it loaded at boot, which reads as a data bug rather than a
stale process. The test server deliberately does NOT: readiness is gated once,
before the suite, so a restart mid-run would race the specs, and its in-process
state is load-bearing (MCP Streamable HTTP sessions live in process memory).

That used to mean remembering to restart the test server after every server-side
change — the harness's most-rediscovered failure, because the hot-reloading web
half made the run look current while the suite validated the old server. The
launcher now decides instead of the reader: it records when the apps booted and
compares that against the mtimes under `apps/server/src` and `packages/*/src`, so
a healthy-but-outdated process is rebooted rather than reused, and it says why.
A missing boot time counts as outdated, never as current.

```sh
bun run test:e2e            # test contour: reset, run the suite, leave up
bun run review:stack        # review stand up (clone reused if present)
bun run review:stack -- --refresh   # re-clone live, re-apply pending DDL
bun run test:e2e:stands     # BOTH: fresh review stand + full suite on test
bun run stands:up           # BOTH up, no tests, fresh clone
bun run e2e:down            # test contour only
bun run review:down         # review contour only (the clone is discarded)
bun run stands:down         # both
bun run stands:status       # what is up, on what data, from which commit
```

Start with `stands:status` when you did not stand these up yourself: it prints
each contour's stack, ports, data shape, the clone's age, and whether a reused
server predates the working tree — so the state is discovered rather than
assumed.

The review stand carries **real data and real credentials** on published host
ports — sign-in there uses live passwords, because a physical clone brings the
live `auth.users` with it. Writing to it is safe; it is a clone.

The clone is refreshed **on demand**, not per run: without `--refresh` an
existing clone is reused and the date it was taken is printed, so staleness is
visible instead of assumed. A snapshot younger than `ZM_SNAPSHOT_REUSE_MIN`
minutes (default 30) is reused instead of taking a new one, so a second refresh
in a row does not fill the snapshot directory with copies of one live state.

The suite can never run against the review clone: `--target=review` only stands
the contour up or tears it down, and `--target=both` runs the specs on the test
contour, then reports that the clone's user count is unchanged.

Extraction: the test server forces the keyless deterministic extractor (the
ingest→budget specs need it); the review server is left at the product default,
so acceptance sees the standing posture. Set `ZM_INGEST_EXTRACT` in the calling
shell when the epic under review needs it on.

## Isolated, persistent stack (the test contour)

`bun run test:e2e:*` runs against a **dedicated Supabase CLI stack** — project
`zero-memory-e2e`, ports 5533x — brought up by
[scripts/run-e2e.ts](scripts/run-e2e.ts). Distinct `project_id` ⇒ its own
Docker network, volumes, and containers, so e2e data (users, memories) and
container logs never bleed into the dev/stage stack. Each run:

1. **reuses** the stack if it is already up, otherwise `supabase start` (the
   slow cold start is paid once);
2. `supabase db reset` — a fast schema-from-scratch + fresh fixtures, so every
   run starts clean without the cold-start cost;
3. **reuses** the dedicated server (`:8788`) + web (`:3102`) if they are
   healthy, otherwise boots them detached (env passed in-process, which wins
   over each app's `.env` — the dev/stage `.env` files are untouched);
4. runs Playwright and **leaves the stack + apps up** for the next run.

Repeat runs are much faster (warm reuse ≈ half the cold time). Flags:

- `--ephemeral` — tear the stack + apps down at the end (CI / one-off clean run)
- `--persist` / `bun run e2e:stack` — bring the stack + apps up, run no tests
- `bun run e2e:down` — stop the persistent stack + apps

## Prerequisites

- Docker running (the CLI stack needs it) and `bunx playwright install
chromium` once. The embedding model is reused from the shared cache
  (`~/.cache/zero-memory/models`), so no network is needed at run time.
- No dev stack required — the harness stands up its own. `SUPABASE_*` env is
  read from the e2e stack's `supabase status`, not from the root `.env`.

## Determinism model

- The stack persists between runs, but every run `db reset`s it — a clean
  schema + re-seeded fixtures, so no state leaks across runs.
- Two dedicated accounts, `e2e-a@zm.e2e` / `e2e-b@zm.e2e`, provisioned in
  global setup via the service role — idempotently, and **guarded to the
  `@zm.e2e` domain** (belt-and-suspenders on top of the physical isolation).
- Sign-in is the Supabase password grant (no interactive OAuth in setup);
  the JWT is what the MCP endpoint and PostgREST accept.
- User A's fixture memories are seeded through the public MCP `remember`
  with stable contents — server-side dedup makes reseeding a no-op.

## Run

- `bun run test:all` — the whole stack: units (vitest) → integration + e2e
- `bun run test` — units only (vitest)
- `bun run test:integration` — integration only (Playwright `api` project)
- `bun run test:e2e:smoke` — PR gate: integration + e2e smoke (from repo root)
- `bun run test:e2e:full` — full/nightly run
- `bun --cwd tests/e2e run test:e2e:headed` — watch the browser
- `bun --cwd tests/e2e run e2e:stack` — bring the stack + apps up and keep them,
  then iterate with `bun --cwd tests/e2e run pw -- --grep @smoke` (the `pw`
  script presets `E2E_SERVER_URL` / `E2E_WEB_URL` at the persistent apps)
- `bun --cwd tests/e2e run e2e:down` — stop everything

### Looking at the dashboard yourself

`bun --cwd tests/e2e run demo:seed` fills the test contour with a showcase
account — a fixed login it prints, a display name, a feed across kinds, an
entity graph, open loops, a version chain, and the review / rules / reflections
queues plus the insights and ROI tiles. It is what the documentation
screenshots are taken against, so its content is real prose about this product
rather than filler; nothing in it belongs to anyone's working corpus.

Idempotent — re-run it after every `e2e:stack` (which db-resets). Writes that
need the real tool path (entities, provenance, translation) go through MCP and
fail loudly, so a screen that renders empty means the seed did not run, not
that the UI is broken.

Reports: `bunx playwright show-report tests/e2e/playwright-report`;
traces/screenshots for failures land in `tests/e2e/test-results`; each contour's
server/web logs are in `tests/e2e/.runtime/<contour>/{server,web}.log`
(`test` or `review`).

## data-testid contract

Stable selectors the specs (and the shadcn migration) must preserve:

- auth: `auth-login-form`, `auth-login-email`, `auth-login-password`,
  `auth-login-submit`, `auth-login-error`
- feed: `memory-feed`, `memory-card`
- feed filters: `feed-filter-kind`, `feed-filter-visibility`,
  `feed-filter-status`, `facet-option-empty` (a facet value that would yield
  nothing under the current selection — dimmed, never removed)
- fact card: `memory-detail-content`, `memory-provenance`

Rewriting a testid requires migrating the covering spec in the same change.

## Notes

- The OAuth rate-limit burst runs last in its spec file and exhausts the
  `/oauth/token` window (default 30 req/60 s). Suite start waits out a
  lingering window (`awaitRouteCooldown`) so runs against the persistent,
  reused server stay green.
- To point specs at an already-running stack instead (e.g. the dev stack),
  run `bun run pw` with `E2E_SERVER_URL` / `E2E_WEB_URL` overridden.
- Stagehand stays a local exploratory tool (MCP server `stagehand-local`);
  the CI gate is deterministic Playwright only.
