SHELL := /bin/bash

SUPABASE ?= supabase
SUPABASE_CMD ?= $(shell if command -v $(SUPABASE) >/dev/null 2>&1; then echo "$(SUPABASE)"; elif command -v bunx >/dev/null 2>&1; then echo "bunx supabase"; fi)
# Supabase CLI >= ~2.9x reads ~/.supabase/profile for an access token on startup and aborts
# when it is missing — even for self-hosted --db-url / --local commands that never call the
# platform. Any non-empty token satisfies the guard; the DB connection uses --db-url, not
# this token. A real `supabase login` token in the environment is honored (?= keeps it).
SUPABASE_ACCESS_TOKEN ?= sbp_local_selfhosted_unused
export SUPABASE_ACCESS_TOKEN
SUPABASE_STACK_DIR ?= infra/dev/supabase
COMPOSE_PROJECT_NAME ?= zero-memory
NAME ?=
SUPABASE_DB_CONTAINER ?= supabase-db
SELF_HOSTED_DB_HOST ?= 127.0.0.1
# Optional full URL (password must be percent-encoded). When set, overrides host/port/user from .env.
SELF_HOSTED_DB_URL ?=
# Local self-hosted pooler is plain TCP; Supabase CLI often ignores ?sslmode= in --db-url, so we set PGSSLMODE for the child process.
SELF_HOSTED_DB_SSLMODE ?= disable
REPO_ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
URLENCODE_STDIN := $(REPO_ROOT)/scripts/urlencode-stdin.py

.PHONY: help install dev check supabase-check docker-check stack-help stack-up stack-recreate stack-recreate-clean db-start db-stop db-status db-new db-push db-diff db-pull db-types db-create-user

help:
	@echo "zero-memory tasks"
	@echo ""
	@echo "Usage:"
	@echo "  make <target> [NAME=...] [SELF_HOSTED_DB_HOST=...] [SELF_HOSTED_DB_URL=...]"
	@echo ""
	@echo "Targets:"
	@echo "  install          bun install"
	@echo "  dev              bun run dev (turbo)"
	@echo "  check            bun run check (format:check + lint + typecheck)"
	@echo "  supabase-check   Check local Supabase CLI availability"
	@echo "  docker-check     Check Docker and Compose availability"
	@echo "  stack-help       Print direct docker compose commands"
	@echo "  stack-up         Upsert the self-hosted Supabase stack"
	@echo "  stack-recreate        Recreate the Supabase stack (FORCE_CLEAN=1 for deep clean)"
	@echo "  stack-recreate-clean  Same as: make stack-recreate FORCE_CLEAN=1"
	@echo "  db-start         Alias for stack-up"
	@echo "  db-stop          docker compose down for the Supabase stack"
	@echo "  db-status        Show infra/dev/supabase services status"
	@echo "  db-new           Create migration file (requires NAME)"
	@echo "  db-push          Push migrations to self-hosted Postgres"
	@echo "  db-diff          Diff migrations vs self-hosted Postgres"
	@echo "  db-pull          Pull schema from self-hosted Postgres into a migration"
	@echo "  db-types         Generate database types (placeholder until a db package exists)"

install:
	@bun install

dev:
	@bun run dev

check:
	@bun run check

supabase-check:
	@[ -n "$(SUPABASE_CMD)" ] || { \
		echo "Supabase CLI not found (neither binary nor bunx fallback)."; \
		echo "Install: https://supabase.com/docs/guides/cli"; \
		exit 1; \
	}
	@echo "Using: $(SUPABASE_CMD)"
	@$(SUPABASE_CMD) --version

docker-check:
	@command -v docker >/dev/null 2>&1 || { \
		echo "Docker is not installed or not in PATH."; \
		exit 1; \
	}
	@docker compose version >/dev/null 2>&1 || { \
		echo "Docker Compose plugin is unavailable."; \
		exit 1; \
	}
	@[ -f "$(SUPABASE_STACK_DIR)/docker-compose.yml" ] || { \
		echo "Missing $(SUPABASE_STACK_DIR)/docker-compose.yml"; \
		exit 1; \
	}

stack-help: docker-check
	@echo "Run stack commands directly:"
	@echo "  cd $(SUPABASE_STACK_DIR)"
	@echo "  docker compose up -d"
	@echo "  docker compose down"
	@echo "  ./reset.sh"

stack-up: docker-check
	@COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) SUPABASE_DEV_SERVICES="$(SUPABASE_DEV_SERVICES)" ./infra/dev/stack-up.sh $(if $(FROM_SCRATCH),--from-scratch,) $(if $(FORCE_RECREATE),--force-recreate,)

stack-recreate: docker-check
	@COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) SUPABASE_DEV_SERVICES="$(SUPABASE_DEV_SERVICES)" SKIP_STACK_DB_PUSH="$(SKIP_STACK_DB_PUSH)" ./infra/dev/recreate-stack.sh $(if $(FORCE_CLEAN),--force-clean,) $(if $(RECREATE_YES),-y,)

