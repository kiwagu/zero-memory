# zero-memory

Shared, persistent memory for AI coding agents — self-hosted, open source,
and multi-user. One memory server speaks MCP, so Claude Code, Cursor, Codex
CLI, VS Code, and any other MCP-compatible client read and write the same
store instead of rebuilding context from scratch every session.

```
you ──▶ Claude Code ─┐
you ──▶ Cursor ──────┼──▶ zero-memory (MCP) ──▶ Postgres · pgvector + FTS · RLS
teammate ─▶ Codex ───┘                          decisions · gotchas · conventions
```

## Why

Every new session starts from zero. The decision you explained yesterday, the
gotcha that cost an afternoon, the convention nobody wrote down — all of it
has to be retyped, or it is silently re-derived, usually differently.

Existing memory layers are single-user, or they put team sharing behind a
paid cloud. zero-memory targets the gap: **self-hosted, open-source, team
memory with access control enforced by the database**.

## What it does

- **Remembers decisions with their reasoning**, not just facts — plus
  gotchas, conventions, preferences, and open loops that stay visible until
  someone closes them.
- **Briefs a session before it starts.** `build_context` returns the standing
  rules, the open work, and the decisions behind the code you are about to
  touch; hook-capable clients inject it automatically.
- **Keeps scopes honest.** Personal, project, and team scopes are
  owner-namespaced, and access comes from explicit membership — two projects
  with the same name never share anything. Row-level security enforces it in
  Postgres, not in application code.
- **Shares deliberately.** A fragment is private to its author until it is
  shared, and it travels with its provenance: who wrote it, when, and from
  which conversation.
- **Supersedes instead of accumulating.** A corrected memory retires the
  version it replaces, reversibly, so the store converges instead of growing
  contradictions.
- **Stays in one language internally.** Content is canonicalized, so a
  memory written in one language is retrievable from another.
- **Runs the boring parts itself** — hygiene passes, duplicate detection,
  decay and reinforcement, conflict surfacing.

Core memory — recall, remember, search, scopes, briefings — runs locally and
needs no model-provider key. Model-backed extras (repository bootstrap,
hygiene judgements, translation, rule distillation, optional transcript
ingest) need a provider credential, and transcript ingest is off by default:
a fresh install reads memory and sends nothing.

## Quick start

**Using an instance someone already runs** — you need an account, the client
bundle for your platform, and one installer script. No Docker, no checkout:
see [Install the client](./docs/getting-started/install-client.mdx).

**Running your own instance** — Docker for the Supabase backend, a host for
the two application containers, and a TLS edge if it will be reachable beyond
a trusted network: see [Deployment](./docs/getting-started/deployment.mdx).
One invariant matters more than the rest — `ZM_PUBLIC_URL` must equal the
external URL of the MCP server, because it is the OAuth issuer embedded in
every challenge.

**Hacking on the code** — Bun ≥ 1.3.11 and Docker:

```bash
bun install
bun run dev
```

That starts the local Supabase stack, writes the `.env` files, provisions a
development user, and brings up the MCP server on `:8787`, the dashboard on
`:3100`, and the documentation site on `:3200`.

## How it works

A single MCP server exposes memory, briefing, hygiene, rules, import/export,
and metrics tools to every client. Retrieval is hybrid — pgvector similarity
fused with Postgres full-text search — over an entity graph stored as edge
tables. Standing rules promoted by an owner travel through native MCP
instructions where the client can carry them, and through `build_context`
everywhere else. Supabase provides Postgres, auth, and realtime updates,
self-hosted from the compose stack in this repository or on Supabase cloud.

The stack is Turborepo + TypeScript + Next.js, arranged as a DDD/hexagonal
workspace:

| Path                  | What lives there                                             |
| --------------------- | ------------------------------------------------------------ |
| `apps/server`         | the MCP server and its HTTP surface                          |
| `apps/web`            | the dashboard                                                |
| `apps/docs`           | the documentation site                                       |
| `apps/watcher`        | the client-side binary: hooks, ingest, briefings             |
| `packages/*`          | domain, contracts, persistence, retrieval, hygiene, adapters |
| `supabase/migrations` | schema and row-level-security policies                       |
| `infra/`              | development and production compose stacks                    |
| `tests/e2e`           | the Playwright suite and its isolated stack                  |

## Documentation

Full documentation lives in [`docs/`](./docs) as Markdown and is served as a
site by [`apps/docs`](./apps/docs). Start with
[the overview](./docs/index.mdx), or go straight to
[getting started](./docs/getting-started/index.mdx). Worth reading early:
[scopes and isolation](./docs/concepts/scopes-and-isolation.mdx) — the model
that decides who can see what.

## Status

Pre-1.0, running in production for its own team, and used daily to build
itself. Interfaces still move: the schema evolves through forward-only
migrations, and the memory tools are stable in shape but not frozen.

Read the licence's warranty and liability sections as written rather than as
boilerplate. The software is provided **as is, without warranty of any kind**,
and nobody who publishes it is liable for what happens to the data you keep in
it — loss, corruption, or disclosure included. Before 1.0 that is a practical
statement as much as a legal one: whoever runs an instance owns its
durability. Take backups, restore one before you need to, and do not let an
instance hold the only copy of anything that matters.

## Contributing

Bug reports, deployment reports from hosts we have never touched, and client
adapters are the most useful contributions. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md); contributors sign a
[CLA](./CLA.md) on their first pull request, and the
[Code of Conduct](./CODE_OF_CONDUCT.md) applies everywhere.

Found a security problem? Do not open an issue — follow
[SECURITY.md](./SECURITY.md).

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Kiwagu.
