import type { PublishedQuoteLeadSet, QuoteEffect } from "@interec/domain";

import { observeTurnExecutorStep } from "./turn-observability.js";

export interface QuoteLookupHostOutcome {
  leadSet: PublishedQuoteLeadSet;
  cacheHit: boolean;
}

/** Logical host boundary: cache lookup, provider governance, normalization, FX, and persistence. */
export function observeQuoteLookupHost(
  effect: Extract<QuoteEffect, { kind: "QUOTE_LOOKUP" }>,
  operation: () => Promise<QuoteLookupHostOutcome>,
): Promise<QuoteLookupHostOutcome> {
  return observeTurnExecutorStep(
    "quote-lookup",
    { operationKind: effect.operationKind, targetRef: effect.target.targetRef },
    operation,
    ({ leadSet, cacheHit }) => ({
      cacheHit,
      providerInvocation: cacheHit ? "ATTEMPT_REPLAY" : "LIVE",
      outcome: leadSet.outcome,
      providerStatus: leadSet.providerStatus,
      providerFailureCode: leadSet.providerFailureCode,
      quoteLeadCount: leadSet.leads.length,
    }),
    { provider: "buywhere", providerTool: "find_best_price_v2" },
  );
}
