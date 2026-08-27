# InteRecAgent active commands: TypeScript + pi-agent only.

NPM := npm
COMPOSE := docker compose
TEST_DATABASE_URL ?= postgresql://interec:interec@127.0.0.1:5432/interec_test

help: ## List available commands
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

bootstrap: ## Install the root workspace and create local config if absent
	$(NPM) ci
	@test -f .env || cp .env.example .env

db-up: ## Start PostgreSQL
	$(COMPOSE) up -d postgres

db-down: ## Stop PostgreSQL
	$(COMPOSE) down

migrate: ## Apply the pi-agent PostgreSQL schema
	$(NPM) run db:migrate

frontend-dev: ## Start the Conversation UI
	$(NPM) run dev --workspace frontend

api-dev: ## Start the Conversation API
	$(NPM) run dev:api

worker-dev: ## Start the durable Conversation worker
	$(NPM) run dev:worker

architecture: ## Assert that every active surface points to TypeScript/pi-agent
	$(NPM) run architecture:check

unit: ## Run deterministic tests without PostgreSQL
	$(NPM) run test:unit

integration: ## Run PostgreSQL integration tests against an isolated database
	RUN_CONVERSATION_PG_INTEGRATION=1 INTEREC_DATABASE_URL=$(TEST_DATABASE_URL) $(NPM) run test:integration

build: ## Build all workspaces and the production UI
	$(NPM) run build

acceptance: ## Run the complete offline development gate
	$(NPM) run acceptance

.PHONY: help bootstrap db-up db-down migrate \
	frontend-dev api-dev worker-dev architecture unit integration build acceptance
