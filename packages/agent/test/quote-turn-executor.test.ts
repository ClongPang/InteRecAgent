import {
  emptyQuoteConversationState,
  resolveQuoteTarget,
  type PublishedQuoteLeadSet,
} from "@interec/domain";
import { describe, expect, it, vi } from "vitest";

import { QuoteConversationTurnExecutor } from "../src/quote-turn-executor.js";

function target() {
  const result = resolveQuoteTarget({ rawText: "Sony WH-1000XM5 headphones", proposedModel: "WH-1000XM5", brand: "Sony", productType: "headphones" });
  if (result.status !== "RESOLVED") throw new Error("target fixture failed");
  return result.target;
}

function resultSet(outcome: PublishedQuoteLeadSet["outcome"] = "QUOTE_LEADS"): PublishedQuoteLeadSet {
  const hasLead = outcome === "QUOTE_LEADS";
  return {
    contractVersion: "quote-leads-sg-v1",
    quoteLeadSetRef: `qls_${outcome}`,
    targetRef: target().targetRef,
    outcome,
    reasonCodes: outcome === "NO_QUOTE_LEADS" ? ["PROVIDER_RETURNED_EMPTY"] : outcome === "DEGRADED" ? ["PROVIDER_DEGRADED"] : [],
    providerStatus: outcome === "DEGRADED" ? "DEGRADED" : outcome === "NO_QUOTE_LEADS" ? "OK_EMPTY" : "OK_RESULTS",
    providerFailureCode: outcome === "DEGRADED" ? "BUYWHERE_TIMEOUT" : null,
    providerRetryable: outcome === "DEGRADED" ? true : null,
    providerContractVersion: "buywhere-test",
    leads: hasLead ? [{
      quoteLeadRef: "ql_1",
      canonicalModel: "WH-1000XM5",
      representativeTitle: "Sony WH-1000XM5 Headphones",
      condition: "NEW",
      merchantLabel: "Example",
      merchantDomain: "merchant.example",
      outboundUrl: "https://buywhere.example/out/1",
      priceRanges: [{ originalPrice: { currency: "USD", minAmount: "249.99", maxAmount: "249.99" }, cnyEstimate: null }],
      observationCount: 1,
      firstObservedAt: "2026-09-01T00:00:00.000Z",
      latestObservedAt: "2026-09-01T00:00:00.000Z",
    }] : [],
    observedAt: "2026-09-01T00:00:00.000Z",
  };
}

function executor(baseState = emptyQuoteConversationState(), lookup = vi.fn(async () => resultSet())) {
  return {
    lookup,
    executor: new QuoteConversationTurnExecutor({
      turnId: "turn-1",
      inputMessageIds: ["m1"],
      inputMessageContents: ["Sony WH-1000XM5 headphones"],
      baseState,
      publicationRevision: baseState.version + 1,
      quoteData: { lookup },
    }),
  };
}

describe("QuoteConversationTurnExecutor", () => {
  it("looks up a grounded exact model once and publishes merchant-page quote leads", async () => {
    const setup = executor();
    const result = await setup.executor.execute({
      userIntentSummary: "look up exact model",
      ops: [
        { opId: "target", kind: "SET_QUOTE_TARGET", sourceMessageOrdinal: 0, target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: "headphones", requiredQualifiers: [], conditionPreference: "ANY" } },
        { opId: "lookup", kind: "LOOKUP_QUOTES" },
      ],
    });
    expect(setup.lookup).toHaveBeenCalledOnce();
    expect(result.reply.outcome).toBe("QUOTE_LEADS");
    expect(result.reply.text).toContain("商家页");
    expect(result.state.displayQuoteLeadRefs).toEqual(["ql_1"]);
    expect(JSON.stringify(result.state)).not.toContain("availability");
  });

  it("does not call the provider for a focus follow-up", async () => {
    const base = {
      ...emptyQuoteConversationState(1),
      target: target(),
      leadSet: resultSet(),
      displayQuoteLeadRefs: ["ql_1"],
    };
    const setup = executor(base);
    const result = await setup.executor.execute({
      userIntentSummary: "focus first quote",
      ops: [{ opId: "focus", kind: "SET_QUOTE_FOCUS", referent: { kind: "DISPLAY_RANK", rank: 1 } }],
    });
    expect(setup.lookup).not.toHaveBeenCalled();
    expect(result.state.focusQuoteLeadRef).toBe("ql_1");
    expect(result.reply.text).toContain("没有重新调用报价服务");
  });

  it("stores an inferred model as pending confirmation and spends zero provider calls", async () => {
    const setup = {
      lookup: vi.fn(async () => resultSet()),
      executor: new QuoteConversationTurnExecutor({
        turnId: "turn-1",
        inputMessageIds: ["m1"],
        inputMessageContents: ["Sony XM5 headphones"],
        baseState: emptyQuoteConversationState(),
        publicationRevision: 1,
        quoteData: { lookup: vi.fn(async () => resultSet()) },
      }),
    };
    const result = await setup.executor.execute({
      userIntentSummary: "confirm expanded model",
      ops: [{ opId: "target", kind: "SET_QUOTE_TARGET", sourceMessageOrdinal: 0, target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: "headphones", requiredQualifiers: [], conditionPreference: "ANY" } }],
    });
    expect(result.state.pendingTargetConfirmation?.proposal.proposedModel).toBe("WH-1000XM5");
    expect(result.reply.outcome).toBe("CLARIFICATION");
  });

  it.each(["NO_QUOTE_LEADS", "DEGRADED"] as const)("keeps %s distinct from successful results", async (outcome) => {
    const lookup = vi.fn(async () => resultSet(outcome));
    const setup = executor(emptyQuoteConversationState(), lookup);
    const result = await setup.executor.execute({
      userIntentSummary: "look up exact model",
      ops: [
        { opId: "target", kind: "SET_QUOTE_TARGET", sourceMessageOrdinal: 0, target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: "headphones", requiredQualifiers: [], conditionPreference: "ANY" } },
        { opId: "lookup", kind: "LOOKUP_QUOTES" },
      ],
    });
    expect(result.reply.outcome).toBe(outcome);
    expect(result.reply.text).toContain("不表示新加坡市场没有");
  });

  it("binds an exclusion before refresh and preserves the stable merchant-page lead exclusion", async () => {
    const base = {
      ...emptyQuoteConversationState(1),
      target: target(),
      leadSet: resultSet(),
      displayQuoteLeadRefs: ["ql_1"],
    };
    const lookup = vi.fn(async () => resultSet());
    const instance = new QuoteConversationTurnExecutor({
      turnId: "turn-2",
      inputMessageIds: ["m2"],
      inputMessageContents: ["排除第一条，然后刷新报价"],
      baseState: base,
      publicationRevision: 2,
      quoteData: { lookup },
    });
    const result = await instance.execute({
      userIntentSummary: "exclude first and explicitly refresh",
      ops: [
        { opId: "exclude", kind: "EXCLUDE_QUOTE_LEADS", referents: [{ kind: "DISPLAY_RANK", rank: 1 }] },
        { opId: "refresh", kind: "REFRESH_QUOTES" },
      ],
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(result.state.excludedQuoteLeadRefs).toEqual(["ql_1"]);
    expect(result.state.displayQuoteLeadRefs).toEqual([]);
  });
});
