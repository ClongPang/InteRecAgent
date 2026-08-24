# InteRecAgent 命令入口（QLT-001：安装/启动/迁移/测试/门禁机械化）
# 用法：make <target>；见 `make help`

SHELL := /bin/bash
PY := .venv/bin/python
UV := uv
NPM := npm --prefix frontend
COMPOSE := docker compose
ACCEPTANCE_BASE ?= http://127.0.0.1:8000

help: ## 列出所有可用命令
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

# ── 工程入口 ───────────────────────────────────────────────

bootstrap: ## 安装前后端依赖并准备 .env（可重复执行）
	$(UV) sync
	$(NPM) install
	@test -f .env || cp .env.example .env
	@echo "bootstrap 完成"

baseline: secret-precheck ## P0 基线：旧后端测试、前端构建、diff check、密钥预检
	$(UV) run pytest -q
	$(NPM) run build
	git diff --check
	@echo "baseline PASS"

secret-precheck: ## 检查密钥是否被 Git 跟踪或写进 .env.example
	@bash -c 'if git ls-files | grep -qE "(^|/)\.env$$|\.pem$$|\.(key|p12)$$"; then echo "!! 密钥文件被跟踪"; exit 1; fi'
	@bash -c 'if git ls-files "*.env.example" | xargs grep -lE "=[A-Za-z0-9_-]{16,}$$" 2>/dev/null; then echo "!! .env.example 含疑似真实值"; exit 1; fi'
	@echo "secret precheck OK"

MIGRATE_URL ?= postgresql+asyncpg://interec:interec@localhost:5432/interec
TEST_MIGRATE_URL ?= postgresql+asyncpg://interec:interec@localhost:5432/interec_test

# ── 基础设施 ───────────────────────────────────────────────

db-up: ## 启动 PostgreSQL（仅骨架依赖）
	$(COMPOSE) up -d postgres

db-down: ## 停止 PostgreSQL
	$(COMPOSE) down

migrate: ## 数据库迁移到最新
	INTEREC_DATABASE_URL=$(MIGRATE_URL) $(PY) -m alembic upgrade head

migrate-test: ## 迁移往返 + 漂移检查（测试库）
	INTEREC_DATABASE_URL=$(TEST_MIGRATE_URL) $(PY) -m alembic downgrade base
	INTEREC_DATABASE_URL=$(TEST_MIGRATE_URL) $(PY) -m alembic upgrade head
	INTEREC_DATABASE_URL=$(TEST_MIGRATE_URL) $(PY) -m alembic check
	@echo "migrate-test PASS"

# ── 开发服务器 ─────────────────────────────────────────────

backend-dev: ## 启动后端开发服务器
	$(UV) run uvicorn backend.main:app --reload --port 8000

frontend-dev: ## 启动前端开发服务器
	$(NPM) run dev

# ── 后端测试 ───────────────────────────────────────────────

backend-unit: ## 后端离线测试（单元 + 契约）
	$(UV) run pytest -m "not integration and not live" -q

backend-contract: ## 后端契约测试（供应商/API schema fixture）
	$(UV) run pytest -m contract -q

backend-integration: ## 后端集成测试（需要 PostgreSQL）
	$(UV) run pytest -m integration -q

architecture: ## 导入依赖方向检查
	$(UV) run pytest -m architecture -q
	$(UV) run python scripts/check_architecture.py

agent-test: ## Agent 状态图测试
	$(UV) run pytest -m agent -q

api-test: ## FastAPI HTTP/SSE 契约测试
	$(UV) run pytest -m api -q

contract-drift: ## 导出 OpenAPI → 生成 TS 类型，检查 Git 漂移
	$(UV) run python scripts/export_openapi.py
	cd frontend && npm run gen:types
	git diff --exit-code -- frontend/src/api/generated.ts
	@echo "contract-drift PASS"

# ── 前端质量 ───────────────────────────────────────────────

frontend-check: ## 前端 TypeScript 检查与生产构建
	$(NPM) run build

# ── 综合门禁 ───────────────────────────────────────────────

lint: ## Python 静态检查（ruff）
	$(UV) run ruff check .

test: ## 后端测试 + 前端 TypeScript/构建检查
	$(UV) run pytest -q
	$(NPM) run build

check: ## 无 Key CI 等价门禁
	$(MAKE) backend-unit
	$(MAKE) architecture
	$(MAKE) frontend-check
	@echo "check PASS"

acceptance: ## 最终机械验收（P7）
	$(UV) run python -m scripts.runtime_acceptance --base $(ACCEPTANCE_BASE) --output .artifacts/runtime-acceptance.json

semantic-shadow-audit: ## 语义画像 shadow 只读晋级审计
	$(UV) run python -m scripts.audit_semantic_shadow --output .artifacts/semantic-shadow-audit.json

rollout-audit: ## V2/control 样本与安全门禁只读审计
	$(UV) run python -m scripts.audit_rollout --output .artifacts/rollout-audit.json

.PHONY: help bootstrap baseline secret-precheck db-up db-down migrate \
	migrate-test backend-dev frontend-dev backend-unit backend-contract \
	backend-integration architecture agent-test api-test contract-drift \
	frontend-check lint test check acceptance semantic-shadow-audit rollout-audit
