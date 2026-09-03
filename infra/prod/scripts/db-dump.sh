#!/usr/bin/env bash
# Logical backup of a database this deployment does NOT run itself — a managed
# (hosted) Supabase project, or any Postgres reached over the network.
#
#   infra/prod/scripts/db-dump.sh              take one, verify it, prune, mirror
#   infra/prod/scripts/db-dump.sh verify FILE  re-check an artifact taken earlier
#
# WHY THIS EXISTS NEXT TO scripts/zm-cluster.sh
#
# That tool takes a PHYSICAL base backup by exec'ing into the database
# container. With a managed project there is no container to exec into and no
# file-level access at all, so its procedure is not merely slower here — it is
# impossible. The platform owns the physical layer (its own backups and
# point-in-time recovery); what it cannot hand you is an artifact YOU hold and
# can restore elsewhere, including onto another provider. That is this one, and
# it is logical for that reason rather than by preference.
#
# WHAT THE ARTIFACT CONTAINS, AND WHAT IT DELIBERATELY DOES NOT
#
# Data only: the accounts (auth.users, auth.identities) and the application's
# own schemas (public, partitions). No schema, no roles, no extensions — those
# come back from the migration series, which is the same series CI applies and
# the only description of the schema that is ever reviewed. A dumped schema
# would be a second, unreviewed copy of it, and on the way back in it fights
# the platform's managed roles and ownership; the migrations do not.
#
# The consequence is a restore ORDER rather than a limitation: the target
# carries the schema first (`supabase db push`), and its service account is
# NOT provisioned beforehand — the accounts arrive with the artifact. See
# db-restore.sh, which enforces both.
#
# Environment:
#   SUPABASE_DB_URL   required. Postgres URL of the source. For a hosted
#                     project prefer the session-pooler URL: the direct
#                     connection is IPv6-only.
#   ZM_DUMP_DIR       where artifacts live      (default /var/backups/zero-memory)
#   ZM_DUMP_KEEP      artifacts to keep         (default 14)
#   ZM_DUMP_REMOTE    optional rsync target for the off-site copy, e.g.
#                     `u000000@u000000.example.com:zm/`
#   ZM_DUMP_SSH       ssh command rsync uses    (default `ssh`; add `-p`/`-i` here)
#   ZM_DUMP_PING_URL  optional URL pinged after a SUCCESSFUL run (dead-man
#                     switch: the monitor alarms when the ping stops arriving)
#   ZM_DUMP_PING_FAIL_URL
#                     optional URL pinged when a run FAILS. Without it a broken
#                     backup is only noticed when the dead-man window expires,
#                     which for a daily job means the better part of a day —
#                     and the failure is loudest at the moment it happens.
#                     Monitors usually expose it as the ping URL plus `/fail`.
#   PSQL_IMAGE        client image              (default supabase/postgres:17.6.1.136)
#   ZM_PG_LOCAL=1     use the host's own pg_dump/psql instead of that image
set -euo pipefail

dump_dir="${ZM_DUMP_DIR:-/var/backups/zero-memory}"
keep="${ZM_DUMP_KEEP:-14}"
PSQL_IMAGE="${PSQL_IMAGE:-supabase/postgres:17.6.1.136}"

# Markers, not just decoration: db-restore.sh splits the artifact on them so it
# can put the trigger-minted profiles back in order between the two halves.
SEG_ACCOUNTS='-- >>> zm-dump segment: accounts'
SEG_CORPUS='-- >>> zm-dump segment: corpus'

die() {
  echo "$*" >&2
  exit 1
}

# One EXIT trap for the whole script rather than one per function: it has to do
# two things that must not be separated — remove a half-written artifact, and
# tell the monitor the run failed. A trap installed inside take_dump would have
# replaced this one and lost the second half.
ZM_TMP=''
ZM_TMP_DIR=''
zm_running_dump=0

on_exit() {
  local rc=$?
  [ -z "$ZM_TMP_DIR" ] || rm -rf "$ZM_TMP_DIR"
  [ -z "$ZM_TMP" ] || rm -f "$ZM_TMP"
  if [ "$rc" != 0 ] && [ "$zm_running_dump" = 1 ] && [ -n "${ZM_DUMP_PING_FAIL_URL:-}" ]; then
    # Best effort by design: the run has already failed, and a monitor that
    # cannot be reached must not turn a bad backup into a confusing exit code.
    curl -fsS -m 10 "$ZM_DUMP_PING_FAIL_URL" >/dev/null 2>&1 ||
      echo "warning: failure ping to the monitor did not get through" >&2
  fi
  return "$rc"
}
trap on_exit EXIT

