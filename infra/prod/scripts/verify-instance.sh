#!/usr/bin/env bash
# External acceptance of a deployed instance — the same checks a client
# performs, run from OUTSIDE the host. Read-only. Exits non-zero if any
# check fails.
#
# Usage:
#   infra/prod/scripts/verify-instance.sh <server-url> <web-url>
#   e.g. verify-instance.sh https://zm.example.com https://memory.example.com
set -euo pipefail

server="${1:?usage: verify-instance.sh <server-url> <web-url>}"
web="${2:?usage: verify-instance.sh <server-url> <web-url>}"
fail=0

check() { # <label> <ok?1:0> <detail>
  if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1 — $3"; fail=1; fi
}

body="$(curl -fsS -m 15 "$server/healthz" 2>&1)" && ok=1 || ok=0
check "healthz answers ok:true" "$( [ "$ok" = 1 ] && echo "$body" | grep -q '"ok":true' && echo 1 || echo 0 )" "$body"
version="$(echo "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
echo "INFO  deployed build: ${version:-<none reported>}"
# The second half of a deployment's identity. The build above is baked into the
# image and survives any restart; this one is passed in when the containers are
# started, so it is the half that a hand-run recreate can silently drop.
checkout="$(echo "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("checkout") or "")' 2>/dev/null || true)"
echo "INFO  deployed checkout: ${checkout:-<none reported — started without it>}"

code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$server/readyz")"
check "readyz is 200" "$( [ "$code" = 200 ] && echo 1 || echo 0 )" "got $code"

challenge="$(curl -sI -m 15 "$server/mcp" | tr -d '\r' | grep -i '^www-authenticate:' || true)"
check "mcp challenges with WWW-Authenticate" "$( [ -n "$challenge" ] && echo 1 || echo 0 )" "no challenge header"

issuer="$(curl -fsS -m 15 "$server/.well-known/oauth-authorization-server" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("issuer",""))' 2>/dev/null || true)"
check "oauth issuer equals the server url" "$( [ "$issuer" = "$server" ] && echo 1 || echo 0 )" "issuer='$issuer'"

code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -L "$web/login")"
check "dashboard login page answers 200" "$( [ "$code" = 200 ] && echo 1 || echo 0 )" "got $code"

# A dashboard that renders but cannot reach the memory server is a broken
# deployment that every other check here reports as healthy.
webhealth="$(curl -fsS -m 15 "$web/healthz" 2>&1)" && ok=1 || ok=0
check "dashboard reaches the mcp server" "$( [ "$ok" = 1 ] && echo "$webhealth" | grep -q '"ok":true' && echo 1 || echo 0 )" "$webhealth"

# The dashboard's auth callback must redirect to the EXTERNAL origin — a
# Location pointing at an internal bind address means the edge headers are
# not reaching the app.
location="$(curl -sI -m 15 "$web/auth/callback?code=probe" | tr -d '\r' | grep -i '^location:' | awk '{print $2}' || true)"
case "$location" in
  "$web"/*) ok=1 ;;
  /*)       ok=1 ;;   # relative is fine
  *)        ok=0 ;;
esac
check "auth callback redirects to the external origin" "$ok" "Location: ${location:-<none>}"

for url in "$server" "$web"; do
  host="${url#https://}"
  subject="$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
    | openssl x509 -noout -checkend 604800 >/dev/null 2>&1 && echo 1 || echo 0)"
  check "certificate of $host valid for 7+ days" "$subject" "expiring or unreadable"
done

exit "$fail"
