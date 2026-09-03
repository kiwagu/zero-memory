#!/usr/bin/env bash
# Load an artifact taken by db-dump.sh into a target database, and prove it
# arrived. The companion of that script; read its header first — the artifact
# is data only, so the ORDER below is not advice but a requirement.
#
#   SUPABASE_DB_URL=<target> ZM_RESTORE_YES=1 \
#     infra/prod/scripts/db-restore.sh /var/backups/zero-memory/<stamp>_zm-data.sql.gz
#
# THE TARGET, IN ORDER
#
#   1. a database carrying the SCHEMA and nothing else — `supabase db push
#      --db-url <target>` applies the same migration series CI does;
#   2. NO service account yet. Do not run db-provision.sh's account step first:
#      the accounts arrive inside the artifact, and a pre-existing one collides
#      with the row that is about to be restored. This script refuses to start
#      when the target already has users, rather than half-loading;
#   3. this script;
#   4. only then anything that creates accounts.
#
# WHY IT LIFTS FOREIGN KEYS RATHER THAN DISABLING TRIGGERS
#
# A data-only load meets rows before the rows they point at — the usual
# remedies (`pg_dump --disable-triggers`, `session_replication_role`) need
# superuser, which a managed project's `postgres` role is NOT. What it does
# have is ownership of these tables, so the constraints come off and go back on
# by our own authority, and re-adding them VALIDATES: the load proves itself.
#
# Everything runs as ONE transaction. A failure anywhere leaves the target
# exactly as it was, instead of a half-filled corpus nobody can reason about.
#
# Environment:
#   SUPABASE_DB_URL   required. Postgres URL of the TARGET (session pooler for
#                     a hosted project — the direct connection is IPv6-only).
#   ZM_RESTORE_YES=1  required. This writes to whatever that URL points at.
#   PSQL_IMAGE        client image (default supabase/postgres:17.6.1.136)
#   ZM_PG_LOCAL=1     use the host's own psql instead of that image
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
PSQL_IMAGE="${PSQL_IMAGE:-supabase/postgres:17.6.1.136}"
SEG_ACCOUNTS='-- >>> zm-dump segment: accounts'
SEG_CORPUS='-- >>> zm-dump segment: corpus'

die() {
  echo "$*" >&2
  exit 1
}

if [ "${ZM_PG_LOCAL:-0}" = "1" ]; then
  run_psql() { psql "$@"; }
else
  run_psql() { docker run --rm --network host -i "$PSQL_IMAGE" psql "$@"; }
fi

db_host() {
  printf '%s' "${SUPABASE_DB_URL:-}" | sed -E 's#^[a-z+]+://[^@]*@##; s#\?.*$##'
}

query() { # <sql> — one scalar
  # `</dev/null` is load-bearing: the client runs under `docker run -i`, which
  # reads stdin, and this function is called from a `while read` loop — without
  # it the first query swallows the rest of the loop's input and the
  # verification silently checks one table instead of all of them.
  run_psql "$SUPABASE_DB_URL" -tAqc "$1" </dev/null | tr -d '[:space:]'
}

file="${1:-}"
[ -n "$file" ] || die "usage: db-restore.sh <artifact.sql.gz>"
[ -f "$file" ] || die "no such artifact: $file"
: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (the TARGET database)}"
[ "${ZM_RESTORE_YES:-0}" = "1" ] ||
  die "refusing to write to $(db_host) without ZM_RESTORE_YES=1"

# ------------------------------------------------------------- preflight --

echo "→ verifying the artifact before touching anything"
"$here/db-dump.sh" verify "$file" >/dev/null ||
  die "the artifact did not pass its own integrity check — do not restore it"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gzip -dc "$file" >"$tmp/artifact.sql"
awk -v a="$SEG_ACCOUNTS" -v c="$SEG_CORPUS" '
  $0 == a { seg = "accounts"; next }
  $0 == c { seg = "corpus";   next }
  seg == "accounts" { print > (out_a) }
  seg == "corpus"   { print > (out_c) }
' out_a="$tmp/accounts.sql" out_c="$tmp/corpus.sql" "$tmp/artifact.sql"
[ -s "$tmp/accounts.sql" ] && [ -s "$tmp/corpus.sql" ] ||
  die "the artifact carries no segment markers — it predates this restore path"

# Per-table counts of the artifact, the oracle every check below compares to.
awk '
  /^COPY /            { table = $2; rows = 0; in_copy = 1; next }
  in_copy && /^\\\.$/ { printf "%s\t%d\n", table, rows; in_copy = 0; next }
  in_copy             { rows++ }
' "$tmp/artifact.sql" | sort >"$tmp/expected.tsv"

artifact_watermark="$(sed -n 's/^-- watermark: *//p' "$tmp/artifact.sql" | head -1 | tr -d '[:space:]')"
target_watermark="$(query "select coalesce(max(version), 'none') from supabase_migrations.schema_migrations")"

echo "→ target:   $(db_host)"
echo "  schema:   $target_watermark (artifact was taken at $artifact_watermark)"
echo "  currently: $(query 'select count(*) from public.memories') memories, $(query 'select count(*) from auth.users') users"

# Same schema or the load is a guess. A newer target may well accept the data,
# but "may well" is not something a recovery should rest on: bring the target
# to the artifact's watermark with the migration series, then restore.
[ "$artifact_watermark" = "$target_watermark" ] ||
  die "schema mismatch: artifact at $artifact_watermark, target at $target_watermark.
