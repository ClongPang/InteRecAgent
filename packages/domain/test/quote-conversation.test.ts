import {
  emptyQuoteConversationState,
  projectPublishedQuoteLeadSet,
  resolveQuoteLeadReferents,
  resolveQuoteTarget,
  reviewQuoteTurnPlan,
  validateQuoteConversationState,
  type QuoteLeadSet,
  type QuoteTurnPlan,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

function resolvedTarget() {
  const resolution = resolveQuoteTarget({
    rawText: "Sony WH-1000XM5 headphones",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  if (resolution.status !== "RESOLVED") throw new Error("fixture target did not resolve");
  return resolution.target;
}

function internalLeadSet(): QuoteLeadSet {
  const target = resolvedTarget();
  return {
    contractVersion: "quote-leads-sg-v1",
    quoteLeadSetRef: "qls_test",
    target,
    outcome: "QUOTE_LEADS",
    reasonCodes: [],
    provider: { status: "OK_RESULTS", failureCode: null, retryable: null, contractVersion: "buywhere-test", meta: { availability: "available" } },
    observations: [{
      observationRef: "qo_1",
      provider: "buywhere",
      providerRecordId: "secret-id",
      recordIndex: 0,
      jsonPath: "$.best_price",
      artifactRef: "sha256:test",
      observedAt: "2026-09-01T00:00:00.000Z",
      title: "Sony WH-1000XM5 Headphones",
      originalMoney: { amount: "249.99", currency: "USD" },
      merchantLabel: "Example merchant",
      merchantTargetUrl: "https://merchant.example/item/1",
      merchantDomain: "merchant.example",
      outboundUrl: "https://buywhere.example/out/1",
      imageUrl: null,
      providerCountry: "US",
      providerUpdatedAt: null,
      providerAvailability: "available",
      condition: "NEW",
      rawRecord: { id: "secret-id", availability: "available" },
    }],
    admissions: [{ observationRef: "qo_1", status: "ELIGIBLE", reasonCodes: [], policyVersion: "quote-admission-v1" }],
    leads: [{
      quoteLeadRef: "ql_1",
      targetRef: target.targetRef,
      canonicalModel: target.canonicalModel,
      representativeTitle: "Sony WH-1000XM5 Headphones",
      condition: "NEW",
      merchantLabel: "Example merchant",
      merchantDomain: "merchant.example",
      merchantTargetUrl: "https://merchant.example/item/1",
      outboundUrl: "https://buywhere.example/out/1",
      priceRanges: [{
        currency: "USD",
        minAmount: "249.99",
        maxAmount: "249.99",
        observationRefs: ["qo_1"],
        cnyEstimate: null,
      }],
      observationRefs: ["qo_1"],
      observationCount: 1,
      firstObservedAt: "2026-09-01T00:00:00.000Z",
      latestObservedAt: "2026-09-01T00:00:00.000Z",
      latestProviderUpdatedAt: null,
      disclosureCode: "MERCHANT_PAGE_CHECK_REQUIRED",
      groupingPolicyVersion: "merchant-page-condition-v1",
    }],
    fxSnapshots: [],
    observedAt: "2026-09-01T00:00:00.000Z",
  };
}

function stateWithLead() {
  const leadSet = projectPublishedQuoteLeadSet(internalLeadSet());
  return validateQuoteConversationState({
    ...emptyQuoteConversationState(1),
    target: resolvedTarget(),
    leadSet,
    displayQuoteLeadRefs: ["ql_1"],
  });
}

describe("quote conversation public contract", () => {
  it("projects only safe quote fields and removes raw/provider availability data", () => {
    const projection = projectPublishedQuoteLeadSet(internalLeadSet());
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("rawRecord");
    expect(serialized).not.toContain("availability");
    expect(serialized).not.toContain("secret-id");
    expect(projection.leads[0]?.priceRanges[0]?.originalPrice).toEqual({ currency: "USD", minAmount: "249.99", maxAmount: "249.99" });
  });

  it("rejects a public-state stock field even if a caller bypasses TypeScript", () => {
    const state = stateWithLead() as unknown as Record<string, unknown>;
    (state["leadSet"] as Record<string, unknown>)["stock"] = "IN_STOCK";
    try {
      validateQuoteConversationState(state as never);
      throw new Error("expected quote public-field validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "QUOTE_PUBLIC_FIELD_FORBIDDEN" });
    }
  });

  it("resolves display ranks without changing the evidence set", () => {
    expect(resolveQuoteLeadReferents(stateWithLead(), [{ kind: "DISPLAY_RANK", rank: 1 }])).toEqual({ status: "RESOLVED", quoteLeadRefs: ["ql_1"] });
    expect(resolveQuoteLeadReferents(stateWithLead(), [{ kind: "DISPLAY_RANK", rank: 2 }])).toEqual({ status: "NOT_FOUND", quoteLeadRefs: [] });
  });
});

describe("quote plan policy", () => {
  const exactPlan: QuoteTurnPlan = {
    userIntentSummary: "look up exact model",
    ops: [
      {
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        source: { messageId: "m1" },
        target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: "headphones", requiredQualifiers: [], conditionPreference: "ANY" },
      },
      { opId: "lookup", kind: "LOOKUP_QUOTES" },
    ],
  };

  it("approves an exact grounded model and one lookup", () => {
    expect(reviewQuoteTurnPlan({
      plan: exactPlan,
      state: emptyQuoteConversationState(),
      currentUserMessages: [{ messageId: "m1", content: "Sony WH-1000XM5 headphones" }],
    })).toMatchObject({ decision: "APPROVED", providerCallsAllowed: 1, route: "quote_lookup" });
  });

  it("rejects a refresh unless the user explicitly requests it", () => {
    const result = reviewQuoteTurnPlan({
      plan: { userIntentSummary: "inspect current result", ops: [{ opId: "refresh", kind: "REFRESH_QUOTES" }] },
      state: stateWithLead(),
      currentUserMessages: [{ messageId: "m2", content: "what happened last time?" }],
    });
    expect(result).toMatchObject({ decision: "REPAIR_REQUIRED", violations: [{ code: "QUOTE_REFRESH_NOT_EXPLICIT" }] });
  });

  it("approves focus/compare inspection with zero provider calls", () => {
    const result = reviewQuoteTurnPlan({
      plan: { userIntentSummary: "focus first", ops: [{ opId: "focus", kind: "SET_QUOTE_FOCUS", referent: { kind: "DISPLAY_RANK", rank: 1 } }] },
      state: stateWithLead(),
      currentUserMessages: [{ messageId: "m2", content: "focus the first quote" }],
    });
    expect(result).toMatchObject({ decision: "APPROVED", providerCallsAllowed: 0, route: "quote_followup" });
  });

  it("blocks accessory and repair targets before any provider call", () => {
    const result = reviewQuoteTurnPlan({
      plan: exactPlan,
      state: emptyQuoteConversationState(),
      currentUserMessages: [{ messageId: "m1", content: "Sony WH-1000XM5 replacement ear pads" }],
    });
    expect(result).toMatchObject({ decision: "REPAIR_REQUIRED", violations: [{ code: "QUOTE_PRIMARY_PRODUCT_REQUIRED" }] });
  });
});
