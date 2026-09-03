#!/usr/bin/env bash
# The ONLY thing the deployment key may do on this host: update the checkout
# and deploy one published version.
#
# Install as a forced command in the deployment account's authorized_keys —
# the whole point is that the key cannot run anything else, so a leaked or
# misused CI credential can deploy a version and nothing more:
#
#   command="/opt/zero-memory/infra/prod/scripts/deploy-hook.sh",no-pty,\
#   no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA... deploy
#
# With a forced command the client's requested command arrives in
# SSH_ORIGINAL_COMMAND instead of being executed. It is accepted only when it
# is a bare version — the value then reaches the deploy script as an argument,
# where an unvalidated string could otherwise corrupt the env file it edits.
set -euo pipefail

request="${SSH_ORIGINAL_COMMAND:-}"
if ! printf '%s' "$request" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "refused: expected a version such as 1.2.3, got '${request}'" >&2
  exit 2
fi
tag="${request#v}"

checkout_dir="${ZM_CHECKOUT_DIR:-/opt/zero-memory}"
echo "→ deploy request for ${tag}"
git -C "$checkout_dir" pull --ff-only
exec "$checkout_dir/infra/prod/scripts/upgrade.sh" "$tag"
