import { describe, expect, it } from "vitest";

import {
  createLexicallyGroundedIdentityHypothesis,
  reviewIdentityHypothesis,
  validateIdentityCandidates,
  type IdentityCandidateView,
  type IdentityHypothesis,
} from "../src/identity-hypothesis.js";

const RAW = "Quote Sony WH-1000XM5 black";
const TARGET = {
  proposedModel: "WH-1000XM5",
  brand: "Sony",
  productType: null,
  requiredQualifiers: ["black"],
  conditionPreference: "ANY" as const,
};
const CANDIDATE: IdentityCandidateView = {
  registryVersion: 1,
  brandRef: "brand_sony",
  productRef: "product_sony_wh1000x",
  variantRef: "variant_sony_wh1000xm5",
  canonicalModel: "WH-1000XM5",
  evidenceRefs: ["alias_sony_wh1000xm5"],
};

function operation(hypothesis: IdentityHypothesis, proposedModel = TARGET.proposedModel) {
  return {
    opId: "target",
    kind: "SET_QUOTE_TARGET" as const,
    sourceMessageOrdinal: 0,
    identityHypothesis: hypothesis,
    target: { ...TARGET, proposedModel },
  };
}

describe("LLM identity hypothesis host review", () => {
  it("accepts only exact source spans and an allowlisted candidate", () => {
    const hypothesis = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET, CANDIDATE.variantRef);
    expect(reviewIdentityHypothesis(operation(hypothesis), [RAW], [CANDIDATE], true)).toEqual([]);
  });

  it("rejects an invented candidate before any provider operation", () => {
    const hypothesis = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET, "variant_invented");
    expect(reviewIdentityHypothesis(operation(hypothesis), [RAW], [CANDIDATE], true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IDENTITY_CANDIDATE_NOT_ALLOWED" })]),
    );
  });

  it("rejects rewritten text and out-of-bounds or overlapping citations", () => {
    const rewritten = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET);
    rewritten.model.value = "WH-1000XM4";
    const rewrittenCodes = reviewIdentityHypothesis(operation(rewritten), [RAW], [], false).map((item) => item.code);
    expect(rewrittenCodes).toContain("IDENTITY_SOURCE_TEXT_MISMATCH");

    const overlapping = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET);
    overlapping.brand!.span = { ...overlapping.model.span };
    const overlapCodes = reviewIdentityHypothesis(operation(overlapping), [RAW], [], false).map((item) => item.code);
    expect(overlapCodes).toContain("IDENTITY_SOURCE_SPANS_OVERLAP");

    const outOfBounds = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET);
    outOfBounds.model.span.end = RAW.length + 1;
    expect(reviewIdentityHypothesis(operation(outOfBounds), [RAW], [], false)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IDENTITY_SOURCE_SPAN_INVALID" })]),
    );
  });

  it("allows a non-literal expansion only as a clarification proposal", () => {
    const hypothesis = createLexicallyGroundedIdentityHypothesis("Sony XM5", 0, {
      ...TARGET,
      proposedModel: "XM5",
      requiredQualifiers: [],
    });
    const expanded = operation(hypothesis, "WH-1000XM5");
    expanded.target.requiredQualifiers = [];
    expect(reviewIdentityHypothesis(expanded, ["Sony XM5"], [], false)).toEqual([]);
  });

  it("never lets model confidence authorize a changed alphanumeric identity lookup", () => {
    const hypothesis = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET);
    hypothesis.confidence = 1;
    const codes = reviewIdentityHypothesis(operation(hypothesis, "WH-1000XM4"), [RAW], [], true).map((item) => item.code);
    expect(codes).toContain("IDENTITY_LOOKUP_REQUIRES_MODEL_LITERAL");
  });

  it("rejects a candidate whose canonical model conflicts with the proposal", () => {
    const hypothesis = createLexicallyGroundedIdentityHypothesis(RAW, 0, TARGET, CANDIDATE.variantRef);
    expect(reviewIdentityHypothesis(operation(hypothesis, "WH-1000XM4"), [RAW], [CANDIDATE], false)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IDENTITY_CANDIDATE_MODEL_CONFLICT" })]),
    );
  });

  it("validates host candidate allowlists independently of model output", () => {
    expect(validateIdentityCandidates([CANDIDATE])).toEqual([CANDIDATE]);
    expect(() => validateIdentityCandidates([{ ...CANDIDATE, evidenceRefs: [] }])).toThrow("IDENTITY_CANDIDATE_ALLOWLIST_INVALID");
    expect(() => validateIdentityCandidates([CANDIDATE, CANDIDATE])).toThrow("IDENTITY_CANDIDATE_ALLOWLIST_INVALID");
  });
});
