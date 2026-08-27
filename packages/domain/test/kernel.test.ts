import { describe, expect, it } from "vitest";

import {
  buildComparisonSet,
  convertToCny,
  decideComparisonSet,
  ingestBuyWhereListing,
  qualifyListing,
  renderDecision,
  resolveProductTarget,
  type BuyWhereRawProduct,
  type DiscoveredListing,
  type FxSnapshot,
  type Goal,
  type ListingIngestionContext,
} from "../src/index.js";

const observedAt = "2026-08-26T00:00:00.000Z";
const fx: FxSnapshot = {
  id: "fx-usd-cny",
  base: "USD",
  quote: "CNY",
  rate: "7.1234",
  provider: "test",
  observedAt,
  expiresAt: "2026-08-27T00:00:00.000Z",
};
const target = resolveProductTarget("Sony WH-1000XM5 headphones");
const goal: Goal = {
  query: "Sony WH-1000XM5 headphones",
  target,
  markets: ["US", "SG"],
  budgetCny: "3000",
  stockPreference: "ANY",
  excludedOfferRefs: [],
};
const context: ListingIngestionContext = {
  retrievalMarket: "US",
  target,
  observedAt,
  rawArtifactRef: "sha256:artifact",
};

function raw(overrides: Partial<BuyWhereRawProduct> = {}): BuyWhereRawProduct {
  return {
    id: "p1",
    title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
    price: { amount: "299.99", currency: "USD" },
    merchant: "Example Merchant",
    url: "https://merchant.us/products/sony-wh1000xm5",
    click_url: "https://buywhere.ai/api/click?url=https%3A%2F%2Fmerchant.us%2Fproducts%2Fsony-wh1000xm5",
    country_code: "US",
    category_path: ["Electronics", "Portable Audio", "Headphones"],
    availability: { in_stock: true },
    ...overrides,
  };
}

function listing(overrides: Partial<BuyWhereRawProduct> = {}, customContext = context): DiscoveredListing {
  const result = ingestBuyWhereListing(raw(overrides), customContext);
  if (!result) throw new Error("fixture did not ingest");
  return result;
}

