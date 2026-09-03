# scripts/

Operational scripts for the repo.

## Deploying to a client

The client installers, the multi-client bundle packager, and the re-home helpers
live in **[`plugin-bundle/`](plugin-bundle/)** — one installer and one re-home
helper per client (Claude Code, Codex, Cursor), plus `build-zm-bundle.sh`. See
[that folder's README](plugin-bundle/README.md) for the table and the "which one
do I run?" guide.

`deploy-zm-client.sh` (here in `scripts/`, not in `plugin-bundle/`) is the
**pre-plugin** Claude path: it wires the MCP server, the ZM-first rule in
`~/.claude/CLAUDE.md`, the watcher binary and the briefing hooks directly — no
plugin, no marketplace, no bundle. Superseded by
`plugin-bundle/deploy-zm-claude.sh` for new installs (that installer warns about
leftover manual wiring); still useful where plugins are unavailable.

```sh
bash scripts/deploy-zm-client.sh                                  # asks for the server
ZM_SERVER_URL=https://memory.example.com/mcp bash scripts/deploy-zm-client.sh
```

`zm-server-url.sh` is the shared piece every installer here sources: it resolves
the server address (`ZM_SERVER_URL` > the stored config > ask), refuses to write
anything until that address answers on `/healthz`, and then stores it in
`~/.config/zero-memory/config.json` so the editor registration, the hooks and
the daemon read one answer instead of three. It travels in the guest bundle
next to the installers.

`zm-platform.sh` is the other shared piece, and the only place a platform is
named. A bundle carries a compiled binary, so it is valid on exactly one
platform; that fact has to appear in the archive's file name, in the bundle's
`bundle.json`, and in the error a mismatch produces — this file keeps the three
in agreement. The builder asks it what to name the archive; every installer
sources it and stops before touching a machine when the manifest names another
platform (a bundle with no manifest passes with a warning). Supporting a new
platform means adding one row there and building on it — no other file changes.

## Build & release

- `build-watcher.sh` — compile `apps/watcher` into a single self-contained
  binary (`bun --compile`); `TARGET=bun-linux-arm64` cross-compiles.
- `wire-hooks.sh` — apply the hook set a machine needs to a client's settings
  file, idempotently and without touching hooks it does not own. It applies
  rather than lists: the set is declared inside the binary and printed by
  `zero-memory-watcher hooks --profile <plugin|ingest|full>`, so adding a hook
  never means editing a shell script. `full` is for a machine with no plugin
  (its only channel); `ingest` is the single hook a plugin-equipped machine
  still keeps here, so capture stays visible in the user's own file. Shared: a
  source machine's `start` calls it, the Claude installer's `--with-ingest`
  reuses it, and `build-zm-bundle.sh` stages it into the bundle. Check what is
  actually wired with `zero-memory-watcher hooks --check`.
- `mirror-snapshot.sh <mirror-dir>` — materialize this repo's `main` tree as a
  history-free snapshot commit INSIDE the local mirror clone, over git's local
  transport. No network, idempotent (an unchanged tree is a no-op), and it cuts
  `v<version>` when the clone carries no tag for the snapshotted tree's version
  — releasing is a version bump. This repository is deliberately NOT connected
  to the mirror host: exactly one checkout holds that remote, and it carries
  nothing but published snapshots.
- `mirror-publish.sh <mirror-dir>` — the only step that talks to the mirror
  host, run inside the clone: pushes the branch plus any version tags the
  remote lacks. `--dry-run` shows what would travel.
- `install-git-hooks.sh` — install this repo's local git hooks idempotently.
  `.git/hooks` is untracked, so a hand-written hook is invisible elsewhere and
  fails silently; the set is declared here instead. `post-merge` flags the
  merge for its durable-status sync and, on `main`, materializes the mirror
  snapshot — main moving is the signal the release contour is built on.
- `promote-stage.sh` — promote the stage worktree (the stable serving copy) to
  the current `dev` tip. Manual, deliberate step, on the owner's explicit
  command only — this is the ONLY path that applies migrations to the live DB.
  It runs `rehearsal-gate.ts` first and stops if the pending series was never
  applied to a clone of live.
- `rehearsal-gate.ts` — refuses a promote whose schema change was not rehearsed
  on live's data: it checks the receipt the review stand leaves (which watermark
  the clone started from, which versions were applied on top, how long ago)
  instead of trusting that a rehearsal happened. Run it standalone to ask
  whether a promote would be allowed. Overridable only deliberately, with
  `ZM_SKIP_REHEARSAL_GATE=1`, which says what it is doing.
- `zm-cluster.sh` — the single tool for copying Postgres. `snapshot` takes an
  online physical base backup of the WHOLE live cluster into
  `$ZM_SNAPSHOT_DIR/<ISO>_zm-cluster.tar.gz` (live keeps serving);
  `clone-to-e2e [file]` and `clone-to-review [file]` restore one into the test
  or the review stack's data volume, taking a fresh snapshot first when no file
  is given (it refuses the live container as a target). Physical rather than logical
  on purpose: what arrives is what was there — every database, role, password
  and grant — with no ownership or privilege questions to get wrong. It
  restores whole and only into the same Postgres major version.

## Stack & data utilities

- `seed-env.ts` — seed `.env` files for every app so `bun dev` boots the stack.
- `zm-login.ts` — one-time OAuth login for repo-clone ingest clients.
- `reembed.ts` — recompute all stored vectors after an embedding-model change.
- `translate-pending.ts` — drain the language-canonicalization queue.
- `check-env-templates.ts` — lint the tracked `.env` templates for values that
  systemd, shells, compose and Bun would read differently (unquoted spaces,
  bare `$`); part of `bun run check` and the pre-commit hook.
- `scan-secrets.ts` — report-only retro-scan of the memory corpus for secrets.
- `search-eval.ts` — replay the ROI holdout questions against `search_memories`
  (hit@10 / MRR / reinforced share) and the brief-holdout probes against
  `build_context` (pack hit-rate / junk share); run before and after a ranking
  or briefing-recipe change.
- `urlencode-stdin.py` — percent-encode stdin for `postgresql://` URLs.

## Smoke tests

`smoke-mcp.ts` (remember → recall roundtrip), `smoke-team.ts` (two users over
HTTP + OAuth), `smoke-ingest.ts` (auto-population pipeline end to end).

## hooks/

TypeScript hook handlers used by this repo's own `.claude` wiring when
developing zero-memory from a clone. Consumers do not run these — they get the
equivalent hooks from the plugin / watcher binary via the deploy scripts in
[`plugin-bundle/`](plugin-bundle/).
