# Identity-Grounded Quote Agent Phase 2 Approval — 2026-09-01

## Decision

APPROVED. A versioned product-identity kernel, immutable PostgreSQL registry snapshot, registry port, repository, and deterministic legacy QuoteTarget upcast are implemented. Existing quote behavior remains available as `USER_CONFIRMED_LITERAL`; registry data cannot silently replace long-tail exact user models.

## Delivered semantics

- Identity outcomes: `RESOLVED`, `NEEDS_CONFIRMATION`, and `UNRESOLVED`.
- Authorization strengths: `VERIFIED_IDENTIFIER`, `CURATED_ALIAS`, `USER_CONFIRMED_LITERAL`, and `NONE`.
- Separate approved alias purposes: `USER_INPUT` and `PROVIDER_QUERY`.
- Approval lifecycle: `PROPOSED`, `APPROVED`, and `RETIRED`.
- Versioned Brand, CanonicalProduct, ProductVariant, ProductIdentifier, ProductAlias, and ProductRelationship records with source references.
- GTIN checksum validation and separate global-GTIN versus brand-scoped-MPN uniqueness.
- Ambiguous aliases return candidates for confirmation; they are never collapsed by edit distance or model confidence.
- Legacy QuoteTarget state gains deterministic identity provenance without changing `targetRef`, canonical query, or public contract.

The initial registry contains six contract brands and seven Variants. Contract-derived model identifiers are deliberately seeded as `PROPOSED`; they may support governance work but cannot authorize `VERIFIED_IDENTIFIER`. Approved curated aliases preserve existing product capability, and approved Provider-query aliases remain a distinct data purpose.

## Reproducible gates

| Gate | Evidence |
| --- | --- |
| `npm run identity:trajectory:test` | 8 multi-turn trajectories, 19 turns, 5 rejected plans, and 11 controlled Provider calls passed; legacy identity strength/evidence is asserted |
| `npm run identity:agent:eval` | 1 file and 6 hostile Faux-LLM protocol evaluations passed |
| `npm run test:unit` | 19 files and 129 tests passed, including 8 identity-kernel cases |
| `npm run test:integration` | 5 PostgreSQL files and 18 tests passed, including 9 registry/repository cases |
| `npm run typecheck` | domain, agent, runtime, API, and active scripts passed |
| `npm run lint` | zero warnings and zero errors |
| `npm run build` | clean build of every workspace and frontend passed |
| `npm run architecture:maintainability:check` | 47 responsibility modules stayed within declared boundaries |
| contract and drift gates | quote contract, identity contract, quote drift, identity drift, and docs drift all passed before approval |

The project PostgreSQL instance was started only for the integration gate and stopped successfully afterward.

## Failure-driven correction

The first repository run exposed an invalid assumption: the domain validator required a brand MPN to contain both letters and digits, while valid manufacturer/part numbers may be numeric-only. The rule was corrected to require a non-empty normalized identifier containing a digit; GTIN still requires a valid length and check digit, and MPN uniqueness remains brand-scoped. The full 18-test database suite then passed.

## Drift reflection

This phase did not move brand conditionals into SQL. The resolver algorithm contains no Sony, Apple, Samsung, Dyson, Logitech, or Nintendo branch. Brand/model knowledge is an immutable, sourced registry snapshot, and a new snapshot—not a source-code `if`—is required to change approved identity authority.

The database is not treated as automatically truthful: `PROPOSED` records remain non-authoritative, snapshots are validated again on load, and registry resolution strength is recorded separately from exact user-literal compatibility.

## Next authorized phase

Phase 3: move command decisions and state transitions into a pure domain decision/effect core, leaving the Agent executor as an effect interpreter.
