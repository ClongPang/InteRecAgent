# Repository Guidelines

## Project Structure & Module Organization

InteRecAgent is a FastAPI + React/Vite MVP for traceable e-commerce recommendations. Backend code lives in `backend/app/`, with service modules in `backend/app/services/` and data pipeline utilities in `backend/app/data_pipeline/`. Frontend code lives in `frontend/src/`, browser tests in `frontend/tests/e2e/`, and shared contract types in `frontend/src/types/`. Backend, service, pipeline, API, integration, and validation-script tests live under `tests/`. Product, architecture, data, evaluation, and roadmap notes stay in `docs/`; the static prototype remains in `docs/prototype/`. Generated local data artifacts belong under `data/catalog/`, `data/indexes/`, `data/profiles/`, and `data/eval/`.

## Build, Test, and Development Commands

- `UV_CACHE_DIR=.uv-cache uv run uvicorn backend.app.main:app --reload`: run the backend locally.
- `UV_CACHE_DIR=.uv-cache uv run pytest`: run all backend and Python tests.
- `cd frontend && npm run dev`: start the Vite frontend.
- `cd frontend && npm test`: run frontend unit tests.
- `cd frontend && npm run test:e2e`: run Playwright browser tests.
- `python3 scripts/validate_mvp.py`: run the combined backend, frontend, build, and live integration gates.
- `python3 scripts/validate_mvp.py --require-system-readiness`: require catalog, index, profile, and evaluation artifacts before validation.

## Coding Style & Naming Conventions

Use 4-space indentation and `snake_case` for Python modules, functions, and variables. Use `PascalCase` for Pydantic models, React components, and TypeScript types. Keep backend services small and aligned with the pipeline stages: routing, intent parsing, retrieval, constraint verification, ranking, reranking, response generation, tracing, replay, and evaluation. Frontend components should render backend-owned fields instead of inferring recommendation truth.

## Testing Guidelines

Use `pytest` for backend and pipeline tests; name files `test_<module>.py` and tests `test_<behavior>()`. Use Vitest for React tests and Playwright for browser flows. Cover contract changes on both sides: backend schema/API tests plus frontend type/client tests. Run `python3 scripts/validate_mvp.py --skip-e2e` for a fast local gate and the full script before handoff.

## Commit & Pull Request Guidelines

Use concise Conventional Commits, such as `feat: add profile readiness gate` or `fix: filter unknown critical prices`. Pull requests should include the problem, implementation summary, test commands and results, linked issue or task, screenshots for UI changes, and notes for data artifacts, environment variables, or LLM schema/prompt changes.

## Security & Configuration Tips

Do not commit `.env`, raw private datasets, API keys, generated indexes, `.DS_Store`, IDE metadata, or cache directories. Keep local secrets in ignored environment files and document required variables with safe example values.
