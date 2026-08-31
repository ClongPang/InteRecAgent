import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assessQueryProductRelevance,
  decideCandidateAdmission,
  ingestBuyWhereListing,
  type QueryProductRelevanceLabel,
  type SearchTargetSnapshot,
} from "../src/index.js";

interface EvaluationCase {
  id: string;
  target: SearchTargetSnapshot;
  title: string;
  categoryPath: string[];
  productType: string | null;
  expected: QueryProductRelevanceLabel;
}

const dataset = JSON.parse(readFileSync(new URL("../../../spec/evaluation/esci-admission-v2/cases.json", import.meta.url), "utf8")) as {
  policyVersion: string;
  cases: EvaluationCase[];
};

describe("cross-category ESCI admission evaluation", () => {
  it("matches every labeled case and never authorizes a non-EXACT main candidate", () => {
    expect(dataset.policyVersion).toBe("esci-admission-v2");
    expect(new Set(dataset.cases.map((item) => item.target.categoryId)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(dataset.cases.map((item) => item.expected))).toEqual(new Set(["EXACT", "SUBSTITUTE", "COMPLEMENT", "IRRELEVANT", "UNRESOLVED"]));
    for (const item of dataset.cases) {
      const listing = ingestBuyWhereListing({
        id: item.id,
        title: item.title,
        price: { amount: "100", currency: "USD" },
        merchant: `Merchant ${item.id}`,
        url: `https://${item.id}.us/item`,
        country_code: "US",
        category_path: item.categoryPath,
        metadata: item.productType ? { product_type: item.productType } : {},
      }, {
        retrievalMarket: "US",
        target: item.target,
        observedAt: "2026-08-30T00:00:00.000Z",
        rawArtifactRef: `artifact:${item.id}`,
      });
      expect(listing, item.id).not.toBeNull();
      const assessment = assessQueryProductRelevance({
        listing: listing!,
        goal: { query: item.target.targetText ?? item.target.canonicalModel ?? item.target.categoryId, target: item.target, markets: ["US"], budgetCny: null, stockPreference: "ANY", excludedOfferRefs: [] },
      });
      expect(assessment.label, item.id).toBe(item.expected);
      expect(decideCandidateAdmission(assessment).eligibleForMainRanking, item.id).toBe(item.expected === "EXACT");
    }
  });
});
