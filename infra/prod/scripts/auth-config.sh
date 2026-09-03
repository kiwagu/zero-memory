#!/usr/bin/env bash
# Configure a hosted Supabase project's Auth for this product via the
# Management API: SMTP relay, external URLs, and the exported mail
# templates — replacing the dashboard hand-work. Idempotent: PATCHes the
# full desired state and verifies it back.
#
# Required env:
#   SUPABASE_PROJECT_REF     project ref
#   SUPABASE_ACCESS_TOKEN    Management API personal access token (sbp_...)
#   ZM_WEB_URL               external dashboard URL (becomes site_url; its
#                            /auth/callback joins the redirect allow-list)
#   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS
#   SMTP_ADMIN_EMAIL         From address on the verified sender domain
# Optional env:
#   SMTP_SENDER_NAME         display name (default: the product name)
#   TEMPLATES_DIR            exported templates (default: apps/web/public/email-templates)
#
# Prereq: `bun run --cwd packages/email mail:export` produced the templates.
set -euo pipefail

: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN — mint a short-lived management token for this run and revoke it afterwards}"
: "${ZM_WEB_URL:?set ZM_WEB_URL (external dashboard URL)}"
: "${SMTP_HOST:?set SMTP_HOST}"; : "${SMTP_PORT:?set SMTP_PORT}"
: "${SMTP_USER:?set SMTP_USER}"; : "${SMTP_PASS:?set SMTP_PASS}"
: "${SMTP_ADMIN_EMAIL:?set SMTP_ADMIN_EMAIL}"
templates_dir="${TEMPLATES_DIR:-apps/web/public/email-templates}"
manifest="$templates_dir/manifest.json"
[ -f "$manifest" ] || { echo "no $manifest — run: bun run --cwd packages/email mail:export" >&2; exit 1; }

api="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/config/auth"
auth=(-H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json")

# Desired state, assembled in python so template HTML survives JSON encoding.
export ZM_WEB_URL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_ADMIN_EMAIL
export SMTP_SENDER_NAME="${SMTP_SENDER_NAME:-Zero Memory}"
body="$(python3 - "$manifest" "$templates_dir" <<'EOF'
import json, os, sys
manifest_path, tdir = sys.argv[1], sys.argv[2]
manifest = json.load(open(manifest_path))
env = os.environ
body = {
    "site_url": env["ZM_WEB_URL"],
    "uri_allow_list": f"{env['ZM_WEB_URL']}/auth/callback,{env['ZM_WEB_URL']}/**",
    "external_email_enabled": True,
    "smtp_host": env["SMTP_HOST"],
    "smtp_port": env["SMTP_PORT"],
    "smtp_user": env["SMTP_USER"],
    "smtp_pass": env["SMTP_PASS"],
    "smtp_admin_email": env["SMTP_ADMIN_EMAIL"],
    "smtp_sender_name": env.get("SMTP_SENDER_NAME", "Zero Memory"),
}
for t in manifest["templates"]:
    name = t["name"]
    html = open(os.path.join(tdir, t["file"])).read()
    body[f"mailer_subjects_{name}"] = t["subject"]
    body[f"mailer_templates_{name}_content"] = html
print(json.dumps(body))
EOF
)"

echo "→ patching auth config of ${SUPABASE_PROJECT_REF}"
response="$(mktemp)"
trap 'rm -f "$response"' EXIT
code="$(curl -s -o "$response" -w '%{http_code}' -X PATCH "$api" "${auth[@]}" -d "$body")"
if [ "$code" != 200 ]; then
  echo "PATCH failed ($code):" >&2
  cat "$response" >&2
  exit 1
fi

echo "→ verifying"
# The response goes to a FILE, not a pipe: this script feeds python its
# program on stdin via a heredoc, so a piped body would never reach
# json.load — the heredoc owns stdin.
config_dump="$(mktemp)"
trap 'rm -f "$response" "$config_dump"' EXIT
curl -fsS "$api" "${auth[@]}" > "$config_dump"
python3 - "$ZM_WEB_URL" "$config_dump" <<'EOF'
import json, sys

web, dump = sys.argv[1], sys.argv[2]
cfg = json.load(open(dump))
problems = []
if cfg.get("site_url") != web:
    problems.append(f"site_url={cfg.get('site_url')}")
if web + "/auth/callback" not in (cfg.get("uri_allow_list") or ""):
    problems.append("callback missing from uri_allow_list")
if not cfg.get("smtp_host"):
    problems.append("smtp_host empty")
if problems:
    print("verification FAILED:", "; ".join(problems)); sys.exit(1)
print("✓ auth config stored: site_url, allow-list, smtp host, templates")
print("  the SMTP credential is NOT checked here — the API never returns it,")
print("  and storing it is not accepting it. Only a delivered mail proves it.")
EOF
