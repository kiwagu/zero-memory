#!/usr/bin/env bash
# Regenerates packages/db/src/database.types.ts from a database.
#
# Usage:
#   ./scripts/gen-types.sh [db-url]
#   DB_URL=postgresql://... ./scripts/gen-types.sh
#
# Defaults to the ISOLATED e2e stack (:55332), which is authoritative for the
# schema: a branch's schema follows its migrations, and those are applied to
# e2e and nowhere else. The live stack (:55322) is deliberately NOT the default
# — generating from it describes whatever production happens to carry, including
# objects a pending migration is about to change, and steers schema work at the
# one database that must stay read-only during development. Point at live only
# by passing its URL explicitly, and only to read.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_FILE="${SCRIPT_DIR}/../src/database.types.ts"

DB_URL="${1:-${DB_URL:-postgresql://postgres:postgres@127.0.0.1:55332/postgres}}"

# The CLI insists on a (any non-empty) platform token even for --db-url runs.
export SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-sbp_local_selfhosted_unused}"

if command -v supabase >/dev/null 2>&1; then
  SUPABASE_CMD=supabase
else
  SUPABASE_CMD="bunx supabase"
fi

${SUPABASE_CMD} gen types typescript --db-url "${DB_URL}" --schema public > "${OUT_FILE}"

bunx prettier --write "${OUT_FILE}" >/dev/null

echo "Wrote ${OUT_FILE}"
