import { describe, expect, it } from "vitest";

import {
  createQuoteObservation,
  resolveOfferIdentity,
  resolveProductIdentity,
  resolveQuoteTarget,
  type ProductIdentitySnapshot,
} from "../src/index.js";

const SNAPSHOT: ProductIdentitySnapshot = {
  schemaVersion: 1,
  registryVersion: 3,
  checksum: "offer-identity-fixture-v3",
  brands: [{ registryVersion: 3, brandRef: "brand_sony", canonicalName: "Sony", aliases: ["Sony"], sourceRef: "test:sony" }],
  products: [{ registryVersion: 3, productRef: "product_sony_wh", brandRef: "brand_sony", canonicalName: "WH-1000X", productType: "headphones", sourceRef: "test:sony-wh" }],
  variants: [
    { registryVersion: 3, variantRef: "variant_xm4", productRef: "product_sony_wh", canonicalModel: "WH-1000XM4", attributes: {}, status: "ACTIVE", sourceRef: "test:xm4" },
    { registryVersion: 3, variantRef: "variant_xm5", productRef: "product_sony_wh", canonicalModel: "WH-1000XM5", attributes: {}, status: "ACTIVE", sourceRef: "test:xm5" },
  ],
  identifiers: [
    { registryVersion: 3, identifierRef: "gtin_xm4", variantRef: "variant_xm4", brandRef: "brand_sony", scheme: "GTIN", normalizedValue: "5901234123457", approvalStatus: "APPROVED", sourceRef: "test:gtin-xm4" },
    { registryVersion: 3, identifierRef: "gtin_xm5", variantRef: "variant_xm5", brandRef: "brand_sony", scheme: "GTIN", normalizedValue: "4006381333931", approvalStatus: "APPROVED", sourceRef: "test:gtin-xm5" },
  ],
  aliases: [
    { registryVersion: 3, aliasRef: "alias_xm4", variantRef: "variant_xm4", purpose: "USER_INPUT", displayValue: "WH-1000XM4", normalizedKey: "WH1000XM4", approvalStatus: "APPROVED", priority: 0, sourceRef: "test:alias-xm4" },
    { registryVersion: 3, aliasRef: "alias_xm5", variantRef: "variant_xm5", purpose: "USER_INPUT", displayValue: "WH-1000XM5", normalizedKey: "WH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef: "test:alias-xm5" },
    { registryVersion: 3, aliasRef: "provider_xm5", variantRef: "variant_xm5", purpose: "PROVIDER_QUERY", displayValue: "Sony WH-1000XM5", normalizedKey: "SONYWH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef: "test:provider-xm5" },
  ],
  relationships: [{ registryVersion: 3, relationshipRef: "xm5_successor", fromVariantRef: "variant_xm5", toVariantRef: "variant_xm4", kind: "SUCCESSOR_OF", sourceRef: "test:relationship" }],
};

function target() {
  const rawText = "Sony WH-1000XM5";
  const identityResolution = resolveProductIdentity(SNAPSHOT, { rawText, proposedModel: "WH-1000XM5", brand: "Sony" });
  const resolution = resolveQuoteTarget({ rawText, proposedModel: "WH-1000XM5", brand: "Sony", identityResolution });
  if (resolution.status !== "RESOLVED") throw new Error("offer target fixture failed");
  return resolution.target;
}

function observation(title: string, fields: Record<string, unknown> = {}) {
  return createQuoteObservation({
    rawRecord: {
      id: "offer-record",
      title,
      price: { amount: "399", currency: "SGD" },
      merchant: "Merchant",
      url: "https://merchant.example/item",
      ...fields,
    },
    recordIndex: 0,
    artifactRef: "sha256:offer-fixture",
    observedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("five-level Offer identity evidence", () => {
  it("publishes a matching approved identifier without requiring model text in the title", () => {
    const result = resolveOfferIdentity(observation("Sony Premium Wireless Headphones", {
      brand: "Sony",
      gtin: "4 006381 333931",
    }), target(), SNAPSHOT);
    expect(result).toMatchObject({ strength: "STRONG_IDENTIFIER_MATCH", publishable: true, reasonCodes: [] });
    expect(result.evidenceRefs).toEqual(expect.arrayContaining(["gtin_xm5"]));
  });

  it("rejects an approved identifier that resolves to a sibling Variant", () => {
    expect(resolveOfferIdentity(observation("Sony Premium Wireless Headphones", {
      brand: "Sony",
      gtin: "5901234123457",
    }), target(), SNAPSHOT)).toMatchObject({
      strength: "IDENTITY_OR_ROLE_CONFLICT",
      publishable: false,
      reasonCodes: ["OFFER_IDENTIFIER_VARIANT_CONFLICT"],
    });
  });

  it("publishes a curated title alias with auditable registry evidence", () => {
    const result = resolveOfferIdentity(observation("Sony WH-1000XM5 Wireless Headphones"), target(), SNAPSHOT);
    expect(result).toMatchObject({ strength: "CURATED_TITLE_ALIAS_MATCH", publishable: true });
    expect(result.evidenceRefs).toContain("alias_xm5");
  });

  it("keeps exact lexical identity available for a long-tail literal target", () => {
    const literal = resolveQuoteTarget({ rawText: "Acme ZX-9000", proposedModel: "ZX-9000", brand: "Acme" });
    if (literal.status !== "RESOLVED") throw new Error("literal target fixture failed");
    expect(resolveOfferIdentity(observation("Acme ZX-9000 Widget"), literal.target)).toMatchObject({
      strength: "EXACT_LEXICAL_MATCH",
      publishable: true,
    });
  });

  it("never publishes a merely plausible title", () => {
    expect(resolveOfferIdentity(observation("Sony Flagship Wireless Headphones"), target(), SNAPSHOT)).toMatchObject({
      strength: "PROBABILISTIC_CANDIDATE",
      publishable: false,
      reasonCodes: ["OFFER_IDENTITY_NOT_DETERMINISTIC"],
    });
  });

  it.each([
    ["Replacement ear pads for Sony WH-1000XM5", "OFFER_NON_PRIMARY_ROLE"],
    ["Sony WH-1000XM5 bundle with case", "OFFER_UNREQUESTED_BUNDLE"],
    ["Sony WH-1000XM4 Wireless Headphones", "OFFER_VARIANT_ALIAS_CONFLICT"],
  ])("rejects role or Variant conflict: %s", (title, reasonCode) => {
    expect(resolveOfferIdentity(observation(title), target(), SNAPSHOT)).toMatchObject({
      strength: "IDENTITY_OR_ROLE_CONFLICT",
      publishable: false,
      reasonCodes: [reasonCode],
    });
  });
});
