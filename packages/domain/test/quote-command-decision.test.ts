import { describe, expect, it } from "vitest";

import {
  applyQuoteEffectResult,
  decideQuoteCommand,
  emptyQuoteConversationState,
  resolveQuoteTarget,
  type PublishedQuoteLeadSet,
  type QuoteConversationState,
  type QuoteTarget,
  type QuoteTurnOperation,
} from "../src/index.js";

const NOW = "2026-09-01T00:00:00.000Z";

function target(): QuoteTarget {
  const result = resolveQuoteTarget({ rawText: "Sony WH-1000XM5", proposedModel: "WH-1000XM5", brand: "Sony" });
  if (result.status !== "RESOLVED") throw new Error("target fixture failed");
  return result.target;
}

function leadSet(quoteTarget: QuoteTarget, refs = ["ql_1", "ql_2"]): PublishedQuoteLeadSet {
  return {
    contractVersion: "quote-leads-sg-v1",
    quoteLeadSetRef: `qls_${refs.join("_")}`,
    targetRef: quoteTarget.targetRef,
    outcome: "QUOTE_LEADS",
    reasonCodes: [],
    providerStatus: "OK_RESULTS",
    providerFailureCode: null,
    providerRetryable: null,
    providerContractVersion: "controlled-decision-v1",
    leads: refs.map((ref, index) => ({
      quoteLeadRef: ref,
      canonicalModel: quoteTarget.canonicalModel,
      representativeTitle: `Sony WH-1000XM5 quote ${index + 1}`,
      condition: "NEW",
      merchantLabel: `Merchant ${index + 1}`,
      merchantDomain: `merchant${index + 1}.example`,
      outboundUrl: `https://merchant${index + 1}.example/product`,
      priceRanges: [{ originalPrice: { currency: "SGD", minAmount: `${399 + index}.00`, maxAmount: `${399 + index}.00` }, cnyEstimate: null }],
      observationCount: 1,
      firstObservedAt: NOW,
      latestObservedAt: NOW,
    })),
    observedAt: NOW,
  };
}

function stateWithLeads(): QuoteConversationState {
  const quoteTarget = target();
  const set = leadSet(quoteTarget);
  return {
    ...emptyQuoteConversationState(3),
    target: quoteTarget,
    leadSet: set,
    displayQuoteLeadRefs: ["ql_2"],
    excludedQuoteLeadRefs: ["ql_1"],
    comparisonQuoteLeadRefs: ["ql_2"],
    focusQuoteLeadRef: "ql_2",
  };
}

