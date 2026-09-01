# Identity-Grounded Quote Agent Phase 6 Final Approval — 2026-09-01

## Decision

APPROVED. The quote path is no longer governed by accumulating brand/model exceptions. A versioned Product identity registry, deterministic target and Offer evidence resolvers, pure Domain command/effect transitions, and one atomic publication path now own authorization. LLM participation is constrained to semantic hypothesis work behind host validation.

## Root cause and final solution

The root cause was an ownership error, not a missing regex: conversational strings, hard-coded brand knowledge, Provider titles, query authorization, Offer admission, and state mutation were jointly deciding “which product is this”. Every new exception could repair one example while weakening auditability elsewhere.

The final path separates those authorities:

1. PostgreSQL stores immutable, versioned Brand/Product/Variant/Alias/Identifier snapshots with source and approval state.
2. The LLM proposes source-spanned identity hypotheses and may rank only host-projected candidates.
3. Host code re-slices the original UTF-16 text, rejects invented spans/candidates and binds registry resolution.
4. Pure Domain logic decides commands and emits Effects; Runtime alone executes the single budgeted Provider call.
5. Query target and every returned Offer are resolved independently. Only approved identifier, curated alias, or exact lexical evidence can publish; probabilistic candidates and role/Variant conflicts remain observations.
6. The exact registry version, policy version, evidence refs, observations, admissions and grouped leads persist under the existing fence/revision atomic commit.

There is no active legacy resolver, dual write, permanent shadow resolver, LLM confidence gate, semantic fallback, or brand-specific target branch.

## LLM role

LLM is a semantic coprocessor. It can extract brand/model/product-type/qualifier claims with exact source spans, rank an allowlisted candidate set, propose a clarification, and render explanations from approved facts. This improves long-tail language understanding without making probabilistic output authoritative.

LLM cannot invent identifiers or candidates, silently alter model alphanumerics, authorize Provider calls, exceed the one-call budget, promote evidence strength, admit or group Offers, mutate durable state, or commit a transaction. Confidence is informational only. Uncertainty may cause clarification or fail-closed behavior; it can never create publication permission.

## Feasibility and confidence evidence

| Gate | Final evidence |
| --- | --- |
| executable trajectories | 8 multi-turn trajectories, 19 turns, 1 failed Effect, 5 rejected plans, 11 controlled successful Provider calls |
| hostile Faux-LLM eval | 8/8 passed, including span invention, candidate invention and changed-model/provider gates |
| shadow replay | 9 cases, 5 agreements, 4 classified differences, 0 unexplained recall expansions |
| property testing | fixed seed `0x1d3a2026`; 4 properties × 256 generated runs, with counterexample shrinking |
| mutation testing | 5/5 critical mutants killed: probabilistic publication, reversed alias conflict, reversed model gate, two-call budget and deleted confirmation gate |
| unit suite | 24 files, 166 tests passed |
| coverage suite | 28 files, 181 tests passed; 69.86% statements / 61.33% branches / 78.08% functions / 73.92% lines |
| PostgreSQL integration | 5 files, 19 tests passed, including migration, versioned snapshot replay and API vertical persistence |
| browser E2E | Chromium exact-model quote-to-comparison flow passed |
| static/architecture | clean build, lint, typecheck, contract/drift/docs checks, 58 maintainability modules and 88 production files passed |

## Real BuyWhere validation

Five explicitly authorized, read-only BuyWhere calls ran with a 30-second timeout and 10-second spacing. The accepted observation set contained 1 `OK_RESULTS` and 4 `OK_EMPTY` cases. Sony primary returned 9 raw observations; all 9 were admitted as `EXACT_LEXICAL_MATCH`. Accessory, service, obscure-model and Dyson cases published no fabricated leads. Eleven Provider-evaluated live/replay/controlled cases passed the deterministic identity publication assertion.

Earlier transient attempts (10 `DEGRADED`, 14 `FAILED`) remain counted in the audit evidence and were not rewritten as empty results. The source-controlled evidence is [identity-grounded-buywhere-acceptance-evidence.json](../../spec/identity-grounded-buywhere-acceptance-evidence.json); the local full sanitized report hash is `sha256:c266f744d695af3709c43e306bb71c7b96f34a56b71eb0318ae0da6511d696fe`. API keys, raw Provider payloads, and raw merchant URLs were not persisted.

This live result validates the observed Provider boundary on 2026-09-01; it does not claim future availability, merchant inventory, fuzzy-search behavior, or result counts.

## Operational conclusion

The design is feasible because it preserves the modular monolith and existing atomic commit instead of introducing a knowledge-graph service or Event Sourcing rewrite. Identity data can be governed incrementally, unknown long-tail models still work as explicitly labeled user-confirmed literals, and strong identifiers can be approved later without changing the decision path. Failure modes are conservative and observable.

The project PostgreSQL instance was started only for the integration gate and stopped successfully afterward. `npm run acceptance` passed in full before this approval record was written.
