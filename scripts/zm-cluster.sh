#!/usr/bin/env bash
# The single tool for copying this project's Postgres: one physical snapshot
# of the whole cluster, and the restore of that snapshot into another stack.
#
#   scripts/zm-cluster.sh snapshot               # snapshot the live cluster
#   scripts/zm-cluster.sh clone-to-e2e [file]    # restore one into the test stack
#   scripts/zm-cluster.sh clone-to-review [file] # restore one into the review stack
#
# WHY PHYSICAL, AND WHY ONE TOOL
#
# This replaces the earlier pair of logical (pg_dump/pg_restore) scripts. A
# logical copy rebuilds the database object by object as the connecting role,
# so it inherits every question about ownership, grants and role privileges —
# and answers them differently on every stack. That cost three separate
# failures in one afternoon: the auth schema silently not copying because the
# restoring role was not superuser; objects that existed only on the target
# surviving a "clone" because --clean drops only what the dump contains; and
# `permission denied for schema public` after the database was recreated
# under a different owner.
#
# A base backup sidesteps all of it. It copies the cluster's files, so what
# arrives is what was there — every database, every role, every password,
# every grant — with nothing to reason about. It is also a FULL cluster
# snapshot rather than one project's database, which is what a snapshot
# should mean.
#
# TRADE-OFF, STATED PLAINLY
#
# A physical snapshot restores whole and only into the same Postgres major
# version. It cannot restore a single table. If you ever need "undo one bad
# DELETE", take a logical dump of that table at that moment — this tool is
# for whole-cluster snapshots and clones, deliberately.
#
# Environment (all optional):
#   ZM_SNAPSHOT_DIR   where snapshots live   (default .snapshots, gitignored)
#   ZM_SNAPSHOT_KEEP  snapshots to keep      (default 14)
#   LIVE_DB           live db container      (default supabase_db_zero-memory)
#   E2E_DB            test db container      (default supabase_db_zero-memory-e2e)
#   REVIEW_DB         review db container    (default supabase_db_zero-memory-review)
set -euo pipefail
cd "$(dirname "$0")/.."

snapshot_dir="${ZM_SNAPSHOT_DIR:-.snapshots}"
keep="${ZM_SNAPSHOT_KEEP:-14}"
LIVE_DB="${LIVE_DB:-supabase_db_zero-memory}"
E2E_DB="${E2E_DB:-supabase_db_zero-memory-e2e}"
REVIEW_DB="${REVIEW_DB:-supabase_db_zero-memory-review}"

die() {
  echo "$*" >&2
  exit 1
}

require_container() {
  docker inspect "$1" >/dev/null 2>&1 ||
    die "container $1 is not running (stand it up: cd tests/e2e && bun run ${2:-e2e:stack})"
}

# A base backup opens a REPLICATION connection, and pg_hba treats that as its
# own database class: the `all` keyword deliberately does not cover it, so a
# stock Supabase stack refuses one even over the local socket. Add the line if
# missing and reload — additive, no restart, no downtime, and idempotent so a
# stack that regenerates its config self-heals on the next run.
ensure_replication_allowed() {
  local hba='/etc/postgresql/pg_hba.conf'
  if docker exec "$LIVE_DB" grep -qE '^[[:space:]]*local[[:space:]]+replication' "$hba"; then
    return
  fi
  echo "→ allowing local replication connections (pg_hba, additive + reload)…"
  docker exec "$LIVE_DB" sh -c \
    "printf 'local replication all peer map=supabase_map\n' >> $hba"
  docker exec "$LIVE_DB" psql -U postgres -d postgres -qAt \
    -c 'select pg_reload_conf();' >/dev/null
}

# ---------------------------------------------------------------- snapshot --