describe("pure quote command decisions", () => {
  it("returns the same decision for the same input and never mutates the caller state", () => {
    const state = emptyQuoteConversationState();
    const before = structuredClone(state);
    const operation: QuoteTurnOperation = {
      opId: "target",
      kind: "SET_QUOTE_TARGET",
      source: { messageId: "m1" },
      target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: null, requiredQualifiers: [], conditionPreference: "ANY" },
    };
    const input = { state, operation, currentUserMessages: [{ messageId: "m1", content: "Sony WH-1000XM5" }] };
    expect(decideQuoteCommand(input)).toEqual(decideQuoteCommand(input));
    expect(state).toEqual(before);
  });

  it("emits one explicit lookup effect and applies a controlled result only in the domain", () => {
    const setTarget = decideQuoteCommand({
      state: emptyQuoteConversationState(),
      operation: {
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        source: { messageId: "m1" },
        target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: null, requiredQualifiers: [], conditionPreference: "ANY" },
      },
      currentUserMessages: [{ messageId: "m1", content: "Sony WH-1000XM5" }],
    });
    expect(setTarget.decision).toBe("APPLIED");
    const lookup = decideQuoteCommand({
      state: setTarget.nextState,
      operation: { opId: "lookup", kind: "LOOKUP_QUOTES" },
      currentUserMessages: [{ messageId: "m1", content: "Sony WH-1000XM5" }],
    });
    expect(lookup).toMatchObject({
      decision: "EFFECT_REQUIRED",
      receipt: null,
      effects: [{ kind: "QUOTE_LOOKUP", operationId: "lookup", operationKind: "LOOKUP_QUOTES" }],
    });
    expect(lookup.effects).toHaveLength(1);
    const application = applyQuoteEffectResult(lookup.nextState, lookup.effects[0]!, {
      status: "SUCCEEDED",
      leadSet: leadSet(lookup.effects[0]!.target),
    });
    expect(application).toMatchObject({
      status: "APPLIED",
      nextState: { displayQuoteLeadRefs: ["ql_1", "ql_2"] },
      receipt: { providerCalled: true, publicResult: { outcome: "QUOTE_LEADS", quoteLeadCount: 2 } },
    });
  });

  it("preserves the entire pre-effect state on failure", () => {
    const state = stateWithLeads();
    const decision = decideQuoteCommand({
      state,
      operation: { opId: "refresh", kind: "REFRESH_QUOTES" },
      currentUserMessages: [{ messageId: "m2", content: "刷新报价" }],
    });
    if (decision.decision !== "EFFECT_REQUIRED") throw new Error("expected effect");
    const application = applyQuoteEffectResult(decision.nextState, decision.effects[0], {
      status: "FAILED",
      errorCode: "BUYWHERE_TIMEOUT",
      retryable: true,
    });
    expect(application).toEqual({ status: "FAILED", nextState: state, errorCode: "BUYWHERE_TIMEOUT", retryable: true });
  });

  it("preserves durable exclusion, valid focus, and surviving comparison on refresh", () => {
    const state = stateWithLeads();
    const decision = decideQuoteCommand({ state, operation: { opId: "refresh", kind: "REFRESH_QUOTES" }, currentUserMessages: [] });
    if (decision.decision !== "EFFECT_REQUIRED") throw new Error("expected effect");
    const application = applyQuoteEffectResult(state, decision.effects[0], { status: "SUCCEEDED", leadSet: leadSet(target()) });
    expect(application).toMatchObject({
      status: "APPLIED",
      nextState: {
        excludedQuoteLeadRefs: ["ql_1"],
        displayQuoteLeadRefs: ["ql_2"],
        comparisonQuoteLeadRefs: ["ql_2"],
        focusQuoteLeadRef: "ql_2",
      },
    });
  });

  it("moves exclusion state in the domain while keeping the input immutable", () => {
    const state = { ...stateWithLeads(), displayQuoteLeadRefs: ["ql_1", "ql_2"], excludedQuoteLeadRefs: [], comparisonQuoteLeadRefs: ["ql_1", "ql_2"] };
    const before = structuredClone(state);
    const decision = decideQuoteCommand({
      state,
      operation: { opId: "exclude", kind: "EXCLUDE_QUOTE_LEADS", referents: [{ kind: "DISPLAY_RANK", rank: 1 }] },
      currentUserMessages: [],
    });
    expect(decision).toMatchObject({
      decision: "APPLIED",
      nextState: { excludedQuoteLeadRefs: ["ql_1"], displayQuoteLeadRefs: ["ql_2"], comparisonQuoteLeadRefs: ["ql_2"] },
    });
    expect(state).toEqual(before);
  });

  it("cannot emit a Provider effect while identity confirmation is pending", () => {
    const pending = decideQuoteCommand({
      state: emptyQuoteConversationState(),
      operation: {
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        source: { messageId: "m1" },
        target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: null, requiredQualifiers: [], conditionPreference: "ANY" },
      },
      currentUserMessages: [{ messageId: "m1", content: "Sony XM5" }],
    });
    expect(pending).toMatchObject({ decision: "APPLIED", nextState: { target: null, pendingTargetConfirmation: { proposal: { proposedModel: "WH-1000XM5" } } } });
    expect(() => decideQuoteCommand({ state: pending.nextState, operation: { opId: "lookup", kind: "LOOKUP_QUOTES" }, currentUserMessages: [] }))
      .toThrowError(expect.objectContaining({ code: "QUOTE_TARGET_REQUIRED" }));
  });
});
