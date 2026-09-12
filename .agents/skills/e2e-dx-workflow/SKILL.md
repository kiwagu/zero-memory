---
name: e2e-dx-workflow
description: Use when: a change touches critical flows (OAuth, MCP tools, RLS/scopes, dashboard) and you need the repository's standard E2E workflow and commands.
user-invocable: false
---

# E2E DX Workflow

Use this skill when implementing or modifying the OAuth surface, MCP tools,
RLS/scope behavior, or the dashboard (login, feed, fact card) — anything the
e2e safety net covers.

Repository E2E policy (mandatory coverage, 2–3 per feature, reconcile rule):
`/.cursor/rules/e2e-required-for-critical-flows.mdc`

## Workspace and commands

Primary workspace: `tests/e2e` (Playwright; projects `api` + `web`).

Test layers (pyramid): units = vitest (`bun run test`); **integration** =
Playwright `api` project (`bun run test:integration`, no browser);
**e2e** = Playwright `web` project (browser). `bun run test:all` runs the
whole stack (units → integration → e2e).

Root commands:

- `bun run test:all` — units + integration + e2e
- `bun run test:integration` — integration only (`api` project)
- `bun run test:e2e:smoke` — PR baseline (integration + e2e smoke)
- `bun run test:e2e:full` — full/nightly run

Workspace commands:

- `bun --cwd tests/e2e run test:e2e` (append `-- --project=api` or
  `-- --project=web` to run one layer)
- `bun --cwd tests/e2e run test:e2e:headed`
- `bun --cwd tests/e2e run typecheck` / `lint` / `format`

One-time: `bunx playwright install chromium`.

## Isolated stack + environment

`bun run test:e2e:*` stands up a **dedicated Supabase CLI stack** (project
`zero-memory-e2e`, ports 5533x) via `tests/e2e/scripts/run-e2e.ts` and boots
its own server (`:8788`) + web (`:3102`) against it — so e2e data and logs
never touch the dev/stage stack. No dev stack needs to be running; only
Docker + `bunx playwright install chromium` once.

The same launcher owns a second contour, `--target=review`: the stack
`zero-memory-review` (ports 5534x, server `:8789` / web `:3103`), whose database
is a physical clone of live plus the branch's pending migrations, left standing.
That is the stand acceptance happens on and the pre-promote migration rehearsal
in one; the suite never runs against it, because its `db reset` would wipe the
clone. Both halves of that stand hot-reload the working tree (its server runs
under `bun --watch`), unlike the test contour, whose server loads code once at
boot so a suite run stays reproducible — the launcher reboots that one by itself
when the sources moved since it started, so a run never validates the previous
server. `bun --cwd tests/e2e run stands:status` reports what is up, on what data,
and from which commit: call it before assuming anything about a stand you did not
raise yourself. Workspace commands: `review:stack` (add `-- --refresh` to re-clone),
`review:down`, `stands:up`, `stands:down`, and `test:e2e:stands` — one command
that stands up both contours from the current commit, suite on test and a fresh
clone on review. Detail: [tests/e2e/README.md](/tests/e2e/README.md).

To run specs against an already-up stack instead (dev, or a `--persist`
session), set `E2E_SERVER_URL` / `E2E_WEB_URL` and use `bun run pw`.

## Runtime model (determinism)

- The e2e Supabase stack is PERSISTENT: reused if up (cold start paid once),
  `db reset` at the start of every run for a clean schema + fresh fixtures,
  and left up afterwards. Apps (`:8788`/`:3102`) are reused if healthy.
  `--ephemeral` tears down at the end; `bun run e2e:down` stops it deliberately.
- Global setup provisions `e2e-a@zm.e2e` / `e2e-b@zm.e2e` via the service
  role, idempotently and **guarded to the `@zm.e2e` domain** (belt-and-
  suspenders on top of the physical stack isolation).
- Auth in specs is the Supabase password grant (no interactive OAuth);
  the JWT drives both `/mcp` and PostgREST.
- Fixture memories are seeded through public MCP `remember` with stable
  contents; server-side dedup keeps reseeding idempotent.
- The OAuth rate-limit burst runs last in its file; suite start waits out a
  lingering window (`awaitRouteCooldown`) so `--keep-stack` reruns stay green.

## Stable selector contract

When changing auth/feed/card UI: preserve or intentionally migrate the
`data-testid` contract (list in the rule above), update the specs in the
same change, never select by translated text when a testid exists.

## Authoring pattern

1. Update behavior + stable selectors.
2. Add/extend 2–3 specs in `tests/e2e/src/{api,web}/*.e2e.spec.ts`; put
   matrix-style assertions in vitest instead.
3. Run `typecheck`, `lint`, then `bun run test:e2e:smoke`.
4. Broad/risky change → `bun run test:e2e:full`.
5. Blocked by infra → report the exact missing prerequisite and the command
   the reviewer should run.

## Stagehand usage

Stagehand (MCP server `stagehand-local`) is a local exploratory tool for
driving the browser via chat before writing deterministic specs. Never
replace Playwright assertions with LLM-driven checks in the CI gate.
