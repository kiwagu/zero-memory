#!/usr/bin/env bash

set -euo pipefail

compose_project_name="${COMPOSE_PROJECT_NAME:-zero-memory}"
supabase_dev_services_raw="${SUPABASE_DEV_SERVICES:-studio kong auth rest realtime storage imgproxy meta functions db supavisor}"
from_scratch=0
force_recreate=0

print_help() {
  cat <<'EOF'
Start or update the local dev stack (self-hosted Supabase).

Default mode:
- upserts services with docker compose up -d

Options:
  --from-scratch    run compose down (without volume cleanup) before up
  --force-recreate  pass --force-recreate to compose up
  -h, --help        show this help

Environment:
  COMPOSE_PROJECT_NAME       docker compose project name (default: zero-memory)
  SUPABASE_DEV_SERVICES      explicit services to start from dev override
                             (default: "studio kong auth rest realtime storage imgproxy meta functions db supavisor")
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-scratch)
      from_scratch=1
      shift
      ;;
    --force-recreate)
      force_recreate=1
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      print_help
      exit 1
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
supabase_dir="${script_dir}/supabase"
read -r -a supabase_dev_services <<< "${supabase_dev_services_raw}"

run_compose() {
  local workdir="$1"
  shift

  (cd "${workdir}" && COMPOSE_IGNORE_ORPHANS=true docker compose -p "${compose_project_name}" "$@")
}

sync_mcp_read_only_user_password() {
  local env_file="${supabase_dir}/.env"
  if [ ! -f "${env_file}" ]; then
    echo "Skipping MCP DB auth sync: ${env_file} not found."
    return 0
  fi

  local postgres_password
  postgres_password="$(awk -F= '/^POSTGRES_PASSWORD=/{print substr($0, index($0, "=") + 1); exit}' "${env_file}")"
  if [ -z "${postgres_password}" ]; then
    echo "Skipping MCP DB auth sync: POSTGRES_PASSWORD is empty."
    return 0
  fi

  echo "===> Syncing supabase_read_only_user password for MCP tools..."
  docker exec -i \
    -e PGPASSWORD="${postgres_password}" \
    supabase-db \
    psql -U supabase_admin -d postgres \
    -c "alter user supabase_read_only_user with password '${postgres_password}';" >/dev/null
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not in PATH."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is unavailable."
  exit 1
fi

if [ ! -f "${supabase_dir}/docker-compose.yml" ]; then
  echo "Missing ${supabase_dir}/docker-compose.yml"
  exit 1
fi

# The gateway's TLS pair is generated per machine rather than committed, so it
# has to exist before compose mounts it read-only.
bash "${script_dir}/gateway-tls.sh" "${supabase_dir}"

up_args=(-d)
if [ "${force_recreate}" = "1" ]; then
  up_args+=(--force-recreate)
fi

if [ "${from_scratch}" = "1" ]; then
  echo "===> Running from-scratch restart (without volume cleanup)..."
  run_compose "${supabase_dir}" -f docker-compose.yml -f ./dev/docker-compose.dev.yml down
fi

echo "===> Upserting Supabase stack..."
run_compose "${supabase_dir}" -f docker-compose.yml -f ./dev/docker-compose.dev.yml up "${up_args[@]}" "${supabase_dev_services[@]}"
sync_mcp_read_only_user_password

echo ""
echo "Done. Stack is up (Supabase)."
echo "Check status:"
echo "  cd ${supabase_dir} && docker compose ps"
