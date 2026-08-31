import { describe, expect, it } from "vitest";

import {
  canonicalModels,
  ingestBuyWhereListing,
  resolveCategoryValidationPolicy,
  resolveMarketDefinition,
  resolveProductTarget,
  type BuyWhereRawProduct,
  type ListingIngestionContext,
} from "../src/index.js";

const observedAt = "2026-08-26T00:00:00.000Z";

function smartphoneListing(raw: BuyWhereRawProduct) {
  const target = resolveProductTarget("Apple iPhone 15 Pro smartphone");
  const context: ListingIngestionContext = { retrievalMarket: "US", target, observedAt, rawArtifactRef: "sha256:smartphone" };
  return ingestBuyWhereListing(raw, context);
}

function commercial(overrides: Partial<BuyWhereRawProduct>): BuyWhereRawProduct {
  return {
    id: "phone-1",
    title: "Apple iPhone 15 Pro 256GB Smartphone",
    price: { amount: "899", currency: "USD" },
    merchant: "Phone Merchant",
    url: "https://merchant.us/iphone-15-pro",
    country_code: "US",
    category_path: ["Electronics", "Mobile Phones", "Smartphones"],
    ...overrides,
  };
}

describe("versioned catalog contracts", () => {
  it("publishes headphones and smartphone as explicit category contracts", () => {
    expect(resolveCategoryValidationPolicy("耳机")).toMatchObject({ categoryId: "headphones", schemaVersion: 1 });
    expect(resolveCategoryValidationPolicy("smartphone")).toMatchObject({ categoryId: "smartphone", schemaVersion: 1 });
    expect(resolveCategoryValidationPolicy("unbounded-category")).toBeNull();
  });

  it("publishes US and SG as market contracts instead of core branching", () => {
    expect(resolveMarketDefinition("us")).toMatchObject({ marketId: "US", defaultCurrency: "USD" });
    expect(resolveMarketDefinition("SG")).toMatchObject({ marketId: "SG", defaultCurrency: "SGD" });
    expect(resolveMarketDefinition("VN")).toBeNull();
  });

  it("normalizes smartphone model families without a generic ontology", () => {
    expect(canonicalModels("Apple iPhone 15 Pro Max", "smartphone")).toEqual(["IPHONE 15 PRO MAX"]);
    expect(canonicalModels("Samsung Galaxy S24 Ultra", "smartphone")).toEqual(["GALAXY S24 ULTRA"]);
    expect(resolveProductTarget("比较 iPhone 15 Pro 手机")).toMatchObject({ categoryId: "smartphone", canonicalModel: "IPHONE 15 PRO", itemRole: "PRIMARY_PRODUCT" });
  });

  it("does not interpret a natural-language budget amount as a headphone model", () => {
    expect(canonicalModels("I want to buy over-ear headphones with a budget of 3000 CNY.", "headphones")).toEqual([]);
    expect(canonicalModels("Sony WH-1000XM5 headphones", "headphones")).toEqual(["WH1000XM5"]);
    expect(canonicalModels("sony wh-1000xm5 headphones", "headphones")).toEqual(["WH1000XM5"]);
  });

  it("promotes a matching smartphone identity but fails closed on phone accessories", () => {
    const phone = smartphoneListing(commercial({}));
    expect(phone?.identity).toMatchObject({ status: "RESOLVED", categoryId: { value: "smartphone" }, itemRole: { value: "PRIMARY_PRODUCT" } });

    const caseListing = smartphoneListing(commercial({
      id: "case-1",
      title: "Protective Phone Case for Apple iPhone 15 Pro",
      category_path: ["Electronics", "Phone Cases"],
    }));
    expect(caseListing?.identity).toMatchObject({ status: "CONFLICTED", itemRole: { value: "ACCESSORY" } });
  });

  it("resolves a category-level primary product when the listing supplies a stable model", () => {
    const target = resolveProductTarget("headphones");
    const listing = ingestBuyWhereListing(commercial({
      id: "headphone-1",
      title: "Hifiman HE1000 Planar Magnetic Headphones",
      category_path: ["Electronics", "Headphones"],
    }), { retrievalMarket: "US", target, observedAt, rawArtifactRef: "sha256:category-level" });
    expect(target.canonicalModel).toBeNull();
    expect(listing?.identity).toMatchObject({
      status: "RESOLVED",
      canonicalModel: { value: "HE1000" },
      categoryId: { value: "headphones" },
      itemRole: { value: "PRIMARY_PRODUCT" },
    });
  });

  it("does not let a broad accessories parent category override a primary-product title", () => {
    const target = resolveProductTarget("headphones");
    const listing = ingestBuyWhereListing(commercial({
      id: "quietcomfort-1",
      title: "Bose QuietComfort Wireless Over-Ear Active Noise Canceling Headphones",
      category_path: ["Electronics", "Headphones, Earbuds & Accessories", "Over-Ear Headphones"],
    }), { retrievalMarket: "US", target, observedAt, rawArtifactRef: "sha256:category-parent" });
    expect(listing?.identity).toMatchObject({
      status: "RESOLVED",
      canonicalModel: { value: "BOSE QUIETCOMFORT" },
      itemRole: { value: "PRIMARY_PRODUCT" },
    });
  });

  it("resolves a category-level primary listing even when no canonical model token is present", () => {
    const target = resolveProductTarget("headphones");
    const listing = ingestBuyWhereListing(commercial({
      id: "generic-anc-1",
      title: "Oraimo Bluetooth Headphones Active Noise Cancelling",
      category_path: ["Electronics", "Headphones, Earbuds & Accessories", "Over-Ear Headphones"],
    }), { retrievalMarket: "US", target, observedAt, rawArtifactRef: "sha256:generic-primary" });
    expect(listing?.identity).toMatchObject({
      status: "RESOLVED",
      canonicalModel: { value: null },
      itemRole: { value: "PRIMARY_PRODUCT" },
    });
    expect(listing?.identity.comparisonKey).toContain("TITLE:ORAIMO BLUETOOTH HEADPHONES ACTIVE NOISE CANCELLING");
  });
});
