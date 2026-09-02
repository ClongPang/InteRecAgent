import {
  resolveQuoteTarget,
  type PublishedQuoteLead,
  type PublishedQuoteLeadSet,
  type QuoteTarget,
} from "@retail-price/domain";

export type ProviderFixture = "RESULTS_ONE" | "RESULTS_TWO" | "GROUPED_NO_FX" | "EMPTY" | "DEGRADED";

const OBSERVED_AT = "2026-09-01T00:00:00.000Z";

export function resolveFixtureTarget(model = "WH-1000XM5"): QuoteTarget {
  const result = resolveQuoteTarget({ rawText: `Sony ${model}`, proposedModel: model, brand: "Sony" });
  if (result.status !== "RESOLVED") throw new Error(`fixture target did not resolve: ${model}`);
  return result.target;
}

function lead(
  target: QuoteTarget,
  quoteLeadRef: string,
  merchant: string,
  amount: string,
  options: { condition?: PublishedQuoteLead["condition"]; observationCount?: number; currency?: string } = {},
): PublishedQuoteLead {
  const condition = options.condition ?? "NEW";
  return {
    quoteLeadRef,
    canonicalModel: target.canonicalModel,
    representativeTitle: `${target.brand ?? "Product"} ${target.canonicalModel} ${condition}`,
    condition,
    merchantLabel: merchant,
    merchantDomain: `${merchant.toLocaleLowerCase("en-US")}.example`,
    outboundUrl: `https://${merchant.toLocaleLowerCase("en-US")}.example/products/${encodeURIComponent(target.canonicalModel)}`,
    priceRanges: [{ originalPrice: { currency: options.currency ?? "SGD", minAmount: amount, maxAmount: amount }, cnyEstimate: null }],
    observationCount: options.observationCount ?? 1,
    firstObservedAt: OBSERVED_AT,
    latestObservedAt: OBSERVED_AT,
  };
}

export function providerResult(target: QuoteTarget, fixture: ProviderFixture, callOrdinal: number): PublishedQuoteLeadSet {
  const common = {
    contractVersion: "quote-leads-sg-v1" as const,
    quoteLeadSetRef: `qls_trajectory_${target.targetRef.slice(-8)}_${callOrdinal}`,
    targetRef: target.targetRef,
    providerContractVersion: "buywhere-controlled-trajectory-v1",
    observedAt: new Date(Date.parse(OBSERVED_AT) + callOrdinal * 1_000).toISOString(),
  };
  if (fixture === "EMPTY") {
    return { ...common, outcome: "NO_QUOTE_LEADS", reasonCodes: ["PROVIDER_RETURNED_EMPTY"], providerStatus: "OK_EMPTY", providerFailureCode: null, providerRetryable: null, leads: [] };
  }
  if (fixture === "DEGRADED") {
    return { ...common, outcome: "DEGRADED", reasonCodes: ["PROVIDER_DEGRADED"], providerStatus: "DEGRADED", providerFailureCode: "BUYWHERE_TIMEOUT", providerRetryable: true, leads: [] };
  }
  const leads = fixture === "RESULTS_TWO"
    ? [lead(target, "ql_merchant_a_new", "MerchantA", "399.00"), lead(target, "ql_merchant_b_new", "MerchantB", "419.00")]
    : fixture === "GROUPED_NO_FX"
      ? [lead(target, "ql_grouped_refurbished", "MerchantGrouped", "249.00", { condition: "REFURBISHED", observationCount: 9, currency: "USD" })]
      : [lead(target, "ql_merchant_a_new", "MerchantA", "399.00")];
  return { ...common, outcome: "QUOTE_LEADS", reasonCodes: [], providerStatus: "OK_RESULTS", providerFailureCode: null, providerRetryable: null, leads };
}