# The client must be at least as new as the server — pg_dump refuses to dump a
# newer one — and a host's own client is routinely older than a managed
# project's server (Ubuntu 24.04 ships 16, the project runs 17). Borrowing the
# pinned image makes one command work from the VM, from CI and from an
# operator's laptop, none of which need a Postgres installed. `--network host`
# is what lets a 127.0.0.1 rehearsal URL mean the same thing inside.
if [ "${ZM_PG_LOCAL:-0}" = "1" ]; then
  run_pg_dump() { pg_dump "$@"; }
  run_psql() { psql "$@"; }
else
  run_pg_dump() { docker run --rm --network host -i "$PSQL_IMAGE" pg_dump "$@"; }
  run_psql() { docker run --rm --network host -i "$PSQL_IMAGE" psql "$@"; }
fi

# Host and database only — the URL carries a password and this string reaches
# logs, the manifest and the operator's terminal.
db_host() {
  printf '%s' "${SUPABASE_DB_URL:-}" | sed -E 's#^[a-z+]+://[^@]*@##; s#\?.*$##'
}

# ------------------------------------------------------------- the artifact --

# Per-table row counts read back OUT OF THE FILE, not queried from the
# database. That is the whole point: the manifest then describes the artifact
# rather than the server it came from, so a restore can be checked against it
# exactly, and a dump that silently lost a table is caught here rather than on
# the day it is needed.
artifact_counts() {
  gzip -dc "$1" | awk '
    /^COPY /            { table = $2; rows = 0; in_copy = 1; next }
    in_copy && /^\\\.$/ { printf "%s\t%d\n", table, rows; in_copy = 0; next }
    in_copy             { rows++ }
  ' | sort
}

count_of() { # <counts-file> <table>
  awk -F'\t' -v t="$2" '$1 == t { print $2; found = 1 } END { if (!found) print 0 }' "$1"
}

verify_artifact() { # <file> [counts-file]
  local file="$1" counts="${2:-}" tmp_counts=''

  [ -s "$file" ] || die "$file is empty — aborting"
  # A truncated stream still gzips; only reading it back proves it is whole.
  gzip -t "$file" || die "$file failed its gzip integrity check"
  # pg_dump writes this line last. Its absence means the dump was cut off
  # mid-write — which the gzip check alone cannot tell you, because the
  # compressor is perfectly happy to have produced a valid, short file.
  gzip -dc "$file" | tail -20 | grep -q 'PostgreSQL database dump complete' ||
    die "$file has no completion trailer — the dump did not finish"

  if [ -z "$counts" ]; then
    tmp_counts="$(mktemp)"
    artifact_counts "$file" >"$tmp_counts"
    counts="$tmp_counts"
  fi

  # A backup that "succeeded" with an empty corpus is the failure mode worth
  # spending three queries on: it looks like a healthy file, prunes a good one
  # to make room, and is discovered only during a recovery.
  local table
  for table in auth.users public.profiles public.memories; do
    [ "$(count_of "$counts" "$table")" -gt 0 ] ||
      die "$file carries no rows for $table — refusing to call this a backup"
  done

  [ -z "$tmp_counts" ] || rm -f "$tmp_counts"
}

write_manifest() { # <file> <manifest> <counts-file> <watermark> <previous-total>
  local file="$1" manifest="$2" counts="$3" watermark="$4" prev_total="$5"
  local bytes sha total

  bytes="$(stat -c %s "$file")"
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  total="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$counts")"

  {
    printf '{\n'
    printf '  "artifact": "%s",\n' "$(basename "$file")"
    printf '  "taken_at": "%s",\n' "$(date -Is)"
    printf '  "source": "%s",\n' "$(db_host)"
    printf '  "schema_watermark": "%s",\n' "$watermark"
    printf '  "bytes": %s,\n' "$bytes"
    printf '  "sha256": "%s",\n' "$sha"
    printf '  "rows_total": %s,\n' "$total"
    printf '  "rows_total_previous": %s,\n' "${prev_total:-0}"
    printf '  "tables": {\n'
    awk -F'\t' 'NR > 1 { printf ",\n" } { printf "    \"%s\": %d", $1, $2 }' "$counts"
    printf '\n  }\n'
    printf '}\n'
  } >"$manifest"

  # Not a failure: a large deletion is legitimate and a backup job is the wrong
  # place to veto one. But an unexplained collapse is exactly what nobody
  # notices until a restore, so it is said out loud and recorded in the file.
  if [ "${prev_total:-0}" -gt 0 ] && [ "$total" -lt "$((prev_total * 4 / 5))" ]; then
    echo "warning: row count fell from $prev_total to $total since the previous artifact" >&2
  fi
}

