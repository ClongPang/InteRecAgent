import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";

import { assistantEnvelopeSchema, turnPlanSchema } from "../src/schemas.js";

describe("model-facing turn plan schema", () => {
  it("accepts a bounded empty budget placeholder for turn executor removal", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "washing machine with no budget",
      ops: [
        {
          opId: "target",
          sourceMessageOrdinal: 0,
          kind: "GOAL_SET_TARGET",
          target: {
            categoryId: "washing_machine",
            canonicalModel: null,
            itemRole: "PRIMARY_PRODUCT",
            condition: "NEW",
          },
        },
        {
          opId: "empty-budget",
          sourceMessageOrdinal: 0,
          kind: "GOAL_SET_BUDGET",
          budget: { amount: "", currency: "" },
        },
      ],
      leftover: [],
    })).toBe(true);
  });

  it("accepts harmless transition receipt IDs and a missing empty leftover", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "ask for the missing product",
      ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "TARGET_PRODUCT" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "MISSING_TARGET" }],
    })).toBe(true);
    expect(Check(assistantEnvelopeSchema, {
      outcome: "RECOMMENDATION",
      blocks: [{ type: "TRANSITION", transitionCode: "SEARCH_COMPLETED", claimIds: ["claim:one"] }],
      nextMoves: [],
    })).toBe(true);
  });

  it("lets the model select only a registered intent and rejects server-owned question metadata", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "ask for purchase market",
      ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "PURCHASE_MARKET" }, uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true }, reasonCode: "MISSING_MARKET" }],
      leftover: [],
    })).toBe(true);
    expect(Check(turnPlanSchema, {
      userIntentSummary: "invent a plausible clarification kind",
      ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "LIFESTYLE_FIT_INDEX" }, reasonCode: "MODEL_SELECTED" }],
      leftover: [],
    })).toBe(false);
    expect(Check(assistantEnvelopeSchema, {
      outcome: "CLARIFICATION",
      blocks: [{
        type: "QUESTION",
        clarification: { kind: "PURCHASE_MARKET" },
        clarificationId: "model-authored-id",
        responseSpec: { inputMode: "SINGLE_SELECT", allowFreeText: true, allowSkip: true, examples: [], options: [{ id: "EU", label: "欧洲" }] },
      }],
      nextMoves: [],
    })).toBe(false);
  });

  it("requires user-resolvable uncertainty on every model clarification", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "ask market",
      ops: [{ opId: "ask", kind: "REQUEST_CLARIFICATION", clarification: { kind: "PURCHASE_MARKET" }, reasonCode: "MISSING_MARKET" }],
    })).toBe(false);
    expect(Check(turnPlanSchema, {
      userIntentSummary: "ask market",
      ops: [{
        opId: "ask",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "PURCHASE_MARKET" },
        uncertainty: { type: "MISSING_EVIDENCE", userResolvable: true },
        reasonCode: "MISSING_MARKET",
      }],
    })).toBe(false);
  });

  it("lets the planner explicitly resolve the pending clarification it was shown", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "apply the user's market answer",
      ops: [
        {
          opId: "resolve-market",
          kind: "RESOLVE_CLARIFICATION",
          clarificationId: "clarification-market",
          clarification: { kind: "PURCHASE_MARKET" },
          outcome: "ANSWERED",
        },
        {
          opId: "set-market",
          kind: "GOAL_SET_RETRIEVAL_MARKETS",
          sourceMessageOrdinal: 0,
          markets: ["US"],
        },
      ],
    })).toBe(true);
  });

  it("bounds agent-proposed exploratory search assumptions", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "continue after skipping market",
      ops: [{
        opId: "search",
        kind: "SEARCH_OFFERS",
        reasonCode: "INSUFFICIENT_COVERAGE",
        marketScope: ["US", "SG"],
        assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
      }],
    })).toBe(true);
    expect(Check(turnPlanSchema, {
      userIntentSummary: "invent a market scope",
      ops: [{
        opId: "search",
        kind: "SEARCH_OFFERS",
        reasonCode: "INSUFFICIENT_COVERAGE",
        marketScope: ["EU"],
        assumptionDisclosureCodes: ["UNREGISTERED_ASSUMPTION"],
      }],
    })).toBe(false);
  });
});