describe("proof-carrying offer kernel", () => {
  it("uses decimal arithmetic and deterministic rounding", () => {
    expect(convertToCny({ amount: "19.99", currency: "USD" }, fx)).toBe("142.40");
  });

  it("keeps the real merchant target separate from the attribution redirect", () => {
    const result = listing();
    expect(result.merchantDomain.value).toBe("merchant.us");
    expect(result.merchantTargetUrl.value).toContain("merchant.us/products");
    expect(result.outboundUrl.value).toContain("buywhere.ai/api/click");
    expect(result.merchantTargetUrl.evidence[0]?.jsonPath).toBe("$.url");
  });

  it("can safely derive a target URL from an allowlisted BuyWhere redirect", () => {
    const result = listing({ url: undefined });
    expect(result.merchantDomain.value).toBe("merchant.us");
    expect(result.merchantTargetUrl.status).toBe("DERIVED");
  });

  it("rejects unsafe or opaque redirect URLs during ingestion", () => {
    expect(ingestBuyWhereListing(raw({ url: "http://localhost/item", click_url: "https://unknown.example/click?url=https://merchant.us/item" }), context)).toBeNull();
  });

  it("rejects an attribution URL whose destination differs from the displayed merchant evidence", () => {
    expect(ingestBuyWhereListing(raw({
      url: "https://merchant.us/products/sony-wh1000xm5",
      click_url: "https://buywhere.ai/api/click?url=https%3A%2F%2Fevil.example%2Fother-product",
    }), context)).toBeNull();
    expect(ingestBuyWhereListing(raw({
      url: "https://merchant.us/products/sony-wh1000xm5",
      click_url: "https://evil.example/click?url=https%3A%2F%2Fmerchant.us%2Fproducts%2Fsony-wh1000xm5",
    }), context)).toBeNull();
  });

  it("promotes only a resolved identity with non-conflicting market evidence", () => {
    const result = qualifyListing(listing(), goal, new Map([["USD", fx]]));
    expect(result.status).toBe("COMPARABLE");
    expect(result.offer?.marketEvidence.level).toBe("TARGET_DOMAIN_MARKET_CONSISTENT");
    expect(result.offer?.qualification.policyVersion).toBe("proof-carrying-v2");
    expect(result.offer?.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("keeps an unregistered category discoverable without inventing an item identity", () => {
    const openTarget = {
      categoryId: "laptop",
      targetText: "lightweight laptop",
      canonicalModel: null,
      itemRole: "PRIMARY_PRODUCT" as const,
      conditionPreference: "ANY" as const,
    };
    const openGoal: Goal = {
      ...goal,
      query: "lightweight laptop for travel",
      target: openTarget,
      hardConstraints: [{ key: "weight", operator: "LTE", value: "1.5kg" }],
      preferenceHints: [{ key: "portable", value: "lightweight", weight: 1 }],
    };
    const openListing = listing({
      id: "laptop-1",
      title: "Lightweight Laptop 14 for Travel",
      category_path: ["Computers", "Laptops"],
      metadata: { product_type: "Notebook Computer" },
      url: "https://merchant.us/laptop-1",
      click_url: undefined,
    }, { ...context, target: openTarget, rawArtifactRef: "sha256:laptop" });
    const result = qualifyListing(openListing, openGoal, new Map([["USD", fx]]));
    expect(result).toMatchObject({
      status: "DISCOVERABLE",
      offer: {
        supportLevel: "DISCOVERY",
        productIdentity: { status: "UNRESOLVED", comparisonKey: null },
        discovery: {
          identityLevel: "OFFER_ONLY",
          identityKey: null,
          matchedPreferenceKeys: ["portable"],
        },
      },
    });
    expect(result.offer?.discovery.rankVector.eligibilityTier).toBe(1);
    expect(result.reasonCodes).toContain("HARD_CONSTRAINTS_UNVERIFIED");
  });

  it("ranks discovery offers lexicographically and deterministically", () => {
    const openTarget = { categoryId: "laptop", targetText: "lightweight laptop", canonicalModel: null, itemRole: "PRIMARY_PRODUCT" as const, conditionPreference: "ANY" as const };
    const openGoal: Goal = { ...goal, query: "lightweight laptop", target: openTarget, preferenceHints: [{ key: "portable", value: "lightweight", weight: 1 }] };
    const light = listing({ id: "light", title: "Lightweight Laptop 14", category_path: ["Laptops"], url: "https://merchant.us/light", click_url: undefined }, { ...context, target: openTarget, rawArtifactRef: "sha256:light" });
    const gaming = listing({ id: "gaming", title: "Gaming Laptop 16", category_path: ["Laptops"], price: { amount: "199", currency: "USD" }, url: "https://other.us/gaming", click_url: undefined }, { ...context, target: openTarget, rawArtifactRef: "sha256:gaming" });
    const left = buildComparisonSet([gaming, light], openGoal, new Map([["USD", fx]])).rankedOffers;
    const right = buildComparisonSet([light, gaming], openGoal, new Map([["USD", fx]])).rankedOffers;
    expect(left.map((item) => item.offer.offerRef)).toEqual(right.map((item) => item.offer.offerRef));
    expect(left[0]?.offer.title).toBe("Lightweight Laptop 14");
    expect(left[0]?.rankVector.positiveCoverage).toBe(1);
  });

  it("keeps multiple product identities in a category-level recommendation set", () => {
    const categoryTarget = resolveProductTarget("headphones");
    const categoryContext = { ...context, target: categoryTarget };
    const categoryGoal: Goal = { ...goal, query: "headphones", target: categoryTarget };
    const first = listing({ id: "generic-1", title: "Oraimo Active Noise Cancelling Headphones", url: "https://merchant.us/oraimo", click_url: undefined }, categoryContext);
    const second = listing({ id: "bose-1", title: "Bose QuietComfort Active Noise Cancelling Headphones", url: "https://merchant.us/bose", click_url: undefined }, categoryContext);
    const comparison = buildComparisonSet([first, second], categoryGoal, new Map([["USD", fx]]));
    expect(comparison.rankedOffers).toHaveLength(2);
    expect(new Set(comparison.rankedOffers.map((item) => item.offer.productIdentity.comparisonKey)).size).toBe(2);
  });

  it("requires category-contract evidence for a hard noise-cancelling constraint", () => {
    const constrained: Goal = {
      ...goal,
      hardConstraints: [{ key: "noise_cancelling", operator: "EQ", value: true }],
    };
    expect(qualifyListing(listing(), constrained, new Map([["USD", fx]]))).toMatchObject({ status: "COMPARABLE" });
    expect(qualifyListing(listing({ title: "Sony WH-1000XM5 Open-Back Headphones" }), constrained, new Map([["USD", fx]]))).toMatchObject({
      status: "INELIGIBLE",
      reasonCodes: ["HARD_CONSTRAINT_CONFLICT"],
    });
    expect(qualifyListing(listing({ title: "Sony WH-1000XM5 Wireless Headphones" }), constrained, new Map([["USD", fx]]))).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["HARD_CONSTRAINT_EVIDENCE_REQUIRED"],
    });
  });

  it("fails closed when Provider country and merchant country conflict", () => {
    const kuwait = listing({ url: "https://merchant.kw/products/sony", click_url: "https://buywhere.ai/api/click?url=https%3A%2F%2Fmerchant.kw%2Fproducts%2Fsony", country_code: "US" });
    expect(qualifyListing(kuwait, goal, new Map([["USD", fx]]))).toMatchObject({
      status: "INELIGIBLE",
      reasonCodes: ["MARKET_EVIDENCE_CONFLICT"],
      offer: null,
    });
  });

  it("does not promote a generic-domain listing without a market attestation", () => {
    const unknown = listing({ url: "https://merchant.com/products/sony", click_url: undefined, country_code: undefined });
    expect(qualifyListing(unknown, goal, new Map([["USD", fx]]))).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["MARKET_EVIDENCE_REQUIRED"],
    });
  });

  it("models compatible-with listings as a different item role instead of growing a product blacklist", () => {
    const accessory = listing({
      title: "Protective accessory compatible with Sony WH-1000XM5 headphones",
      category_path: ["Electronics", "Headphone Accessories"],
    });
    expect(accessory.identity.itemRole.value).toBe("ACCESSORY");
    expect(qualifyListing(accessory, goal, new Map([["USD", fx]]))).toMatchObject({
      status: "INELIGIBLE",
      reasonCodes: ["PRODUCT_IDENTITY_CONFLICT"],
    });
  });

  it("fails closed for phone accessories, the wrong storage variant, and unknown condition on an exact-new target", () => {
    const phoneTarget = {
      categoryId: "smartphone",
      canonicalModel: "IPHONE 16 PRO 256GB",
      itemRole: "PRIMARY_PRODUCT" as const,
      conditionPreference: "NEW" as const,
    };
    const phoneContext: ListingIngestionContext = { ...context, target: phoneTarget };
    const phoneGoal: Goal = { ...goal, query: "iPhone 16 Pro 256GB new", target: phoneTarget };
    const phoneListing = (id: string, title: string) => listing({
      id,
      title,
      category_path: ["Cell Phones & Smartphones"],
      url: `https://merchant.us/${id}`,
      click_url: undefined,
    }, { ...phoneContext, rawArtifactRef: `sha256:${id}` });

    const accessory = phoneListing("case", "Presidio2 Pro MagSafe Apple iPhone 16 Pro Case");
    expect(accessory.identity.itemRole.value).toBe("ACCESSORY");
    expect(qualifyListing(accessory, phoneGoal, new Map([["USD", fx]]))).toMatchObject({ status: "INELIGIBLE", reasonCodes: ["PRODUCT_IDENTITY_CONFLICT"] });

    const wrongStorage = phoneListing("128gb", "Brand New Apple iPhone 16 Pro Smartphone - 128GB");
    expect(qualifyListing(wrongStorage, phoneGoal, new Map([["USD", fx]]))).toMatchObject({ status: "INELIGIBLE", reasonCodes: ["PRODUCT_IDENTITY_CONFLICT"] });

    const unknownCondition = phoneListing("unknown-condition", "Apple iPhone 16 Pro Smartphone - 256GB");
    expect(qualifyListing(unknownCondition, phoneGoal, new Map([["USD", fx]]))).toMatchObject({ status: "INELIGIBLE", reasonCodes: ["CONDITION_MISMATCH"] });

    const exactNew = phoneListing("exact-new", "Brand New Apple iPhone 16 Pro Smartphone - 256GB");
    expect(qualifyListing(exactNew, phoneGoal, new Map([["USD", fx]]))).toMatchObject({ status: "COMPARABLE" });
    expect(exactNew.identity.canonicalModel.value).toBe("IPHONE 16 PRO 256GB");
  });

  it("keeps refurbished offers out of a new-or-unspecified comparison", () => {
    const refurbished = listing({ title: "Refurbished Sony WH-1000XM5 Wireless Headphones" });
    expect(qualifyListing(refurbished, goal, new Map([["USD", fx]]))).toMatchObject({
      status: "INELIGIBLE",
      reasonCodes: ["CONDITION_MISMATCH"],
    });
  });

  it("never mixes different condition comparison keys even when the goal allows any condition", () => {
    const newListing = listing({ id: "new", title: "Brand New Sony WH-1000XM5 Wireless Headphones" });
    const refurbished = listing({ id: "refurb", title: "Refurbished Sony WH-1000XM5 Wireless Headphones" }, { ...context, rawArtifactRef: "sha256:refurb" });
    const anyConditionGoal: Goal = { ...goal, target: { ...goal.target, conditionPreference: "ANY" } };
    const comparison = buildComparisonSet([refurbished, newListing], anyConditionGoal, new Map([["USD", fx]]));
    expect(comparison.rankedOffers).toHaveLength(1);
    expect(comparison.rankedOffers[0]?.offer.condition).toBe("NEW");
    expect(comparison.qualifications.find((item) => item.listing.listingRef === refurbished.listingRef)).toMatchObject({
      status: "INELIGIBLE",
      reasonCodes: ["COMPARISON_KEY_MISMATCH"],
    });
  });

  it("adding a cheaper unverified listing cannot change the primary offer", () => {
    const verified = listing();
    const unverified = listing(
      { id: "cheap", price: { amount: "69", currency: "USD" }, url: "https://merchant.com/cheap", click_url: undefined, country_code: undefined },
      { ...context, rawArtifactRef: "sha256:cheap" },
    );
    const baseline = decideComparisonSet(buildComparisonSet([verified], goal, new Map([["USD", fx]])));
    const mutated = decideComparisonSet(buildComparisonSet([unverified, verified], goal, new Map([["USD", fx]])));
    expect(mutated.primaryOffer?.offer.offerRef).toBe(baseline.primaryOffer?.offer.offerRef);
    expect(mutated.primaryOffer?.offer.originalMoney.amount).toBe("299.99");
  });

  it("ranking is deterministic under input permutation", () => {
    const first = listing({ id: "first", price: { amount: "299", currency: "USD" } });
    const second = listing({ id: "second", price: { amount: "289", currency: "USD" } }, { ...context, rawArtifactRef: "sha256:second" });
    const left = buildComparisonSet([first, second], goal, new Map([["USD", fx]])).rankedOffers.map((item) => item.offer.offerRef);
    const right = buildComparisonSet([second, first], goal, new Map([["USD", fx]])).rankedOffers.map((item) => item.offer.offerRef);
    expect(left).toEqual(right);
  });

  it("keeps one deterministic representative for duplicate merchant-product offers", () => {
    const higher = listing({ id: "higher", merchant: "merchant_us", price: { amount: "309", currency: "USD" }, url: "https://www.merchant.us/sony-higher", click_url: undefined });
    const lower = listing({ id: "lower", merchant: "merchant.us", price: { amount: "289", currency: "USD" }, url: "https://merchant.us/sony-lower", click_url: undefined }, { ...context, rawArtifactRef: "sha256:lower" });
    const comparison = buildComparisonSet([higher, lower, structuredClone(lower)], goal, new Map([["USD", fx]]));
    expect(comparison.policyVersion).toBe("proof-carrying-v2");
    expect(comparison.rankedOffers).toHaveLength(1);
    expect(comparison.rankedOffers[0]?.offer.originalMoney.amount).toBe("289");
    expect(comparison.qualifications.find((item) => item.listing.listingRef === higher.listingRef)).toMatchObject({
      status: "INELIGIBLE",
      reasonCodes: ["DUPLICATE_MERCHANT_PRODUCT_OFFER"],
      offer: null,
    });
  });

  it("renders only promoted evidence and discloses the market boundary", () => {
    const decision = decideComparisonSet(buildComparisonSet([listing()], goal, new Map([["USD", fx]])));
    const rendered = renderDecision(decision);
    expect(rendered).toContain("merchant.us");
    expect(rendered).toContain("目标站点域名与市场一致");
    expect(rendered).toContain("市场归类不等于配送资格");
  });
});
