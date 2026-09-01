# Quote Lead Refactor Phase 0 Approval — 2026-09-01

## Decision

APPROVED. The target contract, acceptance matrix, phase order, review protocol, and drift gate are frozen for implementation.

## Authoritative baseline

- Git base: `701ce56 test: strengthen quality gates and full-stack acceptance`
- Branch at inspection: `main`
- Initial worktree: clean
- Target product contract: `quote-leads-sg-v1`
- Service market: `SG`

## Reproducible gates

| Gate | Evidence |
| --- | --- |
| `npm run quote:contract:check` | 18 invariants, 10 trajectories, 8 zero-provider turns, 14 provider turns |
| `npm run quote:drift:check` | phase 0 target contract and required artifacts valid |
| `npm run docs:check` | 5 active documents checked; local links valid |
| `npm run product:check` | legacy migration baseline remains structurally valid |
| `npm run architecture:check` | current durable Conversation implementation remains singular |
| `npm run architecture:maintainability:check` | 3 façades and 7 extracted responsibility modules valid |
| `npm run typecheck` | domain, agent, runtime, and API build graph passed |
| `npm run test:unit` | 45 files and 322 tests passed |

The first sandboxed Vitest attempt failed before loading tests with Windows `spawn EPERM`. The same command was rerun outside the process sandbox under the approved `npm run test:unit` prefix and passed. This is recorded as an execution-environment constraint, not a test failure.

## Approval reflection

1. The contract fixes semantic and safety invariants, not volatile BuyWhere result counts.
2. The fixed SG scope is adapter-owned and does not reintroduce a delivery-destination user field.
3. The provider policy contains no automatic search fallback and exposes no user search mode.
4. The plan retains the proven Conversation/Turn/evidence/fencing architecture instead of introducing a second runtime.
5. The legacy product contract remains only as a migration baseline during early phases. Phase 4 cannot be approved while it remains the active business contract.

## Next authorized phase

Phase 1: implement and verify the independent BuyWhere MCP v2 Quote Provider vertical slice.
