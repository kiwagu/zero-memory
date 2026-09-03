#!/usr/bin/env bash
# Apply the pending tail of the migration series to a provisioned database —
# strictly forward, with the bookkeeping the Supabase CLI expects.
#
#   SUPABASE_DB_URL=<target> infra/prod/scripts/db-forward-apply.sh [pending]
#
# With the `pending` argument it only PRINTS the pending file names (one per
# line, nothing else on stdout) and exits — the caller's way to ask "is there
# anything to do" before taking a pre-schema dump. All checks still run.
#
# WHY THIS EXISTS NEXT TO db-provision.sh
#
# Provisioning runs `supabase db push` from an operator machine, where bun is
# a documented requirement. The deployment HOST has no bun and the CLI ships
# no official container image, so a deploy that manages its own schema needs
# a vehicle that is already on the host: the same dockerized psql the daily
# backup uses. What the CLI would do is restated here explicitly — and more
# strictly: any divergence between the applied history and the checked-out
# series refuses the run instead of being waved through with a flag.
#
# Scope: applies the PENDING TAIL only. A database with no migration
# bookkeeping at all is not this script's job — that is first-time
# provisioning, done from an operator machine (db-provision.sh).
#
# Each migration file runs inside ONE transaction TOGETHER with its
# bookkeeping insert, so a crash mid-apply leaves either both or neither —
# a recorded-but-unapplied (or applied-but-unrecorded) version cannot occur.
# The series is transaction-safe by standing convention: no CONCURRENTLY, no
# statements that refuse a transaction block (the two index-rebuild
# migrations state this explicitly).
#
# Environment:
#   SUPABASE_DB_URL     required. Postgres URL of the target. For a hosted
#                       project prefer the session-pooler URL: the direct
#                       connection is IPv6-only.
#   ZM_MIGRATIONS_DIR   migration series to apply (default supabase/migrations)
#   PSQL_IMAGE          client image (default supabase/postgres:17.6.1.136)
#   ZM_PG_LOCAL=1       use the host's own psql instead of that image
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (session-pooler URL for hosted projects)}"
mode="${1:-apply}"
case "$mode" in apply|pending) ;; *) echo "usage: db-forward-apply.sh [pending]" >&2; exit 2 ;; esac
migrations_dir="${ZM_MIGRATIONS_DIR:-supabase/migrations}"
PSQL_IMAGE="${PSQL_IMAGE:-supabase/postgres:17.6.1.136}"

die() {
  echo "$*" >&2
  exit 1
}

if [ "${ZM_PG_LOCAL:-}" = "1" ]; then
  run_psql() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"; }
else
  run_psql() {
    docker run --rm --network host -i "$PSQL_IMAGE" \
      psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"
  }
fi

[ -d "$migrations_dir" ] || die "no such migrations dir: $migrations_dir"

# --- local inventory ----------------------------------------------------------
# <14-digit version>_<name>.sql only; anything else in the directory is not a
# migration and is announced rather than silently skipped.
local_versions=()
for f in "$migrations_dir"/*.sql; do
  [ -e "$f" ] || break
  base="$(basename "$f")"
  if printf '%s' "$base" | grep -Eq '^[0-9]{14}_.+\.sql$'; then
    local_versions+=("${base%%_*}")
  else
    # stderr: `pending` mode promises a stdout of file names only.
    echo "  skipping non-migration file: $base" >&2
  fi
done
[ "${#local_versions[@]}" -gt 0 ] || die "no migrations found in $migrations_dir"

# --- applied history ----------------------------------------------------------
# `</dev/null` is load-bearing: the client runs under `docker run -i` and
# would otherwise swallow this script's stdin.
remote_versions="$(run_psql -tA -c \
  'select version from supabase_migrations.schema_migrations order by version' \
  </dev/null)" \
  || die "cannot read supabase_migrations.schema_migrations — is this database provisioned?"
[ -n "$remote_versions" ] \
  || die "empty migration history: first-time provisioning is db-provision.sh's job, from an operator machine"

# --- forward-only checks ------------------------------------------------------
# 1. Every applied version must exist in the checkout: a version the series
#    no longer carries means the histories diverged — refuse, never guess.
for v in $remote_versions; do
  found=""
  for l in "${local_versions[@]}"; do
    [ "$l" = "$v" ] && { found=1; break; }
  done
  [ -n "$found" ] || die "history diverged: $v is applied but absent from $migrations_dir"
done

watermark="$(printf '%s\n' $remote_versions | sort | tail -1)"

# 2. Pending = local versions not yet applied — and every one of them must be
#    NEWER than the watermark. An unapplied file behind the watermark is the
#    out-of-order case `supabase db push` hides behind --include-all; here it
#    is a refusal.
pending=()
for f in "$migrations_dir"/*.sql; do
  base="$(basename "$f")"
  printf '%s' "$base" | grep -Eq '^[0-9]{14}_.+\.sql$' || continue
  v="${base%%_*}"
  applied=""
  for r in $remote_versions; do
    [ "$r" = "$v" ] && { applied=1; break; }
  done
  [ -n "$applied" ] && continue
  [ "$v" \> "$watermark" ] \
    || die "out-of-order migration: $base is unapplied but not newer than the watermark $watermark"
  pending+=("$f")
done

if [ "$mode" = "pending" ]; then
  for f in "${pending[@]+"${pending[@]}"}"; do basename "$f"; done
  exit 0
fi

if [ "${#pending[@]}" -eq 0 ]; then
  echo "✓ schema current at $watermark — nothing to apply"
  exit 0
fi

echo "→ pending migrations (watermark $watermark):"
for f in "${pending[@]}"; do echo "    $(basename "$f")"; done

# --- apply --------------------------------------------------------------------
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
for f in "${pending[@]}"; do
  base="$(basename "$f")"
  version="${base%%_*}"
  name="${base#*_}"; name="${name%.sql}"
  # The file content becomes the bookkeeping `statements` entry via dollar
  # quoting; the tag collision below has never occurred in a real series and
  # failing on it beats corrupting the insert.
  grep -q '\$zm_migration\$' "$f" \
    && die "cannot record $base: content contains the quoting tag"
  {
    echo 'begin;'
    cat "$f"
    printf '\ninsert into supabase_migrations.schema_migrations (version, name, statements)\n'
    printf "values ('%s', '%s', array[\$zm_migration\$" "$version" "$name"
    cat "$f"
    printf '$zm_migration$]);\ncommit;\n'
  } > "$tmp"
  echo "→ applying $base"
  run_psql -q -f - < "$tmp" || die "failed on $base — deploy must not proceed"
done

# --- verify -------------------------------------------------------------------
new_watermark="$(run_psql -tA -c \
  'select max(version) from supabase_migrations.schema_migrations' </dev/null)"
want="$(printf '%s\n' "${local_versions[@]}" | sort | tail -1)"
[ "$new_watermark" = "$want" ] \
  || die "verification failed: watermark $new_watermark, series ends at $want"
echo "✓ schema advanced to $new_watermark (${#pending[@]} applied)"
