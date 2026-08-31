import { describe, expect, it } from "vitest";

import {
  assessQueryProductRelevance,
  buildRankedOfferSet,
  decideCandidateAdmission,
  ingestBuyWhereListing,
  type BuyWhereRawProduct,
  type FxSnapshot,
  type RetrievedListing,
  type SearchGoalSnapshot,
  type SearchTargetSnapshot,
} from "../src/index.js";

const observedAt = "2026-08-30T00:00:00.000Z";
const fx: FxSnapshot = { id: "fx", base: "USD", quote: "CNY", rate: "7", provider: "test", observedAt, expiresAt: "2026-08-31T00:00:00.000Z" };

function listing(id: string, title: string, target: SearchTargetSnapshot, categoryPath: string[], productType: string): RetrievedListing {
  const raw: BuyWhereRawProduct = {
    id,
    title,
    price: { amount: "100", currency: "USD" },
    merchant: `Merchant ${id}`,
    url: `https://${id}.us/item`,
    country_code: "US",
    category_path: categoryPath,
    metadata: { product_type: productType },
    availability: { in_stock: true },
  };
  const result = ingestBuyWhereListing(raw, { retrievalMarket: "US", target, observedAt, rawArtifactRef: `artifact:${id}` });
  if (!result) throw new Error(`fixture did not ingest: ${id}`);
  return result;
}

function goal(target: SearchTargetSnapshot): SearchGoalSnapshot {
  return { query: target.targetText ?? target.canonicalModel ?? target.categoryId, target, markets: ["US"], budgetCny: null, stockPreference: "ANY", excludedOfferRefs: [] };
}

