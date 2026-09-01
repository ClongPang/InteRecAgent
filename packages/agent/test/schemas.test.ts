import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import { quoteAssistantOutcomeSchema, quoteTurnPlanSchema } from "../src/schemas.js";

describe("quote-only model schema", () => {
  it("accepts an exact-model target followed by one lookup", () => {
    expect(Check(quoteTurnPlanSchema, {
      userIntentSummary: "look up the stated model",
      ops: [
        {
          opId: "target",
          kind: "SET_QUOTE_TARGET",
          sourceMessageOrdinal: 0,
          identityHypothesis: {
            sourceMessageOrdinal: 0,
            model: { value: "WH-1000XM5", span: { start: 5, end: 15 } },
            brand: { value: "Sony", span: { start: 0, end: 4 } },
            productType: { value: "headphones", span: { start: 16, end: 26 } },
            qualifiers: [],
            selectedVariantRef: null,
            confidence: null,
          },
          target: {
            proposedModel: "WH-1000XM5",
            brand: "Sony",
            productType: "headphones",
            requiredQualifiers: [],
            conditionPreference: "ANY",
          },
        },
        { opId: "lookup", kind: "LOOKUP_QUOTES" },
      ],
    })).toBe(true);
  });

  it("requires a closed, source-spanned identity hypothesis for every target proposal", () => {
    const base = {
      userIntentSummary: "look up the stated model",
      ops: [{
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        sourceMessageOrdinal: 0,
        target: {
          proposedModel: "WH-1000XM5",
          brand: "Sony",
          productType: null,
          requiredQualifiers: [],
          conditionPreference: "ANY",
        },
      }],
    };
    expect(Check(quoteTurnPlanSchema, base)).toBe(false);
    expect(Check(quoteTurnPlanSchema, {
      ...base,
      ops: [{
        ...base.ops[0],
        identityHypothesis: {
          sourceMessageOrdinal: 0,
          model: { value: "WH-1000XM5", span: { start: 5, end: 15 } },
          brand: { value: "Sony", span: { start: 0, end: 4 } },
          productType: null,
          qualifiers: [],
          selectedVariantRef: null,
          confidence: null,
          authority: "MODEL",
        },
      }],
    })).toBe(false);
  });

  it("accepts explicit refresh and stable quote referents", () => {
    expect(Check(quoteTurnPlanSchema, {
      userIntentSummary: "exclude the first lead and refresh",
      ops: [
        { opId: "exclude", kind: "EXCLUDE_QUOTE_LEADS", referents: [{ kind: "DISPLAY_RANK", rank: 1 }] },
        { opId: "refresh", kind: "REFRESH_QUOTES" },
      ],
    })).toBe(true);
  });

  it("rejects retired shopping operations and undeclared fields", () => {
    expect(Check(quoteTurnPlanSchema, {
      userIntentSummary: "retired operation",
      ops: [{ opId: "legacy", kind: "SEARCH_OFFERS" }],
    })).toBe(false);
    expect(Check(quoteTurnPlanSchema, {
      userIntentSummary: "invent a search mode",
      ops: [{ opId: "lookup", kind: "LOOKUP_QUOTES", mode: "semantic" }],
    })).toBe(false);
  });

  it("exposes only host-owned quote outcomes", () => {
    for (const outcome of ["CHAT", "CLARIFICATION", "QUOTE_LEADS", "NO_QUOTE_LEADS", "DEGRADED"]) {
      expect(Check(quoteAssistantOutcomeSchema, outcome)).toBe(true);
    }
    expect(Check(quoteAssistantOutcomeSchema, "SEARCH_RESULTS")).toBe(false);
    expect(Check(quoteAssistantOutcomeSchema, "RECOMMENDATION")).toBe(false);
  });
});
