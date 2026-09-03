#!/usr/bin/env bash
# Provision the database of a fresh deployment: apply the migration series
# and create the instance's service account. Idempotent. Run from an
# operator machine at the repository root.
#
# Required env:
#   SUPABASE_DB_URL           full Postgres URL of the target database. For a
#                             hosted project prefer the session-pooler URL —
#                             it is IPv4-reachable, while the direct
#                             connection is IPv6-only.
#   SUPABASE_URL              the project's API URL
#   SUPABASE_SERVICE_ROLE_KEY its secret (service) key
#   ZM_EMAIL / ZM_PASSWORD    service-account credentials to provision
#
# Deliberately uses --db-url instead of `supabase link`: a linked project in
# a checkout silently changes the behavior of other CLI commands run there.
#
# The CLI is invoked through `bunx`, like every other Supabase call in this
# repository. Bun is already required to run the provisioning step below, so
# this asks for nothing extra — whereas a bare `supabase` needs a global
# install that is documented nowhere and fails the whole documented path with
# "command not found" on a machine that has everything the docs ask for.
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (session-pooler URL for hosted projects)}"
: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?set SUPABASE_SERVICE_ROLE_KEY}"
: "${ZM_EMAIL:?set ZM_EMAIL}"
: "${ZM_PASSWORD:?set ZM_PASSWORD}"

echo "→ applying migrations"
bunx supabase db push --db-url "$SUPABASE_DB_URL"

echo "→ provisioning the service account"
bun packages/persistence/scripts/create-local-user.ts

echo "✓ database provisioned"
