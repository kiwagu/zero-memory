#!/usr/bin/env bash

set -euo pipefail

auto_confirm=0
force_clean=0
compose_project_name="${COMPOSE_PROJECT_NAME:-zero-memory}"
supabase_dev_services_raw="${SUPABASE_DEV_SERVICES:-studio kong auth rest realtime storage imgproxy meta functions db supavisor}"

print_help() {
  cat <<'EOF'
Recreate the local dev stack (self-hosted Supabase).

Default mode:
- restarts containers without deleting volumes or database data

Force-clean mode:
- resets Supabase containers/volumes and bind-mounted data directories
- starts the Supabase stack again

Usage:
  ./infra/dev/recreate-stack.sh [-y] [--force-clean]

Options:
  -y             auto-confirm prompts
  --force-clean  deep recreation with volume/data cleanup
  -h             show this help

Environment:
  COMPOSE_PROJECT_NAME       docker compose project name (default: zero-memory)
  SUPABASE_DEV_SERVICES      explicit services to start from dev override
                             (default: "studio kong auth rest realtime storage imgproxy meta functions db supavisor")
  SKIP_STACK_DB_PUSH=1       after --force-clean, do not run make db-push (default: run it)
EOF
}

confirm() {
  if [ "${auto_confirm}" = "1" ]; then
    return 0
  fi

  printf "Proceed? (y/N) "
  read -r reply
  case "${reply}" in
    [Yy]) ;;
    *)
      echo "Canceled."
      exit 1
      ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y)
      auto_confirm=1
      shift
      ;;
    --force-clean)
      force_clean=1
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

wait_for_supabase_db() {
  local max_attempts=40
  local attempt=0
  echo "===> Waiting for Postgres (supabase-db) to accept connections..."
  while [ "${attempt}" -lt "${max_attempts}" ]; do
    if docker exec supabase-db pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      echo "Postgres is ready."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 3
  done
  echo "ERROR: Postgres did not become ready in time. Fix the stack, then run: make db-push"
  return 1
}

wait_for_storage_schema() {
  # storage-api creates the `storage` schema (storage.buckets/objects) asynchronously
  # on startup. Migrations that touch storage.* race ahead of it on a fresh stack, so
  # gate db-push on the schema existing (Postgres pg_isready alone is not enough).
  local max_attempts=40
  local attempt=0
  echo "===> Waiting for the storage schema (storage.buckets) created by storage-api..."
  while [ "${attempt}" -lt "${max_attempts}" ]; do
    if [ "$(docker exec supabase-db psql -U postgres -d postgres -tAc "select to_regclass('storage.buckets')" 2>/dev/null)" = "storage.buckets" ]; then
      echo "Storage schema is ready."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 3
  done
  echo "ERROR: storage.buckets not created in time (storage-api not ready). Storage migrations will fail. Fix the storage service, then run: make db-push"
  return 1
}

run_repo_db_push() {
  local repo_root
  repo_root="$(cd "${script_dir}/../.." && pwd)"
  if [ ! -f "${repo_root}/Makefile" ]; then
    echo "ERROR: Could not find repo root Makefile at ${repo_root}/Makefile"
    return 1
  fi
  echo "===> Applying repo migrations (make db-push)..."
  (cd "${repo_root}" && make db-push)
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

echo ""
if [ "${force_clean}" = "1" ]; then
  echo "*** WARNING: force-clean Supabase stack reset ***"
  echo "*** This removes containers, volumes, and local DB data. ***"
else
  echo "Recreating the local Supabase stack without volume cleanup."
fi
echo ""
confirm

if [ "${force_clean}" = "1" ]; then
  echo "===> Force-clean reset Supabase stack..."
  run_compose "${supabase_dir}" -f docker-compose.yml -f ./dev/docker-compose.dev.yml down -v

  echo "===> Cleaning Supabase bind-mounted data directories..."
  for dir in "${supabase_dir}/volumes/db/data" "${supabase_dir}/volumes/storage"; do
    if [ -d "${dir}" ]; then
      docker run --rm -v "${dir}:/target" alpine:3.22 sh -c 'rm -rf /target/* /target/.[!.]* /target/..?* || true'
    fi
  done
else
  echo "===> Restarting Supabase stack without volume cleanup..."
  run_compose "${supabase_dir}" -f docker-compose.yml -f ./dev/docker-compose.dev.yml down
fi

echo "===> Starting Supabase stack..."
run_compose "${supabase_dir}" -f docker-compose.yml -f ./dev/docker-compose.dev.yml up -d "${supabase_dev_services[@]}"
sync_mcp_read_only_user_password

echo ""
echo "Done. Supabase stack recreated."
echo "Check status:"
echo "  cd ${supabase_dir} && docker compose ps"

if [ "${force_clean}" = "1" ] && [ "${SKIP_STACK_DB_PUSH:-}" != "1" ]; then
  echo ""
  if wait_for_supabase_db && wait_for_storage_schema && run_repo_db_push; then
    echo ""
    echo "Repo migrations applied."
  else
    echo ""
    echo "Automatic db-push failed or DB not ready. From repo root run:"
    echo "  make db-push"
    exit 1
  fi
elif [ "${force_clean}" = "1" ] && [ "${SKIP_STACK_DB_PUSH:-}" = "1" ]; then
  echo ""
  echo "SKIP_STACK_DB_PUSH=1: skipped automatic db-push. Fresh Postgres needs:"
  echo "  make db-push    # from repo root"
fi
