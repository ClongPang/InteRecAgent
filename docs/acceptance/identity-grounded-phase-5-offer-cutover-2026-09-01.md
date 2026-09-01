# Identity-Grounded Quote Agent Phase 5 Approval — 2026-09-01

## Decision

APPROVED. Production target resolution and returned-Offer admission now use one versioned identity/evidence path. Brand/model knowledge is no longer embedded in `quote-target.ts`, BuyWhere remains an observation source rather than identity authority, and probabilistic identity candidates cannot enter a QuoteLead.

## Final active path

1. Runtime loads the immutable active identity snapshot and projects approved user-alias candidates to the LLM.
2. The host validates source spans and candidate references, then binds a deterministic `ProductIdentityResolution` into the domain plan.
3. Domain resolves the durable QuoteTarget from that host binding. Refreshes load the exact registry version recorded on the target and fail closed if it is unavailable.
4. Runtime calls BuyWhere once under the existing permit/fence budget and parses optional brand/model/GTIN/MPN fields into typed observation signals exactly once.
5. Domain resolves every returned Offer independently from the query target and admits only strong identifier, curated title alias, or exact lexical evidence.
6. Full observations, admission decisions, evidence refs, policy versions, and grouped QuoteLeads persist atomically; only the public projection is returned to the conversation state.

There is no active legacy title resolver, dual write, semantic fallback, or second production identity implementation. Shadow comparison consumes frozen replay labels only.

## Evidence strengths

| Strength | Publishable | Authority |
| --- | --- | --- |
| `STRONG_IDENTIFIER_MATCH` | yes | Approved registry GTIN or brand-scoped MPN matches the target Variant |
| `CURATED_TITLE_ALIAS_MATCH` | yes | Approved target-Variant title alias plus brand/attribute/role gates |
| `EXACT_LEXICAL_MATCH` | yes | Exact long-tail model literal plus brand/attribute/role gates |
| `PROBABILISTIC_CANDIDATE` | no | Plausible but non-deterministic title evidence |
| `IDENTITY_OR_ROLE_CONFLICT` | no | Identifier, sibling Variant, brand, bundle, attribute, accessory, part, or service conflict |

The initial PostgreSQL registry deliberately keeps contract-derived MPN-like identifiers in `PROPOSED`; therefore production cannot claim `STRONG_IDENTIFIER_MATCH` until an independently sourced identifier is approved. Strong-identifier behavior is exercised only by controlled fixtures.

## Reproducible gates

| Gate | Evidence |
| --- | --- |
| `npm run identity:trajectory:test` | 8 multi-turn trajectories, 19 successful turns, 1 failed-effect case, 5 rejected plans, and 11 controlled Provider calls passed; registry identity provenance is asserted across exact and confirmed targets |
| `npm run identity:agent:eval` | 8 hostile Faux-LLM protocol evaluations passed |
| `npm run identity:shadow:replay` | 9 frozen cases: 5 agreements, 4 classified differences, and 0 unexplained recall expansions |
| `npm run test:unit` | 23 files and 162 tests passed |
| `npm run test:coverage` | 27 files and 176 tests passed; overall 69.88% statements / 61.28% branches / 78.08% functions / 73.94% lines |
| `npm run test:integration` | 5 PostgreSQL files and 19 tests passed; the API vertical slice persisted a `CURATED_ALIAS` target plus `CURATED_TITLE_ALIAS_MATCH` admission/lead evidence |
| `npm run test:e2e` | Chromium exact-model quote-to-comparison flow passed |
| build/static gates | clean production build, lint, typecheck, contracts, quote/identity drift, active architecture, docs, and 56 maintainability boundaries passed |

The project PostgreSQL instance was started only for the durable integration gate and stopped successfully afterward.

## Failure-driven correction

The first registry-backed trajectory failed on “不是 XM5，是 Sony WH-1000XM4”: scanning every alias in the whole correction sentence allowed the rejected old model mention to contaminate the new target and produced `ALIAS_AMBIGUOUS`. The resolver now gives deterministic precedence to aliases matching the explicitly proposed model; other source mentions can only add evidence for that same Variant. The complete trajectory suite then passed.

This correction is structural, not a Sony exception: the resolver contains no brand/model branches, and the behavior applies to every registry Variant.

## Shadow/cutover rationale

The frozen replay intentionally contains four differences. Two are more conservative conflict classifications, one separates rejection from insufficient evidence while remaining non-publishable, and one expands recall only because an approved GTIN matches the target Variant. The replay runner rejects any unexplained `ACTIVE_MORE_PERMISSIVE` difference and permits such expansion only for `STRONG_IDENTIFIER_MATCH`.

Runtime metrics record active resolution status/strength and support classified frozen-shadow comparisons. The comparison module contains no legacy resolver and cannot affect publication.

## Next authorized phase

Phase 6: property and mutation testing, final full acceptance, sanitized live BuyWhere observation, ADR completion audit, and repository handoff/push.
