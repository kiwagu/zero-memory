#!/usr/bin/env bash
#
# Make sure the local API gateway has a TLS pair to start with.
#
# The dev stack's Kong is configured with KONG_SSL_CERT / KONG_SSL_CERT_KEY and
# mounts them read-only, so the two files must exist BEFORE compose starts —
# but they must never be committed: a private key in a repository is public the
# moment the repository is, and every checkout would then share one key, which
# makes the gateway's TLS decorative rather than merely self-signed. So the pair
# is generated per machine, on first start, and ignored by git.
#
# It is a DEVELOPMENT certificate: self-signed, CN=kong, ten years, trusted by
# nothing. Production terminates TLS at the edge with real certificates and
# never uses this path.
#
# Idempotent: an existing pair is left exactly as it is, so restarting the stack
# does not invalidate sessions or force clients to re-trust anything.
#
# Usage:  bash infra/dev/gateway-tls.sh [<supabase-stack-dir>]
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stack_dir="${1:-${script_dir}/supabase}"
api_dir="${stack_dir}/volumes/api"
crt="${api_dir}/server.crt"
key="${api_dir}/server.key"

if [ -f "${crt}" ] && [ -f "${key}" ]; then
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate the dev gateway certificate." >&2
  echo "Install it, or drop your own pair at ${crt} / ${key}." >&2
  exit 1
fi

mkdir -p "${api_dir}"
# One command for both files; -nodes because the container reads the key
# unattended and a passphrase it cannot answer would only stop the stack.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 3650 -subj "/CN=kong" -keyout "${key}" -out "${crt}" 2>/dev/null
chmod 600 "${key}"
chmod 644 "${crt}"
echo "===> Generated a development TLS pair for the API gateway (${api_dir})."