describe("ESCI query-product relevance admission", () => {
  const headphoneTarget: SearchTargetSnapshot = {
    categoryId: "headphones",
    canonicalModel: "WH1000XM5",
    itemRole: "PRIMARY_PRODUCT",
    conditionPreference: "ANY",
  };

  it.each([
    ["EXACT", "Sony WH-1000XM5 Wireless Headphones", ["Electronics", "Headphones"], "Headphones", "MAIN_RECOMMENDATION"],
    ["SUBSTITUTE", "Bose QuietComfort Ultra Headphones", ["Electronics", "Headphones"], "Headphones", "ALTERNATIVE_COHORT"],
    ["COMPLEMENT", "Protective Case compatible with Sony WH-1000XM5", ["Headphone Accessories"], "Headphone Case", "RELATED_COHORT"],
    ["IRRELEVANT", "Apple iPhone 16 Pro 256GB Smartphone", ["Cell Phones", "Smartphones"], "Smartphone", "INELIGIBLE"],
    ["UNRESOLVED", "Wireless Noise Cancelling Headphones", ["Electronics", "Headphones"], "Headphones", "INSUFFICIENT_EVIDENCE"],
  ] as const)("maps %s evidence to its deterministic cohort", (label, title, categoryPath, productType, cohort) => {
    const assessment = assessQueryProductRelevance({ listing: listing(label, title, headphoneTarget, [...categoryPath], productType), goal: goal(headphoneTarget) });
    expect(assessment).toMatchObject({ label, policyVersion: "esci-admission-v2", evidence: expect.any(Array) });
    expect(decideCandidateAdmission(assessment)).toMatchObject({ cohort, eligibleForMainRanking: label === "EXACT" });
  });

  it("supports open categories without turning registration into a prerequisite", () => {
    const laptopTarget: SearchTargetSnapshot = { categoryId: "laptop", targetText: "lightweight laptop", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" };
    const washingMachineTarget: SearchTargetSnapshot = { categoryId: "washing_machine", targetText: "front load washing machine", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" };
    expect(assessQueryProductRelevance({
      listing: listing("laptop", "Lightweight Laptop 14 for Travel", laptopTarget, ["Computers", "Laptops"], "Notebook Computer"),
      goal: goal(laptopTarget),
    }).label).toBe("EXACT");
    expect(assessQueryProductRelevance({
      listing: listing("washer", "Front Load Washing Machine 10kg", washingMachineTarget, ["Appliances", "Washing Machines"], "Front Load Washer"),
      goal: goal(washingMachineTarget),
    }).label).toBe("EXACT");
    expect(assessQueryProductRelevance({
      listing: listing("washer-cover", "Protective Cover for Washing Machine", washingMachineTarget, ["Appliance Accessories"], "Protective Cover"),
      goal: goal(washingMachineTarget),
    }).label).toBe("COMPLEMENT");
  });

  it("treats cross-script lexical absence as missing evidence rather than contrary evidence", () => {
    const target: SearchTargetSnapshot = { categoryId: "washing_machine", targetText: "前置式洗衣机", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" };
    const candidate = listing("cross-script-washer", "Front Load Washing Machine 10kg", target, ["Appliances", "Washing Machines"], "Front Load Washer");
    expect(assessQueryProductRelevance({ listing: candidate, goal: goal(target) })).toMatchObject({
      label: "UNRESOLVED",
      reasonCodes: ["CROSS_SCRIPT_TARGET_REQUIRES_SEMANTIC_CORROBORATION"],
    });
    expect(assessQueryProductRelevance({
      listing: candidate,
      goal: goal(target),
      semanticSignal: { label: "EXACT", confidence: 0.99, modelId: "semantic-test" },
    }).label).toBe("EXACT");
  });

  it("treats item role relative to the requested target instead of globally rejecting accessories", () => {
    const accessoryTarget: SearchTargetSnapshot = {
      categoryId: "smartphone",
      targetText: "phone case",
      canonicalModel: null,
      itemRole: "ACCESSORY",
      conditionPreference: "ANY",
    };
    const requestedCase = listing("requested-case", "Protective Phone Case", accessoryTarget, ["Cell Phone Accessories"], "Phone Case");
    const primaryPhone = listing("primary-phone", "Apple iPhone 16 Pro Smartphone", accessoryTarget, ["Cell Phones"], "Smartphone");

    expect(assessQueryProductRelevance({ listing: requestedCase, goal: goal(accessoryTarget) })).toMatchObject({
      label: "EXACT",
      reasonCodes: ["QUERY_TARGET_ITEM_ROLE_AND_TEXT_MATCH"],
    });
    expect(assessQueryProductRelevance({ listing: primaryPhone, goal: goal(accessoryTarget) })).toMatchObject({
      label: "COMPLEMENT",
      reasonCodes: ["QUERY_TARGET_ITEM_ROLE_MISMATCH"],
    });
  });

  it("lets semantics corroborate a cross-language requested accessory without granting authority by itself", () => {
    const accessoryTarget: SearchTargetSnapshot = {
      categoryId: "smartphone",
      targetText: "手机壳",
      canonicalModel: null,
      itemRole: "ACCESSORY",
      conditionPreference: "ANY",
    };
    const requestedCase = listing("cross-language-case", "Protective Phone Case", accessoryTarget, ["Cell Phone Accessories"], "Phone Case");
    expect(assessQueryProductRelevance({ listing: requestedCase, goal: goal(accessoryTarget) })).toMatchObject({
      label: "UNRESOLVED",
      reasonCodes: ["QUERY_TARGET_ITEM_ROLE_MATCH_REQUIRES_SEMANTIC_CORROBORATION"],
    });
    expect(assessQueryProductRelevance({
      listing: requestedCase,
      goal: goal(accessoryTarget),
      semanticSignal: { label: "EXACT", confidence: 0.96, modelId: "semantic-test" },
    }).label).toBe("EXACT");
  });

  it("fails closed when a semantic signal conflicts with structured evidence", () => {
    const exact = listing("semantic-conflict", "Sony WH-1000XM5 Wireless Headphones", headphoneTarget, ["Electronics", "Headphones"], "Headphones");
    expect(assessQueryProductRelevance({
      listing: exact,
      goal: goal(headphoneTarget),
      semanticSignal: { label: "IRRELEVANT", confidence: 0.99, modelId: "semantic-test" },
    })).toMatchObject({ label: "UNRESOLVED", reasonCodes: ["STRUCTURED_SEMANTIC_EVIDENCE_CONFLICT"] });
  });

  it("requires semantic corroboration when registered-category identity comes only from title text", () => {
    const categoryTarget: SearchTargetSnapshot = {
      categoryId: "headphones",
      targetText: "headphones",
      canonicalModel: null,
      itemRole: "PRIMARY_PRODUCT",
      conditionPreference: "ANY",
    };
    const primary = listing("broad-primary", "Planar Magnetic Headphones", categoryTarget, ["Electronics"], "");
    const related = listing("broad-related", "Desktop DAC Headphone Amplifier", categoryTarget, ["Electronics"], "");

    expect(assessQueryProductRelevance({ listing: primary, goal: goal(categoryTarget) })).toMatchObject({
      label: "UNRESOLVED",
      reasonCodes: ["TITLE_DERIVED_IDENTITY_REQUIRES_SEMANTIC_CORROBORATION"],
    });
    expect(assessQueryProductRelevance({
      listing: primary,
      goal: goal(categoryTarget),
      semanticSignal: { label: "EXACT", confidence: 0.96, modelId: "semantic-test" },
    }).label).toBe("EXACT");
    expect(assessQueryProductRelevance({
      listing: related,
      goal: goal(categoryTarget),
      semanticSignal: { label: "COMPLEMENT", confidence: 0.98, modelId: "semantic-test" },
    }).label).toBe("COMPLEMENT");
    expect(assessQueryProductRelevance({
      listing: primary,
      goal: goal(categoryTarget),
      semanticSignal: { label: "EXACT", confidence: 0.79, modelId: "semantic-test" },
    }).label).toBe("UNRESOLVED");
  });

  it("keeps a specific target phrase binding after broad category normalization", () => {
    const overEarTarget: SearchTargetSnapshot = {
      categoryId: "headphones",
      targetText: "头戴式耳机",
      canonicalModel: null,
      itemRole: "PRIMARY_PRODUCT",
      conditionPreference: "ANY",
    };
    const overEar = listing("over-ear", "Wireless Over-Ear Headphones", overEarTarget, ["Electronics", "Headphones"], "Headphones");
    const differentForm = listing("open-ear", "Bone Conduction Open-Ear Headphones", overEarTarget, ["Electronics", "Headphones"], "Headphones");

    expect(assessQueryProductRelevance({ listing: overEar, goal: goal(overEarTarget) })).toMatchObject({
      label: "UNRESOLVED",
      reasonCodes: ["SPECIFIC_TARGET_REQUIRES_SEMANTIC_CORROBORATION"],
    });
    expect(assessQueryProductRelevance({
      listing: overEar,
      goal: goal(overEarTarget),
      semanticSignal: { label: "EXACT", confidence: 0.95, modelId: "semantic-test" },
    }).label).toBe("EXACT");
    expect(assessQueryProductRelevance({
      listing: differentForm,
      goal: goal(overEarTarget),
      semanticSignal: { label: "SUBSTITUTE", confidence: 0.95, modelId: "semantic-test" },
    }).label).toBe("SUBSTITUTE");
  });

  it("never lets non-EXACT cohorts enter main ranking", () => {
    const candidates = [
      listing("exact-rank", "Sony WH-1000XM5 Wireless Headphones", headphoneTarget, ["Electronics", "Headphones"], "Headphones"),
      listing("substitute-rank", "Bose QuietComfort Ultra Headphones", headphoneTarget, ["Electronics", "Headphones"], "Headphones"),
      listing("complement-rank", "Protective Case compatible with Sony WH-1000XM5", headphoneTarget, ["Headphone Accessories"], "Headphone Case"),
      listing("irrelevant-rank", "Apple iPhone 16 Pro 256GB Smartphone", headphoneTarget, ["Cell Phones"], "Smartphone"),
      listing("unresolved-rank", "Wireless Noise Cancelling Headphones", headphoneTarget, ["Headphones"], "Headphones"),
    ];
    const result = buildRankedOfferSet(candidates, goal(headphoneTarget), new Map([["USD", fx]]));
    expect(result.rankedOffers.map((item) => item.offer.queryProductRelevance.label)).toEqual(["EXACT"]);
    expect(result.eligibilityResults.map((item) => item.queryProductRelevance.label)).toEqual(["EXACT", "SUBSTITUTE", "COMPLEMENT", "IRRELEVANT", "UNRESOLVED"]);
  });
});
