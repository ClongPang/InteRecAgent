# Identity-Grounded Quote Agent Phase 3 Approval — 2026-09-01

## Decision

APPROVED. Command decisions, confirmation creation, referent binding, quote-view transitions, Provider-result application, and operation receipts are now domain-owned pure functions. The Agent executor passes explicit effects to a Runtime-owned effect port and publishes only the completed working state.

## Ownership after refactor

| Owner | Responsibility |
| --- | --- |
| Domain | `decideQuoteCommand`, `QuoteEffect`, `applyQuoteEffectResult`, next state, receipts, and failure-state preservation |
| Agent | Bind model message ordinals, invoke policy review, sequence domain decisions, submit explicit effects, and render the validated result |
| Runtime | Interpret `QuoteEffectExecutionPort`, enforce Provider permits/budget, call BuyWhere/FX, persist evidence, and return a typed effect result |
| Repository | Fence, stage, and atomically commit the final state/reply/evidence relationship |

The production `QuoteConversationTurnExecutor` is 186 lines and no longer contains target resolution, pending-confirmation construction, exclusion/comparison/focus field assembly, lead-set application, or referent resolution.

## Reproducible gates

| Gate | Evidence |
| --- | --- |
| `npm run identity:trajectory:test` | 8 trajectories, 19 successful turns, 1 failed-effect atomicity case, 5 rejected plans, and 11 controlled successful Provider calls passed |
| domain/executor targeted tests | 4 files and 24 tests passed |
| `npm run test:unit` | 20 files and 136 tests passed |
| `npm run test:integration` | 5 PostgreSQL files and 18 tests passed |
| `npm run test:e2e` | Chromium exact-model quote-to-comparison flow passed |
| `npm run typecheck` and `npm run lint` | both passed with zero lint warnings/errors |
| `npm run architecture:maintainability:check` | 50 responsibility modules passed; new decision/effect modules and fixture split are budgeted independently |
| contract/drift gates | identity contract, quote contract, identity drift, and quote drift passed before approval |

The project PostgreSQL instance was started only for the durable integration gate and stopped successfully afterward.

## Atomic failure proof

The added production trajectory starts with a published XM5 QuoteLeadSet, proposes a target correction to XM4, and then injects `BUYWHERE_TIMEOUT`. The Provider effect is attempted exactly once, no partial draft is emitted, and the deterministic degraded publication preserves the complete XM5 target, lead set, display, exclusions, comparisons, focus, and evidence state while advancing only the turn revision.

This closes a real weakness in the earlier executor: it previously mutated its internal target before awaiting the Provider, so a later exception could leak a partial working state into fallback publication.

## Drift reflection

This is an ownership change, not a file split. The drift gate now rejects any reintroduction of target resolution, referent resolution, pending-target construction, or quote-view field assembly in the Agent executor. It also requires the Runtime effect interpreter markers. The failed-effect trajectory proves the production wiring, not just the pure helper in isolation.

## Next authorized phase

Phase 4: constrain LLM identity participation to source-spanned hypotheses and host-supplied candidate references, with deterministic clarification and fail-closed protocol evaluations.
