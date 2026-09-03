#!/usr/bin/env bash
# Deploy the current deployment checkout: pull it, pull the pinned images,
# recreate what changed. Run ON the host from anywhere; the checkout
# location comes from ZM_CHECKOUT_DIR (default /opt/zero-memory).
#
# Usage:
#   infra/prod/scripts/upgrade.sh [image-tag]
#
# An image-tag argument PERSISTS the pin into infra/prod/.env before
# deploying — the .env is the single source of the deployed version, so an
# ephemeral override would silently roll the stack back on the next bare
# run. Without an argument the current .env pin is redeployed. Compose
# recreates only containers whose image or configuration changed.
set -euo pipefail

checkout_dir="${ZM_CHECKOUT_DIR:-/opt/zero-memory}"
cd "$checkout_dir"

echo "→ updating the checkout"
git pull --ff-only

if [ -n "${1:-}" ]; then
  tag="$1"
  env_file="infra/prod/.env"
  if grep -q '^ZM_IMAGE_TAG=' "$env_file"; then
    sed -i "s|^ZM_IMAGE_TAG=.*|ZM_IMAGE_TAG=${tag}|" "$env_file"
  else
    printf '\nZM_IMAGE_TAG=%s\n' "$tag" >> "$env_file"
  fi
  echo "→ pinned ZM_IMAGE_TAG=${tag} in ${env_file}"
fi

# Stamp the checkout the containers are started from — the second half of a
# deployment's identity, and the one nothing else can observe from outside.
ZM_CHECKOUT_SHA="$(git rev-parse --short HEAD)"
export ZM_CHECKOUT_SHA
echo "→ checkout ${ZM_CHECKOUT_SHA}"

# --- the .env must answer everything this checkout asks of it -----------------
# A release can introduce a REQUIRED variable, and an .env written before it
# simply does not have one. Compose substitutes an empty string and carries on,
# so the failure surfaces one layer down and out of proportion: an empty
# hostname makes Caddy reject the WHOLE Caddyfile, taking the sites that were
# serving perfectly down with the one being added. Refuse here instead, before
# a single container is touched — the running stack keeps serving while the
# operator fills in the blank.
missing=()
for name in ZM_SERVER_HOST ZM_WEB_HOST ZM_DOCS_HOST; do
  value="$(grep -E "^${name}=" infra/prod/.env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  if [ -z "$value" ]; then
    missing+=("$name")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ infra/prod/.env is missing: ${missing[*]}" >&2
  echo "  This checkout needs them; see infra/prod/.env.example for what each" >&2
  echo "  one names. Nothing was deployed — the running stack is untouched." >&2
  exit 1
fi

# --- schema, before code ------------------------------------------------------
# Opt-in (ZM_MIGRATE_ON_DEPLOY=1 in infra/prod/.env): the host applies the
# pending migration tail itself, AFTER the release passed CI and BEFORE the
# new containers start — the ordering that otherwise has to be watched by
# hand. Hosts that never set the flag (any external install provisioning
# from an operator machine) skip this block unchanged.
#
# Fail-closed on purpose: once this host claims to manage its schema, an
# unreadable credential or a failed apply ABORTS the deploy while the old
# containers still serve. Silently deploying new code over an old schema is
# the exact failure this block exists to remove.
migrate_flag="$(grep -E '^ZM_MIGRATE_ON_DEPLOY=' infra/prod/.env 2>/dev/null | cut -d= -f2- || true)"
if [ "${migrate_flag:-0}" = "1" ]; then
  db_env_file="$(grep -E '^ZM_DB_ENV_FILE=' infra/prod/.env 2>/dev/null | cut -d= -f2- || true)"
  db_env_file="${db_env_file:-/etc/zero-memory/backup.env}"
  if [ -z "${SUPABASE_DB_URL:-}" ]; then
    [ -r "$db_env_file" ] \
      || { echo "ZM_MIGRATE_ON_DEPLOY=1 but $db_env_file is unreadable — refusing to deploy" >&2; exit 1; }
    SUPABASE_DB_URL="$(set -a; . "$db_env_file"; printf '%s' "${SUPABASE_DB_URL:-}")"
    [ -n "$SUPABASE_DB_URL" ] \
      || { echo "ZM_MIGRATE_ON_DEPLOY=1 but $db_env_file carries no SUPABASE_DB_URL — refusing to deploy" >&2; exit 1; }
  fi
  export SUPABASE_DB_URL

  # A pre-schema dump before any DDL, into its own corner: the deploy dump
  # must not mirror off-site and must not ping the dead-man monitor, or it
  # masquerades as the daily backup. Taken only when something is pending —
  # a code-only deploy leaves no artifact behind. The `pending` probe runs
  # the applier's full checks — captured on its own line so a diverged
  # history aborts the deploy here rather than hiding behind the counter's
  # tolerance for zero matches.
  pending_list="$(infra/prod/scripts/db-forward-apply.sh pending)"
  pending="$(printf '%s' "$pending_list" | grep -c . || true)"
  if [ "${pending:-0}" -gt 0 ]; then
    echo "→ pre-schema dump (${pending} migration(s) pending)"
    env -u ZM_DUMP_REMOTE -u ZM_DUMP_PING_URL -u ZM_DUMP_PING_FAIL_URL \
      SUPABASE_DB_URL="$SUPABASE_DB_URL" \
      ZM_DUMP_DIR="${ZM_PRE_DEPLOY_DUMP_DIR:-/var/backups/zero-memory/pre-deploy}" \
      ZM_DUMP_KEEP="${ZM_PRE_DEPLOY_DUMP_KEEP:-5}" \
      infra/prod/scripts/db-dump.sh
  fi
  infra/prod/scripts/db-forward-apply.sh
fi

compose=(docker compose --project-directory infra/prod
  -f infra/prod/docker-compose.yml -f infra/prod/docker-compose.caddy.yml)

echo "→ pulling images"
"${compose[@]}" pull
echo "→ applying"
# --wait holds until the recreated containers report healthy. Without it the
# command returns the moment they are created, so anything that checks the
# instance right after a deploy — an operator, or the acceptance run in CI —
# meets a service that is still starting and reads it as a failed release.
"${compose[@]}" up -d --wait
"${compose[@]}" ps