take_snapshot() {
  require_container "$LIVE_DB"
  mkdir -p "$snapshot_dir"

  # ISO-8601 to the minute, timestamp first so a lexical sort is chronological.
  # `-` for the time separator: a colon is legal on Linux but breaks scp/rsync
  # targets and anything that ever touches Windows.
  local stamp file
  stamp="$(date +%Y-%m-%dT%H-%M)"
  file="$snapshot_dir/${stamp}_zm-cluster.tar.gz"
  # Deliberately NOT `local`: the EXIT trap runs after this frame is gone, and
  # a trap referring to a local dies with "unbound variable" under `set -u`.
  ZM_TMP="$file.partial"
  trap 'rm -f "${ZM_TMP:-}"' EXIT

  ensure_replication_allowed

  echo "→ base backup of the live cluster ($LIVE_DB)…"
  # Runs INSIDE the container over the local socket: peer auth maps the
  # postgres OS user to the postgres role, which carries REPLICATION, so no
  # pg_hba entry for replication over TCP is needed and no password travels.
  #
  # `-D -` streams a single tar to stdout (valid with -Ft, and with -Xf the
  # WAL needed for consistency is folded into that same tar) — so one command
  # yields one self-contained file. The live cluster keeps serving throughout;
  # this is an online base backup, not a stop-the-world copy.
  docker exec -u postgres "$LIVE_DB" \
    pg_basebackup -U postgres -D - -Ft -Xf --checkpoint=fast |
    gzip >"$ZM_TMP"

  [ -s "$ZM_TMP" ] || die "snapshot is empty — aborting"
  # A truncated stream still gzips; only reading it back proves it is whole.
  gzip -t "$ZM_TMP" || die "snapshot failed its integrity check — aborting"
  # The listing is materialised rather than piped into `grep -q`: grep exits at
  # the first match, tar takes SIGPIPE, and under `set -o pipefail` that reads
  # as a failed pipeline — the check would reject every healthy snapshot.
  local listing
  listing="$(tar tzf "$ZM_TMP")" || die "snapshot is not a readable archive"
  printf '%s\n' "$listing" | grep -q '^backup_label$' ||
    die "snapshot has no backup_label — not a usable base backup"

  mv "$ZM_TMP" "$file"
  trap - EXIT
  echo "✓ $file ($(du -h "$file" | cut -f1))"

  echo "→ pruning (keeping last $keep)…"
  ls -1t "$snapshot_dir"/*_zm-cluster.tar.gz 2>/dev/null |
    tail -n +"$((keep + 1))" |
    while IFS= read -r old; do
      rm -f -- "$old"
      echo "· pruned $old"
    done

  SNAPSHOT_FILE="$file"
}

# ---------------------------------------------------------------- clone-to --

# Restores a snapshot into ANOTHER stack's cluster. The target is an argument
# rather than a constant because two stacks legitimately take a clone: the test
# stack (a one-off rehearsal on real data) and the review stack (the stand
# acceptance happens on). Nothing here can address the live cluster — the
# callable targets are the two named commands at the bottom.
#
#   $1  target db container
#   $2  the `bun run` command that stands that target up, for the error message
#   $3  snapshot file; empty means "take a fresh one first"
clone_into() {
  local target="$1" up_hint="$2" file="${3:-}"
  if [ -z "$file" ]; then
    take_snapshot
    file="$SNAPSHOT_FILE"
  fi
  [ -f "$file" ] || die "no such snapshot: $file"
  [ "$target" != "$LIVE_DB" ] ||
    die "refusing to restore into the live cluster ($LIVE_DB)"
  require_container "$target" "$up_hint"

  local image volume
  image="$(docker inspect "$target" --format '{{.Config.Image}}')"
  volume="$(docker inspect "$target" \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')"
  [ -n "$volume" ] || die "could not find the data volume of $target"

  echo "→ stopping $target…"
  docker stop "$target" >/dev/null

  # Unpacking happens in a throwaway container holding the volume, because the
  # target container is stopped and its files must be replaced wholesale. The
  # data directory must end up owned by postgres and mode 700, or the server
  # refuses to start.
  echo "→ replacing the target's data directory from the snapshot…"
  docker run --rm \
    -v "$volume:/target" \
    -v "$(cd "$(dirname "$file")" && pwd):/snapshot:ro" \
    --entrypoint bash "$image" -c "
      set -euo pipefail
      find /target -mindepth 1 -delete
      tar xzf '/snapshot/$(basename "$file")' -C /target
      chown -R postgres:postgres /target
      chmod 700 /target
    "

  echo "→ starting $target…"
  docker start "$target" >/dev/null

  echo "→ waiting for the cluster to accept connections…"
  local i
  for i in $(seq 1 60); do
    if docker exec "$target" pg_isready -U postgres -q 2>/dev/null; then break; fi
    [ "$i" -lt 60 ] || die "cluster did not come up — check: docker logs $target"
    sleep 1
  done

  # The stack's other services reconnect on their own, but Kong caches
  # upstream resolution and needs a nudge — the same bounce run-e2e.ts does
  # after a db reset.
  docker restart "supabase_kong_${target#supabase_db_}" >/dev/null 2>&1 || true

  local memories users orphans version
  memories="$(psql_target "$target" 'select count(*) from public.memories')"
  users="$(psql_target "$target" 'select count(*) from auth.users')"
  orphans="$(psql_target "$target" 'select count(*) from public.profiles p where not exists (select 1 from auth.users u where u.id = p.user_id)')"
  version="$(psql_target "$target" 'select max(version) from supabase_migrations.schema_migrations')"

  # A count alone would not catch the failure this replaced: live data next to
  # the target's own accounts, every profile orphaned. Identity is what makes
  # a clone a clone.
  [ "${orphans:-1}" = "0" ] ||
    die "clone verification failed: $orphans profile(s) have no auth user"

  echo "✓ $target now carries the live cluster: $memories memories, $users users, schema at $version"

  # The test stack resets its database at the start of every suite run, so a
  # clone placed there is gone the moment anyone runs the tests. That is fine for
  # a restore drill and wrong for a stand someone is meant to look at — say so
  # here rather than leaving it to be rediscovered.
  if [ "$target" = "$E2E_DB" ]; then
    echo "  NOTE: the next suite run resets this stack back to migrations + fixtures."
    echo "  For a stand that keeps its clone: cd tests/e2e && bun run review:stack"
  fi
}

psql_target() {
  docker exec "$1" psql -U postgres -d postgres -tAc "$2" 2>/dev/null || echo ""
}

# ------------------------------------------------------------------- main ---

case "${1:-}" in
  snapshot) take_snapshot ;;
  clone-to-e2e) clone_into "$E2E_DB" 'e2e:stack' "${2:-}" ;;
  clone-to-review) clone_into "$REVIEW_DB" 'review:stack' "${2:-}" ;;
  *)
    cat >&2 <<USAGE
usage: scripts/zm-cluster.sh <command>

  snapshot                take a physical snapshot of the whole live cluster
  clone-to-e2e [file]     restore a snapshot into the test stack
  clone-to-review [file]  restore a snapshot into the review stack
                          (with no file, either takes a fresh snapshot first)

  After a clone, bring the target's schema up to the working tree with
  \`bunx supabase migration up --workdir <the stack's workdir>\`; the review
  stand's launcher does that step itself.
USAGE
    exit 2
    ;;
esac
