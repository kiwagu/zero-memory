#!/usr/bin/env bash
# One-time preparation of a fresh production host (Ubuntu/Debian), run as
# root ON the host: container runtime, registry login, the deployment
# checkout. Idempotent — safe to re-run.
#
# Required env:
#   ZM_CHECKOUT_URL   clone URL of the deployment repository (may embed a token)
#   REGISTRY_USER     registry account for pulling published images
#   REGISTRY_TOKEN    its token (needs read access to the packages)
# Optional env:
#   ZM_CHECKOUT_DIR   checkout location            (default: /opt/zero-memory)
#   REGISTRY          image registry               (default: ghcr.io)
#
# The application itself is NOT started here: fill infra/prod/.env in the
# checkout first (see infra/prod/.env.example), then run upgrade.sh.
set -euo pipefail

: "${ZM_CHECKOUT_URL:?set ZM_CHECKOUT_URL}"
: "${REGISTRY_USER:?set REGISTRY_USER}"
: "${REGISTRY_TOKEN:?set REGISTRY_TOKEN}"
checkout_dir="${ZM_CHECKOUT_DIR:-/opt/zero-memory}"
registry="${REGISTRY:-ghcr.io}"

echo "→ packages"
# Install only what is genuinely missing. `apt-get install` on an already
# present package is NOT a no-op — it upgrades when the index carries a newer
# version, and upgrading the container runtime restarts its daemon. On a host
# that is already serving, that turns a re-run of this script into an outage,
# so the safety cannot rest on the operator remembering not to re-run it.
missing=()
command -v docker >/dev/null 2>&1 || missing+=(docker.io)
docker compose version >/dev/null 2>&1 || missing+=(docker-compose-v2)
command -v git >/dev/null 2>&1 || missing+=(git)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "  installing: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq "${missing[@]}"
else
  echo "  runtime, compose and git already present — nothing to install"
fi

echo "→ registry login ($registry)"
printf '%s' "$REGISTRY_TOKEN" | docker login "$registry" -u "$REGISTRY_USER" --password-stdin

if [ -d "$checkout_dir/.git" ]; then
  echo "→ checkout exists — updating"
  git -C "$checkout_dir" pull --ff-only
else
  echo "→ cloning into $checkout_dir"
  git clone "$ZM_CHECKOUT_URL" "$checkout_dir"
fi

# Stable entry point for the deployment key's forced command. It has to live
# OUTSIDE the checkout: the hook is what updates the checkout, so pointing the
# forced command inside it means the very first deployment finds nothing there.
# A symlink keeps the installed hook in lockstep with the checkout.
ln -sfn "$checkout_dir/infra/prod/scripts/deploy-hook.sh" /usr/local/bin/zm-deploy-hook
echo "→ deploy hook available at /usr/local/bin/zm-deploy-hook"

env_file="$checkout_dir/infra/prod/.env"
if [ -f "$env_file" ]; then
  echo "✓ host ready; $env_file present — run upgrade.sh to start the stack"
else
  echo "✓ host ready. NEXT: create $env_file (copy .env.example and fill it)," \
       "then run infra/prod/scripts/upgrade.sh"
fi
