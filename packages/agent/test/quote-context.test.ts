import {
  emptyQuoteConversationState,
  resolveQuoteTarget,
  type PublishedQuoteLeadSet,
} from "@interec/domain";
import { describe, expect, it } from "vitest";

import { projectQuoteConversationContext } from "../src/quote-context.js";

function target() {
  const resolved = resolveQuoteTarget({
    rawText: "Sony WH-1000XM5 headphones",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  if (resolved.status !== "RESOLVED") throw new Error("target fixture failed");
  return resolved.target;
}

function leadSet(count = 1): PublishedQuoteLeadSet {
  const quoteTarget = target();
  return {
    contractVersion: "quote-leads-sg-v1",
    quoteLeadSetRef: "qls_context",
    targetRef: quoteTarget.targetRef,
    outcome: "QUOTE_LEADS",
    reasonCodes: [],
    providerStatus: "OK_RESULTS",
    providerFailureCode: null,
    providerRetryable: null,
    providerContractVersion: "buywhere-test",
    leads: Array.from({ length: count }, (_, index) => ({
      quoteLeadRef: `ql_${index}`,
      canonicalModel: quoteTarget.canonicalModel,
      representativeTitle: `Sony WH-1000XM5 quote ${index}`,
      condition: "NEW" as const,
      merchantLabel: `Merchant ${index}`,
      merchantDomain: `merchant-${index}.example`,
      outboundUrl: `https://merchant-${index}.example/product`,
      priceRanges: [{
        originalPrice: { currency: "SGD", minAmount: "399.00", maxAmount: "419.00" },
        cnyEstimate: null,
      }],
      observationCount: 1,
      firstObservedAt: "2026-09-01T00:00:00.000Z",
      latestObservedAt: "2026-09-01T00:00:00.000Z",
    })),
    observedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("quote conversation context projection", () => {
  it("projects only bounded public planning evidence and the fixed SG runtime scope", () => {
    const quoteTarget = target();
    const state = {
      ...emptyQuoteConversationState(3),
      target: quoteTarget,
      leadSet: leadSet(25),
      displayQuoteLeadRefs: Array.from({ length: 25 }, (_, index) => `ql_${index}`),
      excludedQuoteLeadRefs: [],
      comparisonQuoteLeadRefs: ["ql_0", "ql_1"],
      focusQuoteLeadRef: "ql_0",
    };
    const projection = projectQuoteConversationContext({
      state,
      currentUserMessages: [`  ${"x".repeat(2_600)}  `],
      recentAdjacentPair: [
        { role: "USER", content: "old" },
        { role: "ASSISTANT", content: `  ${"a".repeat(1_600)}  ` },
        { role: "USER", content: "most recent user" },
      ],
      now: "2026-09-01T08:00:00+08:00",
      modelId: "faux-model",
      providerCallBudget: 1,
    });

    expect(projection.contractVersion).toBe("quote-leads-sg-v1");
    expect(projection.runtime).toMatchObject({
      serviceMarket: "SG",
      providerCallBudget: 1,
      now: "2026-09-01T00:00:00.000Z",
      modelId: "faux-model",
    });
    expect(projection.currentUserMessages[0]).toMatchObject({ ordinal: 0, truncated: true });
    expect(projection.currentUserMessages[0]?.content.length).toBe(2_500);
    expect(projection.recentAdjacentPair).toHaveLength(2);
    expect(projection.recentAdjacentPair[0]).toMatchObject({ role: "ASSISTANT", truncated: true });
    expect(projection.quoteState.leadSet?.leads).toHaveLength(20);
    expect(projection.quoteState.leadSet?.leads[0]).not.toHaveProperty("outboundUrl");
    expect(projection.runtime.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("projects only validated host identity candidates and caps the allowlist", () => {
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      registryVersion: 7,
      brandRef: "brand_sony",
      productRef: "product_sony_wh1000x",
      variantRef: `variant_sony_${index}`,
      canonicalModel: `WH-1000XM${index}`,
      evidenceRefs: [`alias_sony_${index}`],
    }));
    const projection = projectQuoteConversationContext({
      state: emptyQuoteConversationState(),
      currentUserMessages: ["Sony WH-1000XM5"],
      identityCandidates: candidates,
      now: "2026-09-01T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 1,
    });
    expect(projection.identityCandidates).toEqual(candidates.slice(0, 20));
    expect(() => projectQuoteConversationContext({
      state: emptyQuoteConversationState(),
      currentUserMessages: ["Sony WH-1000XM5"],
      identityCandidates: [{ ...candidates[0]!, evidenceRefs: [] }],
      now: "2026-09-01T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 1,
    })).toThrow("IDENTITY_CANDIDATE_ALLOWLIST_INVALID");
  });

  it("projects pending confirmation without exposing the complete internal proposal", () => {
    const state = {
      ...emptyQuoteConversationState(1),
      pendingTargetConfirmation: {
        confirmationId: "qtc_1",
        proposal: {
          rawText: "Sony XM5",
          proposedModel: "WH-1000XM5",
          brand: "Sony",
          productType: null,
          requiredQualifiers: [],
          conditionPreference: "ANY" as const,
        },
        reasonCodes: ["MODEL_NOT_LEXICALLY_GROUNDED"],
        askedByMessageId: "m1",
      },
    };
    const projection = projectQuoteConversationContext({
      state,
      currentUserMessages: ["yes"],
      now: "2026-09-01T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 0,
    });

    expect(projection.quoteState.pendingTargetConfirmation).toEqual({
      confirmationId: "qtc_1",
      proposedModel: "WH-1000XM5",
      reasonCodes: ["MODEL_NOT_LEXICALLY_GROUNDED"],
    });
    expect(projection.quoteState.pendingTargetConfirmation).not.toHaveProperty("rawText");
    expect(projection.recentAdjacentPair).toEqual([]);
    expect(projection.quoteState.leadSet).toBeNull();
  });

  it("shrinks optional history before rejecting an impossible token budget", () => {
    const state = {
      ...emptyQuoteConversationState(1),
      target: target(),
      leadSet: leadSet(8),
      displayQuoteLeadRefs: Array.from({ length: 8 }, (_, index) => `ql_${index}`),
    };
    const projection = projectQuoteConversationContext({
      state,
      currentUserMessages: ["Sony WH-1000XM5"],
      recentAdjacentPair: [{ role: "ASSISTANT", content: "z".repeat(1_400) }],
      now: "2026-09-01T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 1,
      maxInputTokens: 750,
    });
    expect(projection.quoteState.leadSet?.leads.length).toBeLessThan(8);
    expect(projection.runtime.estimatedInputTokens).toBeLessThanOrEqual(750);

    expect(() => projectQuoteConversationContext({
      state: emptyQuoteConversationState(),
      currentUserMessages: ["Sony WH-1000XM5"],
      now: "2026-09-01T00:00:00.000Z",
      modelId: "faux-model",
      providerCallBudget: 0,
      maxInputTokens: 1,
    })).toThrow("QUOTE_CONTEXT_BUDGET_EXCEEDED");
  });

  it.each([
    { now: "not-a-time", messages: ["Sony WH-1000XM5"], code: "INVALID_QUOTE_CONTEXT_TIME" },
    { now: "2026-09-01T00:00:00.000Z", messages: [], code: "INVALID_QUOTE_MESSAGE_BATCH" },
    { now: "2026-09-01T00:00:00.000Z", messages: Array(9).fill("x"), code: "INVALID_QUOTE_MESSAGE_BATCH" },
  ])("rejects invalid context input with $code", ({ now, messages, code }) => {
    expect(() => projectQuoteConversationContext({
      state: emptyQuoteConversationState(),
      currentUserMessages: messages,
      now,
      modelId: "faux-model",
      providerCallBudget: 0,
    })).toThrow(code);
  });
});
