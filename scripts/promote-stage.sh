#!/usr/bin/env bash
# Promote the stage worktree to the current dev tip — MANUAL, deliberate step.
#
# Stage is the stable serving copy (no --watch): the MCP server, watcher and
# dashboard your clients depend on. The dev checkout is for active development
# and may break at any time. Run this only when dev has reached a point you
# consider stable enough to serve.
#
# Branch policy (current): stage tracks `dev`. `main` is FROZEN at the shipped
# production-readiness milestone and advances only on a planned release
# (`scripts/promote-stage.sh <dir> main` after a deliberate dev -> main merge).
#
# Usage: scripts/promote-stage.sh [stage-dir] [ref]
#   stage-dir  defaults to the linked worktree holding the `stage` branch
#   ref        defaults to dev
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# The serving checkout is a local, untracked worktree whose location is the
# operator's choice, so it is discovered rather than hardcoded: it is the linked
# worktree that has the `stage` branch checked out. Pass a directory explicitly
# to promote some other checkout.
discover_stage() {
  git -C "$root" worktree list --porcelain | awk '
    /^worktree /            { path = substr($0, 10) }
    /^branch refs\/heads\/stage$/ { print path; exit }
  '
}

stage="${1:-$(discover_stage)}"
ref="${2:-dev}"

[ -n "$stage" ] || {
  echo "no worktree has the 'stage' branch checked out — pass its directory" >&2
  exit 1
}

[ -d "$stage/.git" ] || [ -f "$stage/.git" ] || {
  echo "stage worktree not found at $stage" >&2
  exit 1
}

echo "→ promoting stage ($stage) to $ref…"
# Fast-forward in steady state (stage on the tracked branch's line). If the
# tracked branch changed (e.g. stage was pinned to a frozen main and now
# follows dev), the target isn't a descendant — reset instead. Safe: stage is a
# serving pointer, and its .env/.next are gitignored, so nothing local is lost.
if ! git -C "$stage" merge --ff-only "$ref" 2>/dev/null; then
  echo "  (not a fast-forward — resetting stage to $ref)"
  git -C "$stage" reset --hard "$ref"
fi

echo "→ installing deps…"
(cd "$stage" && bun install)

echo "→ pre-promote rehearsal gate…"
# Fail-closed, and BEFORE the snapshot so a refusal costs nothing: a schema
# change reaches the serving database only if the same pending series was first
# applied to a physical clone of live. The test stack cannot substitute — it
# resets from empty, so nothing there can contradict a migration the way real
# data does. The gate reads the receipt the review contour leaves and checks it
# (starting watermark, coverage, age) rather than trusting that it exists.
# Migrations are compared against the STAGE tree, since that is what gets applied.
(cd "$root" && bun scripts/rehearsal-gate.ts "$stage/supabase/migrations")

echo "→ snapshotting the live cluster BEFORE any schema change…"
# Unconditional and fail-closed: the serving database is never migrated without
# a fresh, restorable snapshot taken first. `set -e` aborts the promote if the
# snapshot fails, so "no backup" can never silently become "migrate anyway" —
# whatever the migration does next, there is always a point to restore to. A
# promote is rare and deliberate, so the cost of an always-on snapshot is paid
# gladly. Restore with: scripts/zm-cluster.sh clone-to-review <file> (or, for live,
# the documented restore path in infra/prod/RUNBOOK.md).
"$root/scripts/zm-cluster.sh" snapshot

echo "→ applying migrations to the local stack…"
# A failed migration MUST abort the promote. `set -e` above does that only if
# the failure is not swallowed — so no `|| true`, no `2>/dev/null`, and no
# `db push` fallback that would apply the series by another path and mask the
# very failure we need to see. Building and serving on a schema that did not
# advance is exactly how a broken promote looks healthy: the earlier form
# printed "Done" over a migration that had errored out.
(cd "$stage" && bunx supabase migration up)
# Diagnostics only — this must not fail the promote after the migrations have
# already applied, but its own errors stay visible (no 2>/dev/null).
(cd "$stage" && bunx supabase migration list | tail -5) || echo "  (could not list migrations)"

echo "→ building web…"
# --ui=stream: the repo defaults turbo to the interactive TUI (turbo.json
# "ui": "tui"), which needs a TTY and stalls a scripted/non-interactive promote.
# Force plain streaming output so this step runs unattended.
(cd "$stage" && bunx turbo run build --filter=web --ui=stream)

cat <<'EOS'

Done. Now restart the stage services in their terminal:
  cd <stage-dir> && bun run start
(server :8787 + watcher + web :3100, no --watch — stable until the next promote)
EOS
