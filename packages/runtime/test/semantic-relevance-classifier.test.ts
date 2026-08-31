import { describe, expect, it } from "vitest";

import { parseSemanticRelevanceResponse } from "../src/semantic-relevance-classifier.js";

describe("semantic relevance response boundary", () => {
  it("accepts only bounded, typed assessments", () => {
    const parsed = parseSemanticRelevanceResponse(
      '```json\n{"assessments":[{"listingRef":"listing-1","label":"COMPLEMENT","confidence":0.97}]}\n```',
      new Set(["listing-1"]),
      "semantic-test",
    );
    expect(parsed.get("listing-1")).toEqual({ label: "COMPLEMENT", confidence: 0.97, modelId: "semantic-test" });
  });

  it.each([
    ['{"assessments":[{"listingRef":"unknown","label":"EXACT","confidence":0.9}]}'],
    ['{"assessments":[{"listingRef":"listing-1","label":"UNRESOLVED","confidence":0.9}]}'],
    ['{"assessments":[{"listingRef":"listing-1","label":"EXACT","confidence":1.1}]}'],
  ])("rejects an untrusted model payload", (payload) => {
    expect(() => parseSemanticRelevanceResponse(payload, new Set(["listing-1"]), "semantic-test")).toThrow();
  });

  it("rejects a partial assessment set instead of silently leaving candidates unresolved", () => {
    expect(() => parseSemanticRelevanceResponse(
      '{"assessments":[{"listingRef":"listing-1","label":"EXACT","confidence":0.9}]}',
      new Set(["listing-1", "listing-2"]),
      "semantic-test",
    )).toThrow("SEMANTIC_RELEVANCE_ASSESSMENTS_INCOMPLETE");
  });
});
