# Quote Lead Refactor Phase 1 Approval — 2026-09-01

## Decision

APPROVED. The independent BuyWhere MCP v2 Quote Provider vertical slice correctly separates transport, envelope parsing, provider status, and the future domain normalization boundary.

## Implementation evidence

- `QuoteProvider` exposes only a confirmed canonical query and `OK_RESULTS | OK_EMPTY | DEGRADED | FAILED`.
- `BuyWhereMcpQuoteClient` calls only `find_best_price_v2` with adapter-owned `deliver_to: "SG"`.
- `buywhere-mcp-quote-parser.ts` parses both the live `best_price + alternatives` shape and generic array envelopes.
- HTTP status, JSON-RPC error, timeout, external cancellation, degraded envelope, empty response, and contract drift have separate behavior.
- No keyword, semantic, hybrid, REST sort, or other automatic fallback exists in the adapter.
- Transport and pure envelope parsing are separate responsibility modules.

## Reproducible development gates

| Gate | Evidence |
| --- | --- |
| `npm run quote:contract:check` | 18 invariants and 10 trajectories valid |
| `npm run quote:drift:check` | phase 1 provider markers and no-fallback rules valid |
| `npm run typecheck` | domain, agent, runtime, and API graph passed |
| `npm run architecture:maintainability:check` | 3 façades and 8 responsibility modules valid |
| `npm run architecture:check` | existing durable runtime remains the only active runtime |
| `npm run test:unit` | 46 files and 336 tests passed |

## Live BuyWhere evidence

All calls were read-only, authenticated with the configured key, fixed to SG inside the adapter, and emitted no secret or product body.

1. `Sony WH-1000XM5`
   - observed at `2026-09-01T03:22:27.849Z`
   - result: `DEGRADED`
   - meta: `status=degraded`, `emptinessReason=timeout`, `engineStatus=degraded`
   - normalized failure: `BUYWHERE_DEGRADED_TIMEOUT`, retryable
   - conclusion: the adapter does not convert timeout into empty/no-quote.
2. `Sony WH-1000XM5 headphones`
   - observed at `2026-09-01T03:22:42.036Z`
   - result: `OK_RESULTS`
   - record count: 9
   - live shape: one `best_price` plus eight `alternatives`
   - records expose id, title, original price/currency, merchant, URL, image, country code, and outbound URL.

The query-dependent difference is not interpreted as BuyWhere fuzzy behavior. It proves that Phase 2 must own deterministic canonical query construction and preserve the product-type context; the LLM must not improvise or progressively broaden queries.

## Approval reflection

1. A first live probe revealed a real envelope-shape mismatch and initially produced contract drift. The parser was corrected from live structural evidence, not by weakening the status rules.
2. Degraded classification now takes precedence even if a degraded envelope later omits a recognized record container.
3. Successful records already contain merchant and outbound URLs. `get_product_v2` remains an optional bounded enrichment path only when a displayed record lacks required fields; it is not required for every record.
4. The provider adapter contains no business admission, grouping, ranking, FX, persistence, or user wording logic. Those remain Phase 2 responsibilities.

## Next authorized phase

Phase 2: implement QuoteTarget, QuoteObservation, strict admission, merchant-page grouping, FX-optional projection, QuoteLeadSet semantics, evidence, and persistence.