# GNU Make treats `--force-clean` after the target as a Make flag, not script args. Use FORCE_CLEAN=1 or this target.
stack-recreate-clean: FORCE_CLEAN := 1
stack-recreate-clean: stack-recreate

db-start: stack-up

db-stop: docker-check
	@cd "$(SUPABASE_STACK_DIR)" && docker compose -p "$(COMPOSE_PROJECT_NAME)" down

db-status: docker-check
	@cd "$(SUPABASE_STACK_DIR)" && docker compose -p "$(COMPOSE_PROJECT_NAME)" ps

db-new: supabase-check
	@if [ -z "$(NAME)" ]; then \
		echo "NAME is required. Example: make db-new NAME=create_memories"; \
		exit 1; \
	fi
	@$(SUPABASE_CMD) migration new $(NAME)

# Push migrations to the self-hosted stack: read POSTGRES_* from SUPABASE_STACK_DIR/.env via
# grep (do not `source` — compose .env allows unquoted spaces).
db-push: supabase-check
	@bash -euo pipefail -c '\
	if [ -n "$(strip $(SELF_HOSTED_DB_URL))" ]; then \
		PGSSLMODE=$(SELF_HOSTED_DB_SSLMODE) $(SUPABASE_CMD) db push --db-url "$(SELF_HOSTED_DB_URL)" --yes; \
	else \
		[ -f "$(SUPABASE_STACK_DIR)/.env" ] || { echo "Missing $(SUPABASE_STACK_DIR)/.env (copy from .env.example)"; exit 1; }; \
		ENV_FILE="$(SUPABASE_STACK_DIR)/.env"; \
		POSTGRES_PASSWORD=$$(grep -E '^POSTGRES_PASSWORD=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
		POSTGRES_PORT=$$(grep -E '^POSTGRES_PORT=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
		POSTGRES_DB=$$(grep -E '^POSTGRES_DB=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
		POOLER_TENANT_ID=$$(grep -E '^POOLER_TENANT_ID=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
		POSTGRES_DIRECT_PORT=$$(grep -E '^POSTGRES_DIRECT_PORT=' "$$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "[:space:]"); \
		POSTGRES_PORT=$${POSTGRES_PORT:-5432}; \
		POSTGRES_DB=$${POSTGRES_DB:-postgres}; \
		: $${POSTGRES_PASSWORD:?Missing POSTGRES_PASSWORD in $(SUPABASE_STACK_DIR)/.env}; \
		command -v python3 >/dev/null 2>&1 || { echo "python3 is required (scripts/urlencode-stdin.py) for supabase --db-url"; exit 1; }; \
		ENC_PASS=$$(printf '%s' "$$POSTGRES_PASSWORD" | python3 "$(URLENCODE_STDIN)"); \
		if [ -n "$$POSTGRES_DIRECT_PORT" ]; then \
			PG_USER="postgres"; \
			CLI_PORT="$$POSTGRES_DIRECT_PORT"; \
		else \
			if [ -n "$$POOLER_TENANT_ID" ]; then PG_USER="postgres.$$POOLER_TENANT_ID"; else PG_USER="postgres"; fi; \
			CLI_PORT="$$POSTGRES_PORT"; \
		fi; \
		ENC_USER=$$(printf '%s' "$$PG_USER" | python3 "$(URLENCODE_STDIN)"); \
		HOST="$(SELF_HOSTED_DB_HOST)"; DB="$$POSTGRES_DB"; \
		DBURL="postgresql://$$ENC_USER:$$ENC_PASS@$$HOST:$$CLI_PORT/$$DB?sslmode=$(SELF_HOSTED_DB_SSLMODE)"; \
		PGSSLMODE=$(SELF_HOSTED_DB_SSLMODE) $(SUPABASE_CMD) db push --db-url "$$DBURL" --yes; \
	fi \
	'

# Diff local migration files against the self-hosted database
db-diff: supabase-check
	@bash -euo pipefail -c '\
	if [ -n "$(strip $(SELF_HOSTED_DB_URL))" ]; then \
		PGSSLMODE=$(SELF_HOSTED_DB_SSLMODE) exec $(SUPABASE_CMD) db diff --db-url "$(SELF_HOSTED_DB_URL)"; \
	fi; \
	[ -f "$(SUPABASE_STACK_DIR)/.env" ] || { echo "Missing $(SUPABASE_STACK_DIR)/.env"; exit 1; }; \
	ENV_FILE="$(SUPABASE_STACK_DIR)/.env"; \
	POSTGRES_PASSWORD=$$(grep -E '^POSTGRES_PASSWORD=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POSTGRES_PORT=$$(grep -E '^POSTGRES_PORT=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POSTGRES_DB=$$(grep -E '^POSTGRES_DB=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POOLER_TENANT_ID=$$(grep -E '^POOLER_TENANT_ID=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POSTGRES_DIRECT_PORT=$$(grep -E '^POSTGRES_DIRECT_PORT=' "$$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "[:space:]"); \
	POSTGRES_PORT=$${POSTGRES_PORT:-5432}; \
	POSTGRES_DB=$${POSTGRES_DB:-postgres}; \
	: $${POSTGRES_PASSWORD:?Missing POSTGRES_PASSWORD in $(SUPABASE_STACK_DIR)/.env}; \
	command -v python3 >/dev/null 2>&1 || { echo "python3 is required (scripts/urlencode-stdin.py) for supabase --db-url"; exit 1; }; \
	ENC_PASS=$$(printf '%s' "$$POSTGRES_PASSWORD" | python3 "$(URLENCODE_STDIN)"); \
	if [ -n "$$POSTGRES_DIRECT_PORT" ]; then \
		PG_USER="postgres"; \
		CLI_PORT="$$POSTGRES_DIRECT_PORT"; \
	else \
		if [ -n "$$POOLER_TENANT_ID" ]; then PG_USER="postgres.$$POOLER_TENANT_ID"; else PG_USER="postgres"; fi; \
		CLI_PORT="$$POSTGRES_PORT"; \
	fi; \
	ENC_USER=$$(printf '%s' "$$PG_USER" | python3 "$(URLENCODE_STDIN)"); \
	HOST="$(SELF_HOSTED_DB_HOST)"; DB="$$POSTGRES_DB"; \
	DBURL="postgresql://$$ENC_USER:$$ENC_PASS@$$HOST:$$CLI_PORT/$$DB?sslmode=$(SELF_HOSTED_DB_SSLMODE)"; \
	PGSSLMODE=$(SELF_HOSTED_DB_SSLMODE) exec $(SUPABASE_CMD) db diff --db-url "$$DBURL" \
	'

# Pull schema from the self-hosted DB into a new migration (non-interactive)
db-pull: supabase-check
	@bash -euo pipefail -c '\
	if [ -n "$(strip $(SELF_HOSTED_DB_URL))" ]; then \
		PGSSLMODE=$(SELF_HOSTED_DB_SSLMODE) exec $(SUPABASE_CMD) db pull --db-url "$(SELF_HOSTED_DB_URL)" --yes; \
	fi; \
	[ -f "$(SUPABASE_STACK_DIR)/.env" ] || { echo "Missing $(SUPABASE_STACK_DIR)/.env"; exit 1; }; \
	ENV_FILE="$(SUPABASE_STACK_DIR)/.env"; \
	POSTGRES_PASSWORD=$$(grep -E '^POSTGRES_PASSWORD=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POSTGRES_PORT=$$(grep -E '^POSTGRES_PORT=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POSTGRES_DB=$$(grep -E '^POSTGRES_DB=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POOLER_TENANT_ID=$$(grep -E '^POOLER_TENANT_ID=' "$$ENV_FILE" | head -1 | cut -d= -f2-); \
	POSTGRES_DIRECT_PORT=$$(grep -E '^POSTGRES_DIRECT_PORT=' "$$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "[:space:]"); \
	POSTGRES_PORT=$${POSTGRES_PORT:-5432}; \
	POSTGRES_DB=$${POSTGRES_DB:-postgres}; \
	: $${POSTGRES_PASSWORD:?Missing POSTGRES_PASSWORD in $(SUPABASE_STACK_DIR)/.env}; \
	command -v python3 >/dev/null 2>&1 || { echo "python3 is required (scripts/urlencode-stdin.py) for supabase --db-url"; exit 1; }; \
	ENC_PASS=$$(printf '%s' "$$POSTGRES_PASSWORD" | python3 "$(URLENCODE_STDIN)"); \
	if [ -n "$$POSTGRES_DIRECT_PORT" ]; then \
		PG_USER="postgres"; \
		CLI_PORT="$$POSTGRES_DIRECT_PORT"; \
	else \
		if [ -n "$$POOLER_TENANT_ID" ]; then PG_USER="postgres.$$POOLER_TENANT_ID"; else PG_USER="postgres"; fi; \
		CLI_PORT="$$POSTGRES_PORT"; \
	fi; \
	ENC_USER=$$(printf '%s' "$$PG_USER" | python3 "$(URLENCODE_STDIN)"); \
	HOST="$(SELF_HOSTED_DB_HOST)"; DB="$$POSTGRES_DB"; \
	DBURL="postgresql://$$ENC_USER:$$ENC_PASS@$$HOST:$$CLI_PORT/$$DB?sslmode=$(SELF_HOSTED_DB_SSLMODE)"; \
	PGSSLMODE=$(SELF_HOSTED_DB_SSLMODE) exec $(SUPABASE_CMD) db pull --db-url "$$DBURL" --yes \
	'

# Regenerate packages/db/src/database.types.ts. Uses the Supabase CLI local
# stack by default; pass DB_URL=... to target another database.
db-types: supabase-check
	@./packages/db/scripts/gen-types.sh $(if $(DB_URL),$(DB_URL),)

# Provision the local MCP user (requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# ZM_EMAIL, ZM_PASSWORD in the environment).
db-create-user:
	@cd packages/persistence && bun scripts/create-local-user.ts
