import type { QuoteAdmissionDecision } from "@interec/domain";
import { describe, expect, it } from "vitest";

import { compareIdentityResolutionShadow } from "../src/identity-resolution-observability.js";

function active(status: QuoteAdmissionDecision["status"], strength: QuoteAdmissionDecision["identityStrength"]): QuoteAdmissionDecision {
  return {
    observationRef: "qo_shadow",
    status,
    reasonCodes: [],
    policyVersion: "quote-admission-v2",
    identityStrength: strength,
    identityEvidenceRefs: ["alias_fixture"],
  };
}

describe("identity shadow comparison without a dual production resolver", () => {
  it("records agreement against a frozen replay label", () => {
    expect(compareIdentityResolutionShadow(active("ELIGIBLE", "CURATED_TITLE_ALIAS_MATCH"), "ELIGIBLE")).toEqual({
      observationRef: "qo_shadow",
      activeStatus: "ELIGIBLE",
      activeStrength: "CURATED_TITLE_ALIAS_MATCH",
      frozenLegacyStatus: "ELIGIBLE",
      agreement: true,
      disagreementCode: null,
    });
  });

  it.each([
    ["ELIGIBLE", "REJECTED", "ACTIVE_MORE_PERMISSIVE"],
    ["REJECTED", "ELIGIBLE", "ACTIVE_MORE_CONSERVATIVE"],
    ["INSUFFICIENT_EVIDENCE", "ELIGIBLE", "ACTIVE_MORE_CONSERVATIVE"],
    ["INSUFFICIENT_EVIDENCE", "REJECTED", "STATUS_CLASS_CHANGED"],
  ] as const)("classifies %s versus %s as %s", (activeStatus, frozenStatus, code) => {
    expect(compareIdentityResolutionShadow(active(activeStatus, activeStatus === "ELIGIBLE" ? "EXACT_LEXICAL_MATCH" : "PROBABILISTIC_CANDIDATE"), frozenStatus))
      .toMatchObject({ agreement: false, disagreementCode: code });
  });
});
