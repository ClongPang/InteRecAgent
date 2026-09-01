# Identity-Grounded Quote Agent Phase 4 Approval — 2026-09-01

## Decision

APPROVED. The LLM is now a constrained semantic coprocessor: it can propose source-spanned identity claims and select only a host-projected Variant candidate. It cannot authorize a Provider call, invent a candidate reference, silently change model alphanumerics, or use confidence to raise identity authority.

## Enforced trust boundary

- Every `SET_QUOTE_TARGET` model output must include an `IdentityHypothesis` with exact UTF-16 source spans for model, brand, product type, and qualifiers.
- The host re-slices the cited current user message and rejects rewritten, overlapping, out-of-bounds, or mismatched claims.
- `selectedVariantRef` is accepted only from the immutable active-registry candidate allowlist projected by Runtime; it is stripped from the domain plan after host review.
- A changed model literal plus a Provider operation is rejected before effect execution, even when model confidence is `1`.
- Non-literal expansions may only enter the existing clarification path with zero Provider calls.
- Prompt instructions are advisory; all authority-bearing constraints are independently enforced by schema and host code.

## Reproducible gates

| Gate | Evidence |
| --- | --- |
| `npm run identity:agent:eval` | 8 Faux-LLM protocol evaluations passed, including allowed candidate selection, invented candidate repair, digit mutation with confidence 1, repair exhaustion, prompt injection, refusal, and cancellation |
| `npm run identity:trajectory:test` | 8 multi-turn trajectories, 19 successful turns, 1 failed-effect case, 5 rejected plans, and 11 controlled successful Provider calls passed |
| identity-focused tests | 5 files and 31 tests passed, including source-span, candidate, schema, context, executor, and Agent protocol cases |
| `npm run test:unit` | 21 files and 148 tests passed |
| `npm run test:integration` | 5 PostgreSQL files and 19 tests passed; the API vertical slice selected a persisted allowlisted Variant |
| `npm run typecheck` and `npm run lint` | both passed with zero errors/warnings |
| `npm run build` | all workspaces and the Vite production bundle built successfully |
| contract/drift/maintainability gates | quote and identity contracts/drift passed; 51 responsibility modules stayed within declared budgets |

The project PostgreSQL instance was started only for the durable identity/vertical-slice gate and stopped successfully afterward.

## Failure-driven correction

The first full integration run produced a deterministic degraded reply because the existing Faux-LLM API fixture still emitted the retired target shape without `identityHypothesis`. The fixture was upgraded to cite exact model/brand/product-type spans and the persisted `variant_sony_wh1000xm5` candidate. The complete 19-test PostgreSQL suite then passed. This demonstrates that the model-facing protocol is enforced in the real Worker path rather than only in unit tests.

## Drift reflection

The phase gate now requires the closed model schema, source-span validation, candidate allowlist rejection, changed-model lookup rejection, active PostgreSQL candidate projection, and removal of model confidence from domain authorization modules. A future prompt edit cannot weaken these host gates.

## Next authorized phase

Phase 5: replace title-regex admission with explicit target/Offer identity evidence strengths, bind the active identity registry into the production target path, add shadow comparison/metrics, and cut over to one deterministic resolver path.
