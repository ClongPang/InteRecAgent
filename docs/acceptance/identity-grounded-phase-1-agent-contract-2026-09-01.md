# Identity-Grounded Quote Agent Phase 1 Approval — 2026-09-01

## Decision

APPROVED. The product contract now executes through the production `QuoteConversationTurnExecutor`, and the LLM protocol is evaluated with controlled hostile outputs. Route, operation order, Provider-call budget, assistant outcome, disclosures, durable state, and forbidden claims are asserted per turn.

## Executable evidence

| Gate | Evidence |
| --- | --- |
| `npm run identity:trajectory:test` | 8 multi-turn trajectories, 19 turns, 5 rejected plans, and 11 controlled Provider calls passed |
| `npm run identity:agent:eval` | 1 file and 6 Faux-LLM protocol evaluations passed |
| `npm run test:unit` | 18 files and 121 tests passed |
| `npm run typecheck` | domain, agent, runtime, API, and active trajectory script passed |
| `npm run lint` | zero warnings and zero errors |
| `npm run build` | all workspaces and frontend production build passed |
| `npm run quote:contract:check` | 18 invariants and 10 legacy product trajectories retained with the runtime route vocabulary |
| `npm run identity:contract:check` | 7 stages, 7 forbidden LLM authorities, and 5 offer-evidence classes valid |
| `npm run architecture:maintainability:check` | 44 responsibility modules, including the trajectory harness, stayed within boundaries |
| `npm run identity:drift:check` | phase-1 artifacts, ordered state, and default-acceptance inclusion valid before approval |

Vitest and tsx/esbuild gates were run outside the process sandbox under their scoped approved prefixes because Windows denied child-process startup with `spawn EPERM` inside the sandbox. No product assertion was skipped.

## Product drift found and corrected

1. The natural-language contract used `lookup`, while production used `quote_lookup` and `quote_followup`. The contract now uses the production four-route vocabulary and its checker enforces exact equality.
2. Durable exclusion worked, but an inspection reply did not explain why a lead remained hidden. The common host renderer now explains exclusion state from the validated projection and still spends zero Provider calls.
3. A missing CNY projection was silently omitted during inspection. The common renderer now states that no publishable CNY estimate exists while preserving original currency as primary.
4. A changed model digit failed closed, but an ordering bug made the specific `LOOKUP_BEFORE_MODEL_CONFIRMATION` diagnostic unreachable. The pure policy gate now checks pending confirmation before the generic missing-target condition.

These corrections are centralized in the existing policy and renderer responsibilities. No brand-specific branch, test-only executor, fallback query, or alternate runtime was introduced.

## AI Agent acceptance

- A lexically grounded punctuation alias can be proposed by the LLM, but canonicalization and the one-call authorization remain host-owned.
- An invented model digit receives exactly one structured repair opportunity. Only the repaired grounded plan can call the Provider.
- Two invalid identity proposals exhaust the bounded protocol and publish a deterministic degraded reply with zero Provider calls and no target mutation.
- Prompt injection cannot relabel an accessory as the primary product.
- Free-text refusal to use the required tool cannot publish model-authored quote claims.
- A pre-aborted turn cannot reach the Provider.

## Fundamental reflection

This phase proves host safety under arbitrary model proposals, not that one model memorized the examples. The matrix deliberately separates approved trajectories from rejected plans and asserts effects and state, rather than counting textual assertions in a JSON file.

## Next authorized phase

Phase 2: replace hard-coded identity authority with a versioned minimal product identity kernel and deterministic legacy-literal compatibility.
