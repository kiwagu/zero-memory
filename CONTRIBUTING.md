# Contributing to zero-memory

Thanks for looking. zero-memory is a self-hosted memory server for AI coding
agents, and it grows fastest from the two things only outside users can
produce: reports of what breaks on a deployment that is not ours, and support
for the clients we do not run every day.

## Before you write code

- **Small fix — a bug, a wrong doc line, a missing test — just send it.**
- **Anything larger — a new tool, a schema change, a new client adapter, a
  behaviour change — open an issue first** and describe the problem before
  the solution. The architecture carries a lot of deliberate constraints
  (scope isolation, forward-only migrations, contracts defined as schemas),
  and an issue is where we find out cheaply whether a design fits them.
- **Never open a public issue for a security problem.** See
  [SECURITY.md](./SECURITY.md).

By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md) and
sign the [Contributor License Agreement](./CLA.md) — a bot asks for the
signature on your first pull request, and it takes one comment.

## Getting a local stack running

You need:

- **Bun** ≥ 1.3.11 (`packageManager` pins the exact version the CI uses)
- **Docker** — the local Supabase stack runs in containers
- nothing else; the Supabase CLI is invoked through `bunx`

Then:

```bash
bun install
bun run dev
```

`bun run dev` is idempotent and does the boring parts for you: it starts the
local Supabase stack, reads its URL and keys, writes the `.env` files for
every app, provisions a development user, and brings up the whole workspace —
the MCP server on `:8787`, the dashboard on `:3100`, the documentation site on
`:3200`. Existing `.env` files are left alone; `bun scripts/seed-env.ts --force`
rewrites them.

Secrets live next to the app that reads them (`apps/<app>/.env`), never in a
single root file — the task runner sets each package as its own working
directory, so a root-level value is simply not visible to the app.

## The gates

Run these before you push; CI runs the same ones on your pull request.

```bash
bun run check   # format, lint, typecheck, env-template consistency
bun run test    # unit and integration tests
```

For anything touching a user-visible flow, also run the end-to-end suite. It
brings up its own isolated Supabase stack, so it cannot disturb the one you
develop against:

```bash
bun run test:e2e:smoke   # critical flows, fast
bun run test:e2e:full    # everything
```

A pre-commit hook regenerates database types when a migration is staged and
runs `lint:strict` — **a single lint warning blocks the commit**. That is
deliberate: warnings that survive one commit survive forever.

## Conventions worth knowing before your first pull request

The full set lives in [`.cursor/rules/`](./.cursor/rules) — those files are
the single source of truth for both human and agent contributors, and they
explain the reasoning, not just the rule. The ones that most often surprise a
newcomer:

- **Contracts are schemas first.** Public boundaries — MCP tools, HTTP
  handlers, environment configuration — define a zod schema and derive the
  TypeScript type from it. A hand-written interface at a boundary is a bug.
- **Modules are named for the entity they serve**, not for their layer;
  imports are static, never dynamic `import()` used to dodge a cycle.
- **Migrations are forward-only.** An applied migration is never edited; a
  correction is a new migration. Every table that holds user data gets
  row-level-security policies in the same migration that creates it.
- **Every feature lands with end-to-end specs for its critical flows**, and
  covered surfaces keep their `data-testid` attributes. Specs are updated
  alongside the behaviour they cover — never skipped to get a change through.
- **Documentation moves with the code.** If your change alters what a page in
  `docs/` claims, fix the page in the same pull request; a package whose
  purpose changes gets its `README.md` updated in the same commit.
- **Commit messages are one line**, in the form `type(scope): subject`, in the
  imperative mood, with no trailers: `fix(server): reject an expired session
before it reaches the tool router`.

## Pull requests

- One topic per pull request. A refactor and a fix in the same branch cost
  more review than both separately.
- Fill in the template: what changes, why, and how you verified it.
- Say plainly what you did **not** test. An honest gap is useful; a silent one
  is a defect waiting for someone else.
- Green CI is required. If a gate fails for a reason you believe is unrelated,
  say so in the pull request rather than re-running until it passes.

## What is especially welcome

- **Client adapters.** Every MCP client behaves a little differently around
  instructions and hooks; support for one you use daily is worth more than
  our guess about it.
- **Deployment reports.** Anything that went wrong following the deployment
  guide on a host we have never touched is a real finding — including "the
  documentation was confusing here".
- **Retrieval quality.** Cases where a recall returned the wrong thing, with
  enough context to reproduce, are the hardest input to get and the most
  valuable.

## License

Contributions are licensed under the [Apache License 2.0](./LICENSE), the
license of the project itself.
