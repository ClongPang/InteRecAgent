# Identity-Grounded Quote Agent Phase 0 Approval — 2026-09-01

## Decision

APPROVED. The identity trust boundary, ordered delivery plan, semantic contract gate, and independent drift state are now frozen before implementation work begins.

## Authoritative baseline

- Git base: `d30077c feat: replace recommendation flow with quote lead agent`
- Branch at inspection: `main`
- Existing product contract: `quote-leads-sg-v1`
- Enhancement contract: `identity-grounded-quote-v1`
- Service market: `SG`
- Existing BuyWhere integration remains the offer source, not a product identity authority.

## Reproducible gates

| Gate | Evidence |
| --- | --- |
| `npm run identity:contract:check` | 7 ordered stages, 7 forbidden LLM authorities, and 5 offer-evidence classes validated semantically |
| `npm run identity:drift:check` | phase 0 state, contract alignment, package scripts, and acceptance-chain inclusion valid |
| `npm run quote:contract:check` | 18 invariants, 10 trajectories, 8 zero-provider turns, and 14 provider turns retained |
| `npm run quote:drift:check` | prior quote-lead refactor remains phase 5 APPROVED |
| `npm run docs:check` | 12 active documents checked; local links valid |
| `npm run architecture:maintainability:check` | 43 quote-only responsibility modules valid |
| `npm run typecheck` | domain, agent, runtime, API, and active scripts passed |
| `npm run test:unit` | 17 files and 115 tests passed |

The first sandboxed Vitest attempt failed before loading tests because Windows denied a child-process spawn with `EPERM`. The same command passed outside the process sandbox under the approved `npm run test:unit` prefix. This is an execution-environment constraint, not a product test failure.

## Root-cause and feasibility judgment

The observed bad cases do not share one missing regular expression. They share an absent identity authority and an overly coupled decision path: free-form model text, source-specific result text, lookup authorization, state mutation, and publication are too close together. Adding aliases directly to branching code would move examples without changing that failure mode.

The chosen modular-monolith design is feasible because it preserves the proven durable runtime, PostgreSQL transaction boundary, BuyWhere adapter, and public quote-lead contract. It changes the semantic center in ordered vertical slices: executable trajectories first, then a versioned identity registry, then a pure decision/effect boundary, followed by constrained LLM hypotheses and evidence-graded offer admission.

## LLM role fixed by this approval

The LLM is a constrained semantic coprocessor. It may extract source-grounded identity hypotheses, rank host-supplied candidates, propose clarifying questions, and render facts already approved by the domain. It may not invent identifiers, authorize provider calls, upgrade evidence strength, admit offers, mutate durable state, or commit transactions.

## Drift reflection

The phase-0 gate validates value matrices and ownership constraints, not merely filenames or line counts. Phase 1 must prove those constraints by executing real turn trajectories against the production executor and hostile Faux-LLM outputs.

## Next authorized phase

Phase 1: executable product contract and AI Agent trajectory/evaluation baseline.