newest_manifest_total() {
  local newest
  newest="$(ls -1t "$dump_dir"/*_zm-data.manifest.json 2>/dev/null | head -1 || true)"
  [ -n "$newest" ] || { echo 0; return; }
  grep -m1 '"rows_total"' "$newest" | tr -dc '0-9' || echo 0
}

take_dump() {
  : "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (session-pooler URL for hosted projects)}"
  mkdir -p "$dump_dir"
  # From here on a non-zero exit is a failed BACKUP, which is what the monitor
  # must hear about — as opposed to a bad argument or a missing variable.
  zm_running_dump=1

  local stamp file manifest prev_total watermark
  # ISO-8601 to the minute, timestamp first so a lexical sort is chronological;
  # `-` for the time separator because a colon breaks scp/rsync targets.
  stamp="$(date +%Y-%m-%dT%H-%M)"
  file="$dump_dir/${stamp}_zm-data.sql.gz"
  manifest="$dump_dir/${stamp}_zm-data.manifest.json"
  prev_total="$(newest_manifest_total)"

  # Deliberately NOT `local`: the EXIT trap runs after this frame is gone, and
  # a trap referring to a local dies with "unbound variable" under `set -u`.
  ZM_TMP_DIR="$(mktemp -d)"
  ZM_TMP="$file.partial"

  echo "→ source: $(db_host)"
  watermark="$(run_psql "$SUPABASE_DB_URL" -tAqc \
    "select coalesce(max(version), 'none') from supabase_migrations.schema_migrations" | tr -d '[:space:]')"
  echo "  schema watermark: $watermark"

  # ORDER, and it is not the order pg_dump would pick. A data-only dump is
  # written in name order, not dependency order, so `auth.identities` would
  # land ahead of the `auth.users` rows its foreign key points at, and the
  # accounts would refuse to load. Hence one pass per auth table, users first.
  #
  # The corpus is READ FIRST and WRITTEN LAST: an account created while the
  # corpus was being read is still captured by the later account passes,
  # whereas the opposite order would put rows in the file with no account to
  # own them. db-restore.sh checks for exactly that (orphaned profiles).
  echo "→ corpus (public, partitions)…"
  # The monthly usage_events partitions live in their own schema and a restore
  # target only ever has the months its own runtime created. Emit the missing
  # structure ahead of the data, or the load fails on the first month the
  # target never saw.
  run_psql "$SUPABASE_DB_URL" -tAqc \
    "select 'create table if not exists '||c.oid::regclass||
            ' partition of public.usage_events '||pg_get_expr(c.relpartbound, c.oid)||';'
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'partitions' and c.relispartition
     order by c.relname" >"$ZM_TMP_DIR/corpus.sql"
  run_pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges \
    --schema=public --schema=partitions >>"$ZM_TMP_DIR/corpus.sql"

  echo "→ accounts (auth.users, auth.identities)…"
  run_pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges \
    --table=auth.users >"$ZM_TMP_DIR/accounts.sql"
  run_pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges \
    --table=auth.identities >>"$ZM_TMP_DIR/accounts.sql"

  {
    printf -- '-- zero-memory logical backup (data only; the schema comes from the migration series)\n'
    printf -- '-- taken:     %s\n' "$(date -Is)"
    printf -- '-- source:    %s\n' "$(db_host)"
    printf -- '-- watermark: %s\n' "$watermark"
    printf -- '-- restore:   infra/prod/scripts/db-restore.sh <this file>\n'
    printf -- '%s\n' "$SEG_ACCOUNTS"
    cat "$ZM_TMP_DIR/accounts.sql"
    printf -- '%s\n' "$SEG_CORPUS"
    cat "$ZM_TMP_DIR/corpus.sql"
  } | gzip >"$ZM_TMP"

  local counts total
  counts="$ZM_TMP_DIR/counts.tsv"
  artifact_counts "$ZM_TMP" >"$counts"
  verify_artifact "$ZM_TMP" "$counts"
  total="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$counts")"

  mv "$ZM_TMP" "$file"
  # The artifact is now the real file: clear what the exit trap would delete,
  # rather than disarming the trap — it still owes the monitor a failure ping
  # for anything that goes wrong in the steps below.
  ZM_TMP=''
  write_manifest "$file" "$manifest" "$counts" "$watermark" "$prev_total"
  rm -rf "$ZM_TMP_DIR"
  ZM_TMP_DIR=''

  echo "✓ $file ($(du -h "$file" | cut -f1), $total rows)"
  echo "  manifest: $manifest"

  prune
  mirror_offsite
  ping_deadman
}

