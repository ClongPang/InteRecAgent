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

Run the combined MVP validation gate from the repository root:

```bash
python3 scripts/validate_mvp.py
```

Use `--skip-e2e` or `--skip-live-integration` when local port binding is unavailable. Add `--include-artifact-gate` after `data/catalog` has been built and readiness passes.
Add `--generate-eval-cases` to create and validate the 100-300 labeled task evaluation set before running the normal gates.
Use `--require-system-readiness` for final artifact validation; it requires catalog, vector index, evaluation cases, and profile readiness before running the normal tests and live integration.
To build from local Amazon-style data and then run readiness plus the artifact gate in one pass:

```bash
python3 scripts/validate_mvp.py \
  --metadata /path/to/meta.jsonl.gz \
  --reviews /path/to/reviews.jsonl.gz \
  --artifact-dir data/catalog \
  --build-index \
  --build-profiles
```

When artifact flags are used, `validate_mvp.py` passes the same paths and thresholds into the live FastAPI integration server. This keeps `/api/internal/readiness` aligned with the build gates instead of falling back to defaults.

| Validation option | Runtime env used by readiness |
|---|---|
| `--artifact-dir`, `--target-min`, `--target-max`, `--demo-limit` | `INTEREC_CATALOG_PATH`, `INTEREC_TARGET_MIN`, `INTEREC_TARGET_MAX`, `INTEREC_DEMO_LIMIT` |
| `--index-dir`, `--index-min-products` | `INTEREC_INDEX_PATH`, `INTEREC_INDEX_MIN_PRODUCTS` |
| `--profile-dir`, `--profile-min-profiles` | `INTEREC_PROFILE_PATH`, `INTEREC_PROFILE_MIN_PROFILES` |
| `--eval-cases`, `--eval-min-cases`, `--eval-max-cases` | `INTEREC_EVAL_CASES_PATH`, `INTEREC_EVAL_MIN_CASES`, `INTEREC_EVAL_MAX_CASES` |

Run the API locally:

```bash
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

Build local catalog artifacts from Amazon-style JSONL metadata and reviews:

```bash
uv run python -m backend.app.data_pipeline.catalog_builder \
  --metadata /path/to/meta.jsonl.gz \
  --reviews /path/to/reviews.jsonl.gz \
  --output data/catalog \
  --target-min 20000 \
  --target-max 50000
```

The builder accepts plain `.jsonl` and gzipped `.jsonl.gz` files. It streams metadata rows, keeps only the capped target catalog in memory, and writes `normalized_catalog.jsonl`, `curated_demo_pool.jsonl`, and `quality_report.json`.
When `data/catalog/normalized_catalog.jsonl` exists, the API loads it at startup; set `INTEREC_CATALOG_PATH=/path/to/normalized_catalog.jsonl` to test another artifact.

Validate catalog readiness after building artifacts:

```bash
uv run python -m backend.app.data_pipeline.catalog_readiness \
  --artifact-dir data/catalog \
  --target-min 20000 \
  --target-max 50000
```

The readiness check fails if required files are missing, product counts fall outside the target range, the demo pool is incomplete, or `quality_report.json` disagrees with the normalized catalog.

Build and validate deterministic vector index artifacts:

```bash
uv run python -m backend.app.data_pipeline.vector_index_builder \
  --catalog data/catalog/normalized_catalog.jsonl \
  --output data/indexes

uv run python -m backend.app.data_pipeline.vector_index_readiness \
  --artifact-dir data/indexes
```

When `data/indexes/product_index.jsonl` exists, retrieval loads it at startup; set `INTEREC_INDEX_PATH=/path/to/product_index.jsonl` to test another index artifact.

After readiness passes, verify the backend runtime against the generated artifact:

```bash
uv run pytest tests/integration/ -m "artifact"
```

Generate the larger labeled task evaluation set described in `docs/evaluation_plan.md`:

```bash
uv run python -m backend.app.services.evaluation_case_generator \
  --output data/eval/task_cases.jsonl \
  --count 140
```

Or include it in the combined validation gate:

```bash
python3 scripts/validate_mvp.py --generate-eval-cases
```

Build internal user profile artifacts from review behavior:

```bash
uv run python -m backend.app.data_pipeline.profile_builder \
  --reviews /path/to/reviews.jsonl.gz \
  --catalog data/catalog/normalized_catalog.jsonl \
  --output data/profiles
```

Validate profile readiness:

```bash
uv run python -m backend.app.data_pipeline.profile_readiness \
  --artifact-dir data/profiles
```

When `data/profiles/user_profiles.jsonl` exists, the API can use it as an internal weak ranking signal. Set `INTEREC_PROFILE_PATH=/path/to/user_profiles.jsonl` to test another artifact, then include `user_id` in `/api/chat` requests. Profile affinity is applied only after hard constraint filtering and appears in `score_breakdown.profile_affinity` plus `trace_summary.ranking_summary.profile_applied`.

Optional live LLM settings can be placed in the ignored root `.env` file. Prefer an http(s) endpoint in `DeepSeek_BASE_URL`, keep the secret token in `DeepSeek_API_KEY`, and set `DeepSeek_MODEL` when overriding the default model. For local compatibility, a `sk-...` value accidentally placed in `DeepSeek_BASE_URL` is treated as the API key and the adapter uses the default DeepSeek endpoint.

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
