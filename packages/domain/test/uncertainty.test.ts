import { describe, expect, it } from "vitest";

import { evaluateAnswerability, type AnswerabilityReceipt, type TurnPlan } from "../src/index.js";

function receipt(overrides: Partial<AnswerabilityReceipt> = {}): AnswerabilityReceipt {
  return {
    opId: "inspect",
    status: "APPLIED",
    claimIds: [],
    questionClarifications: [],
    disclosureCodes: [],
    publicResult: {},
    ...overrides,
  };
}

describe("uncertainty ownership and Answerability", () => {
  it("answers only from claims produced by completed receipts", () => {
    const plan: TurnPlan = {
      userIntentSummary: "inspect price",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "FOCUS" }], fields: ["PRICE"] }],
      leftover: [],
    };
    expect(evaluateAnswerability({ plan, receipts: [receipt({ claimIds: ["price-1"] })] }))
      .toEqual({ mode: "ANSWER", claimIds: ["price-1"] });
  });

  it("discloses missing evidence without asking the user to rephrase", () => {
    const plan: TurnPlan = {
      userIntentSummary: "inspect warranty",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "FOCUS" }], fields: ["WARRANTY"] }],
      leftover: [],
    };
    expect(evaluateAnswerability({
      plan,
      receipts: [receipt({ disclosureCodes: ["WARRANTY_UNKNOWN"], publicResult: { unknownFields: ["WARRANTY"] } })],
    })).toEqual({
      mode: "DISCLOSE_UNKNOWN",
      uncertaintyType: "MISSING_EVIDENCE",
      factKinds: ["WARRANTY"],
      claimIds: [],
      disclosureCodes: ["WARRANTY_UNKNOWN"],
    });
  });

  it("classifies unavailable Provider coverage as missing evidence even without fact fields", () => {
    const plan: TurnPlan = {
      userIntentSummary: "search current markets",
      ops: [{ opId: "search", kind: "SEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE" }],
      leftover: [],
    };
    expect(evaluateAnswerability({
      plan,
      receipts: [receipt({ opId: "search", disclosureCodes: ["PROVIDER_UNAVAILABLE"] })],
    })).toEqual({
      mode: "DISCLOSE_UNKNOWN",
      uncertaintyType: "MISSING_EVIDENCE",
      factKinds: [],
      claimIds: [],
      disclosureCodes: ["PROVIDER_UNAVAILABLE"],
    });
  });

  it("keeps the same clear question out of clarification when the system fails", () => {
    const plan: TurnPlan = {
      userIntentSummary: "inspect warranty",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "FOCUS" }], fields: ["WARRANTY"] }],
      leftover: [],
    };
    expect(evaluateAnswerability({ plan, receipts: [], systemFailureCode: "MODEL_PROTOCOL_FAILED" })).toEqual({
      mode: "DEGRADE",
      uncertaintyType: "SYSTEM_FAILURE",
      failureOwner: "SYSTEM",
      errorCode: "MODEL_PROTOCOL_FAILED",
    });
  });

  it("allows an audited user-resolvable clarification", () => {
    const plan: TurnPlan = {
      userIntentSummary: "ask purchase market",
      ops: [{
        opId: "ask-market",
        kind: "REQUEST_CLARIFICATION",
        clarification: { kind: "PURCHASE_MARKET" },
        uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
        reasonCode: "PURCHASE_MARKET_REQUIRED_FOR_SEARCH",
      }],
      leftover: [],
    };
    expect(evaluateAnswerability({
      plan,
      receipts: [receipt({
        opId: "ask-market",
        questionClarifications: [{ kind: "PURCHASE_MARKET" }],
        uncertaintyType: "MISSING_USER_INFORMATION",
      })],
    })).toEqual({
      mode: "CLARIFY",
      uncertaintyType: "MISSING_USER_INFORMATION",
      operationId: "ask-market",
      clarification: { kind: "PURCHASE_MARKET" },
    });
  });

  it("treats a non-user-resolvable blocked operation as a system failure", () => {
    const plan: TurnPlan = {
      userIntentSummary: "inspect without a working set",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "FOCUS" }], fields: ["PRICE"] }],
      leftover: [],
    };
    expect(evaluateAnswerability({
      plan,
      receipts: [receipt({ status: "BLOCKED", publicResult: { blockedReasonCode: "WORKING_SET_REQUIRED" } })],
    })).toMatchObject({ mode: "DEGRADE", uncertaintyType: "SYSTEM_FAILURE", errorCode: "WORKING_SET_REQUIRED" });
  });

  it("allows a deterministically classified ambiguous candidate receipt to ask for the referent", () => {
    const plan: TurnPlan = {
      userIntentSummary: "focus an ambiguous candidate",
      ops: [{ opId: "focus", kind: "SET_FOCUS", referent: { kind: "TEXT", text: "the Sony one" } }],
      leftover: [],
    };
    expect(evaluateAnswerability({
      plan,
      receipts: [receipt({
        opId: "focus",
        status: "BLOCKED",
        uncertaintyType: "INTENT_AMBIGUITY",
        questionClarifications: [{ kind: "CANDIDATE_REFERENT", contextRef: "focus" }],
        publicResult: { blockedReasonCode: "CANDIDATE_REFERENT_AMBIGUOUS" },
      })],
    })).toEqual({
      mode: "CLARIFY",
      uncertaintyType: "INTENT_AMBIGUITY",
      operationId: "focus",
      clarification: { kind: "CANDIDATE_REFERENT", contextRef: "focus" },
    });
  });
});