Apply the matching migration series first: bunx supabase db push --db-url <target>"

users_present="$(query 'select count(*) from auth.users')"
[ "$users_present" = "0" ] || die "the target already has $users_present account(s).
The accounts arrive with the artifact, so a pre-existing one collides with the
row about to be restored. Restore into a schema-only target — provision the
service account afterwards, or not at all when the artifact already carries it."

# --------------------------------------------------------------- the load --

echo "→ composing the load (foreign keys lifted, one transaction)"
run_psql "$SUPABASE_DB_URL" -tAqc \
  "select 'alter table '||conrelid::regclass||' drop constraint if exists '||quote_ident(conname)||';'
   from pg_constraint where contype = 'f'
     and connamespace in ('public'::regnamespace, 'partitions'::regnamespace)
     and conparentid = 0" >"$tmp/fk-drop.sql"
run_psql "$SUPABASE_DB_URL" -tAqc \
  "select 'alter table '||conrelid::regclass||' add constraint '||quote_ident(conname)||' '||pg_get_constraintdef(oid)||';'
   from pg_constraint where contype = 'f'
     and connamespace in ('public'::regnamespace, 'partitions'::regnamespace)
     and conparentid = 0" >"$tmp/fk-restore.sql"
echo "  lifting $(grep -c . "$tmp/fk-drop.sql") foreign keys"

# Only the `public` tables are cleared by name: truncating the partitioned
# parent empties every `partitions.*` child with it, and a child the target has
# never created would abort the transaction on a name that does not exist.
awk -F'\t' '$1 ~ /^public\./ { printf "%s\n", $1 }' "$tmp/expected.tsv" >"$tmp/public-tables"
{
  echo 'do $zm$'
  echo 'declare t text;'
  echo 'begin'
  echo '  foreach t in array array['
  awk 'NR > 1 { printf ",\n" } { printf "    %s", "'"'"'" $0 "'"'"'" }' "$tmp/public-tables"
  echo ''
  echo '  ] loop'
  echo '    if to_regclass(t) is not null then execute format('"'"'truncate table %s'"'"', t); end if;'
  echo '  end loop;'
  echo 'end $zm$;'
} >"$tmp/truncate.sql"

{
  cat "$tmp/fk-drop.sql"
  cat "$tmp/truncate.sql"
  cat "$tmp/accounts.sql"
  # auth.users carries an on-insert trigger that mints a profile with a fresh
  # id. It belongs to the platform's auth role and cannot be disabled from
  # here, so the minted rows are removed and the corpus brings the real ones.
  echo 'delete from public.profiles;'
  cat "$tmp/corpus.sql"
  # pg_dump blanks search_path inside the dump, so every statement concatenated
  # AFTER it loses unqualified name resolution — the constraint definitions
  # below would stop resolving. This is only visible once the pieces are
  # combined; each of them alone runs in a session with a fresh search_path.
  echo "select pg_catalog.set_config('search_path', 'public, extensions', false);"
  cat "$tmp/fk-restore.sql"
} >"$tmp/load.sql"

echo "→ loading"
# Results go to /dev/null, errors do not: the dump's own `set_config` calls
# would otherwise print a result table per segment and bury anything real.
run_psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -o /dev/null \
  --single-transaction <"$tmp/load.sql"
echo "  constraints restored and validated"

# ----------------------------------------------------------- verification --

echo "→ verifying the restored target against the artifact"
fail=0
while IFS=$'\t' read -r table expected; do
  case "$table" in
    public.* | auth.users | auth.identities) ;;
    *) continue ;;
  esac
  actual="$(query "select count(*) from $table")"
  if [ "$actual" = "$expected" ]; then
    printf '  PASS  %-32s %8s\n' "$table" "$actual"
  else
    printf '  FAIL  %-32s %8s (artifact has %s)\n' "$table" "$actual" "$expected"
    fail=1
  fi
done <"$tmp/expected.tsv"

# A row count cannot tell restored data from data that was already there. The
# identity check can: every profile must belong to an account that arrived with
# it, which is exactly what a partial or interleaved load breaks.
orphans="$(query 'select count(*) from public.profiles p where not exists (select 1 from auth.users u where u.id = p.user_id)')"
if [ "$orphans" = "0" ]; then
  printf '  PASS  %-32s %8s\n' 'orphaned profiles' "$orphans"
else
  printf '  FAIL  %-32s %8s\n' 'orphaned profiles' "$orphans"
  fail=1
fi

# The embeddings are the expensive part of this corpus: re-computing them costs
# hours and money, so "the rows came back" is not the same as "the memory came
# back". Reported always, and fatal when the artifact had them and the target
# does not.
vectors="$(query 'select count(*) from public.memories where embedding is not null')"
memories="$(query 'select count(*) from public.memories')"
printf '  INFO  %-32s %8s of %s memories\n' 'embeddings present' "$vectors" "$memories"
[ "$memories" = "0" ] || [ "$vectors" != "0" ] || {
  echo "  FAIL  the corpus restored without a single embedding"
  fail=1
}

[ "$fail" = "0" ] || die "restore verification FAILED — do not treat this target as recovered"
echo "✓ restored into $(db_host): $memories memories, $(query 'select count(*) from auth.users') accounts, schema at $target_watermark"
