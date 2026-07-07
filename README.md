# InteRecAgent

Traceable e-commerce recommendation agent MVP. The current implementation provides a FastAPI backend mock pipeline and a React/Vite frontend driven by the shared `ChatTurnResponse` contract.

## Backend

Install dependencies with uv:

```bash
uv sync --dev
```

Run tests:

```bash
uv run pytest
```

Run the API locally:

```bash
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

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
npm run build
```

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
