# InteRecAgent

Traceable e-commerce recommendation agent MVP. The current implementation provides a FastAPI backend service pipeline and a React/Vite frontend driven by the shared `ChatTurnResponse` contract.

Implemented backend slices include API schemas, health/chat/products/sessions/trace/evaluation/replay endpoints, task routing, intent parsing, clarification policy, retrieval, constraint verification, rule ranking, safe LLM reranking boundaries, grounded response generation, claim-level evidence records, feedback updates, session state, data pipeline loaders, data quality reporting, and deterministic tests.

LLM-related behavior is deterministic by default. The adapter supports mock and cached modes for tests, plus an OpenAI-compatible live mode that can be exercised through an injected transport or a configured HTTP endpoint. Live network calls are intentionally outside the default validation path.

## Backend

Install dependencies with uv:

```bash
uv sync --dev
```

Run tests:

```bash
uv run pytest
```

The backend test suite covers API contracts, service behavior, session state, data pipeline normalization, evaluation metrics, and replay behavior.

Run the API locally:

```bash
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

Optional live LLM settings can be placed in the ignored root `.env` file. Use an http(s) endpoint for `DeepSeek_BASE_URL`, keep the secret token in `DeepSeek_API_KEY`, and set `DeepSeek_MODEL` when overriding the default model.

## Frontend

Install dependencies with npm:

```bash
cd frontend
npm install
```

Run validation:

```bash
npm run typecheck
npm test
npm run test:responsive
npm run test:e2e
npm run test:a11y
npm run build
```

The default frontend tests use deterministic mock fixtures. The shared API client covers chat, product lookup, session restore, internal traces, evaluation runs, and replay. `npm run test:responsive` runs jsdom responsive layout checks, `npm run test:e2e` runs Playwright browser smoke tests for consumer and internal routes, and `npm run test:a11y` checks named regions, keyboard access, and internal route isolation. `npm run test:integration` calls the real FastAPI backend and requires the backend command above to be running.

Run the app locally:

```bash
npm run dev
```

By default the frontend uses mock fixtures. To call the local backend, set:

```bash
VITE_USE_MOCKS=false VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

Run live API integration tests while the backend is running:

```bash
npm run test:integration
```