# ------------------------------------------------------------- housekeeping --

prune() {
  echo "→ pruning (keeping last $keep)…"
  # The manifest is pruned with its artifact, never on its own: a manifest with
  # no file describes nothing, and a file with no manifest cannot be verified.
  ls -1t "$dump_dir"/*_zm-data.sql.gz 2>/dev/null |
    tail -n +"$((keep + 1))" |
    while IFS= read -r old; do
      rm -f -- "$old" "${old%.sql.gz}.manifest.json"
      echo "· pruned $old"
    done
}

mirror_offsite() {
  [ -n "${ZM_DUMP_REMOTE:-}" ] || return 0
  command -v rsync >/dev/null 2>&1 ||
    die "ZM_DUMP_REMOTE is set but rsync is not installed on this host"

  echo "→ mirroring the retention window off-site…"
  # A mirror, deliberately: the remote holds the same window this host does, so
  # retention is expressed once. The price is that a bad local prune — or an
  # attacker with this host — propagates. Cover it on the remote side with
  # provider snapshots of the storage target, not by keeping stale copies here.
  rsync -a --delete-after --partial -e "${ZM_DUMP_SSH:-ssh}" \
    --include='*_zm-data.sql.gz' --include='*_zm-data.manifest.json' --exclude='*' \
    "$dump_dir/" "$ZM_DUMP_REMOTE"
  echo "  off-site copy: $ZM_DUMP_REMOTE"
}

ping_deadman() {
  [ -n "${ZM_DUMP_PING_URL:-}" ] || return 0
  # Pinged only on the success path, and a failed ping never fails the job: the
  # backup is already on disk, and the monitor alarming is the correct outcome
  # of a ping that cannot be delivered.
  curl -fsS -m 10 "$ZM_DUMP_PING_URL" >/dev/null ||
    echo "warning: dead-man ping to the monitor failed" >&2
}

# --------------------------------------------------------------------- main --

case "${1:-}" in
  '' | dump)
    take_dump
    ;;
  verify)
    file="${2:-}"
    [ -n "$file" ] || die "usage: db-dump.sh verify <artifact.sql.gz>"
    [ -f "$file" ] || die "no such artifact: $file"
    # Reuses the script-wide exit trap for cleanup: `verify` never sets
    # zm_running_dump, so a failure here reports to the operator reading it,
    # not to the monitor watching the nightly job.
    ZM_TMP_DIR="$(mktemp -d)"
    counts="$ZM_TMP_DIR/counts.tsv"
    artifact_counts "$file" >"$counts"
    verify_artifact "$file" "$counts"
    echo "✓ $file is whole"
    manifest="${file%.sql.gz}.manifest.json"
    if [ -f "$manifest" ]; then
      # The manifest is only evidence if it is checked against the bytes on
      # disk; a copy that silently changed passes every structural test above.
      recorded="$(grep -m1 '"sha256"' "$manifest" | cut -d'"' -f4)"
      actual="$(sha256sum "$file" | cut -d' ' -f1)"
      [ "$recorded" = "$actual" ] ||
        die "sha256 mismatch: manifest says $recorded, file is $actual"
      echo "✓ sha256 matches its manifest"
    else
      echo "  (no manifest next to it — row counts below are unverified)"
    fi
    awk -F'\t' '{ printf "  %-32s %8d\n", $1, $2 }' "$counts"
    ;;
  *)
    cat >&2 <<USAGE
usage: infra/prod/scripts/db-dump.sh [dump|verify <file>]

  dump           take an artifact, verify it, prune, mirror off-site (default)
  verify <file>  re-check an artifact taken earlier, against its manifest

  Needs SUPABASE_DB_URL for a dump; \`verify\` reads the file alone.
USAGE
    exit 2
    ;;
esac
