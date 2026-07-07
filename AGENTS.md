# Repository Guidelines

## Project Structure & Module Organization

This repository is currently documentation-first. `main.py` is a placeholder Python entry point, `docs/` contains product, architecture, data, evaluation, and roadmap material, and `docs/prototype/index.html` is the static UI prototype. The intended implementation layout is documented in `docs/system_architecture.md`: place backend code under `backend/app/`, frontend code under `frontend/src/`, datasets and generated indexes under `data/`, and automated tests under `tests/`. Keep long-form design notes in `docs/` and avoid mixing implementation files into the prototype directory.

## Build, Test, and Development Commands

- `python3 main.py`: runs the current placeholder script.
- `python3 -m http.server 8000 --directory docs/prototype`: previews the static prototype at `http://localhost:8000`.
- `python3 -m pytest`: run the test suite once `tests/` exists.

There is no dependency manifest yet. When adding real backend or frontend code, introduce `pyproject.toml`, `requirements.txt`, or `package.json` with the new commands in the same change.

## Coding Style & Naming Conventions

Use 4-space indentation for Python. Prefer `snake_case` for modules, functions, and variables; `PascalCase` for classes and schema models; and clear service names such as `intent_parser.py` or `constraint_verifier.py`. Keep agent pipeline modules small and aligned with the architecture docs. For future React code, use `PascalCase` components and colocate component-specific state or styles under `frontend/src/`. Markdown docs should use descriptive headings and stable terminology from the PRD.

## Testing Guidelines

Use `pytest` for backend, pipeline, and evaluation tests. Name files `test_<module>.py` and test functions `test_<behavior>()`. Store golden recommendation cases as JSONL when needed and experiment settings as YAML, matching the evaluation plan. Prioritize tests for task routing, intent parsing, constraint verification, evidence grounding, reranking, feedback updates, and API contracts.

## Commit & Pull Request Guidelines

This checkout has no Git history, so use a simple Conventional Commits style going forward: `feat: add retriever service`, `fix: enforce price constraint`, or `docs: update evaluation plan`. Pull requests should include a short problem statement, summary of changes, test results, linked issue or task, and screenshots for UI/prototype changes. Call out data assumptions, new environment variables, and any LLM prompt or schema changes.

## Security & Configuration Tips

Do not commit raw private datasets, API keys, generated indexes, `.DS_Store`, or IDE metadata. Keep secrets in local environment files that are ignored by Git, and document required variables in an example config instead of hard-coding them.
