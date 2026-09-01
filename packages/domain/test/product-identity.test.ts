import { describe, expect, it } from "vitest";

import {
  emptyQuoteConversationState,
  findProductIdentityCandidates,
  identityBindingFromResolution,
  InMemoryProductIdentityRegistry,
  normalizeProductIdentifier,
  resolveProductIdentity,
  resolveProductIdentityFromRegistry,
  resolveQuoteTarget,
  upcastLegacyQuoteTarget,
  validateProductIdentitySnapshot,
  validateQuoteConversationState,
  type ProductIdentitySnapshot,
} from "../src/index.js";

function snapshot(): ProductIdentitySnapshot {
  const registryVersion = 7;
  return {
    schemaVersion: 1,
    registryVersion,
    checksum: "fixture-checksum-v7",
    brands: [
      { registryVersion, brandRef: "brand_sony", canonicalName: "Sony", aliases: ["Sony", "索尼"], sourceRef: "fixture:sony" },
      { registryVersion, brandRef: "brand_example", canonicalName: "Example", aliases: ["Example"], sourceRef: "fixture:example" },
    ],
    products: [
      { registryVersion, productRef: "product_sony_wh", brandRef: "brand_sony", canonicalName: "WH-1000X", productType: "headphones", sourceRef: "fixture:sony-wh" },
      { registryVersion, productRef: "product_example_xm", brandRef: "brand_example", canonicalName: "Example XM", productType: "headphones", sourceRef: "fixture:example-xm" },
    ],
    variants: [
      { registryVersion, variantRef: "variant_sony_xm5", productRef: "product_sony_wh", canonicalModel: "WH-1000XM5", attributes: {}, status: "ACTIVE", sourceRef: "fixture:sony-xm5" },
      { registryVersion, variantRef: "variant_example_xm5", productRef: "product_example_xm", canonicalModel: "XM5-PRO", attributes: {}, status: "ACTIVE", sourceRef: "fixture:example-xm5" },
    ],
    identifiers: [
      { registryVersion, identifierRef: "identifier_sony_gtin", variantRef: "variant_sony_xm5", brandRef: "brand_sony", scheme: "GTIN", normalizedValue: "4006381333931", approvalStatus: "APPROVED", sourceRef: "fixture:gtin" },
      { registryVersion, identifierRef: "identifier_example_mpn", variantRef: "variant_example_xm5", brandRef: "brand_example", scheme: "BRAND_MPN", normalizedValue: "XM5PRO", approvalStatus: "APPROVED", sourceRef: "fixture:mpn" },
    ],
    aliases: [
      { registryVersion, aliasRef: "alias_sony_model", variantRef: "variant_sony_xm5", purpose: "USER_INPUT", displayValue: "WH-1000XM5", normalizedKey: "WH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef: "fixture:alias" },
      { registryVersion, aliasRef: "alias_sony_short", variantRef: "variant_sony_xm5", purpose: "USER_INPUT", displayValue: "XM5", normalizedKey: "XM5", approvalStatus: "APPROVED", priority: 10, sourceRef: "fixture:alias" },
      { registryVersion, aliasRef: "alias_example_short", variantRef: "variant_example_xm5", purpose: "USER_INPUT", displayValue: "XM5", normalizedKey: "XM5", approvalStatus: "APPROVED", priority: 10, sourceRef: "fixture:alias" },
      { registryVersion, aliasRef: "alias_unapproved", variantRef: "variant_sony_xm5", purpose: "USER_INPUT", displayValue: "Sony flagship", normalizedKey: "SONYFLAGSHIP", approvalStatus: "PROPOSED", priority: 20, sourceRef: "fixture:proposal" },
      { registryVersion, aliasRef: "alias_provider", variantRef: "variant_sony_xm5", purpose: "PROVIDER_QUERY", displayValue: "Sony WH-1000XM5", normalizedKey: "SONYWH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef: "fixture:provider-query" },
    ],
    relationships: [
      { registryVersion, relationshipRef: "relationship_example_accessory", fromVariantRef: "variant_example_xm5", toVariantRef: "variant_sony_xm5", kind: "ACCESSORY_OF", sourceRef: "fixture:relationship" },
    ],
  };
}

describe("versioned product identity kernel", () => {
  it("exposes only approved user-input aliases as bounded LLM candidates", () => {
    const exact = findProductIdentityCandidates(snapshot(), ["Quote Sony WH1000XM5"]);
    expect(exact).toEqual([expect.objectContaining({
      variantRef: "variant_sony_xm5",
      canonicalModel: "WH-1000XM5",
      evidenceRefs: ["alias_sony_model"],
    })]);
    expect(findProductIdentityCandidates(snapshot(), ["Quote XM5"]).map((item) => item.variantRef)).toEqual([
      "variant_example_xm5",
      "variant_sony_xm5",
    ]);
    expect(findProductIdentityCandidates(snapshot(), ["Sony flagship alias_provider"]))
      .toEqual([]);
  });

  it("resolves punctuation aliases from approved user-input data and selects a separate provider-query alias", () => {
    const result = resolveProductIdentity(snapshot(), {
      rawText: "查 Sony WH1000XM5 报价",
      proposedModel: "WH1000XM5",
      brand: "Sony",
    });
    expect(result).toMatchObject({
      outcome: "RESOLVED",
      strength: "CURATED_ALIAS",
      registryVersion: 7,
      canonicalModel: "WH-1000XM5",
      providerQuery: "Sony WH-1000XM5",
      candidate: { variantRef: "variant_sony_xm5" },
    });
    expect(result.evidenceRefs).toEqual(["alias_provider", "alias_sony_model"]);
  });

  it("never lets proposed aliases authorize a registry resolution", () => {
    const result = resolveProductIdentity(snapshot(), {
      rawText: "查 Sony flagship 报价",
      proposedModel: "flagship",
      brand: "Sony",
    });
    expect(result).toMatchObject({ outcome: "RESOLVED", strength: "USER_CONFIRMED_LITERAL", registryVersion: null, candidate: null });
    expect(result.evidenceRefs).toEqual(["USER_SOURCE_LITERAL"]);
  });

  it("returns all candidates instead of collapsing an ambiguous approved alias", () => {
    const result = resolveProductIdentity(snapshot(), { rawText: "查 XM5 报价", proposedModel: "XM5", brand: null });
    expect(result).toMatchObject({ outcome: "NEEDS_CONFIRMATION", strength: "NONE", reasonCodes: ["ALIAS_AMBIGUOUS"] });
    if (result.outcome !== "NEEDS_CONFIRMATION") throw new Error("expected ambiguity");
    expect(result.candidates.map((item) => item.variantRef)).toEqual(["variant_example_xm5", "variant_sony_xm5"]);
  });

  it("uses a verified identifier only after checksum normalization and brand scope", () => {
    expect(normalizeProductIdentifier("GTIN", "4 006381 333931")).toBe("4006381333931");
    const result = resolveProductIdentity(snapshot(), {
      rawText: "Sony 4006381333931",
      proposedModel: null,
      brand: "Sony",
      identifiers: [{ scheme: "GTIN", value: "4 006381 333931" }],
    });
    expect(result).toMatchObject({ outcome: "RESOLVED", strength: "VERIFIED_IDENTIFIER", candidate: { variantRef: "variant_sony_xm5" } });
  });

  it("rejects duplicate approved identifier authority in a snapshot", () => {
    const invalid = snapshot();
    invalid.identifiers.push({
      ...invalid.identifiers[0]!,
      identifierRef: "identifier_duplicate_gtin",
      variantRef: "variant_example_xm5",
      brandRef: "brand_example",
    });
    expect(() => validateProductIdentitySnapshot(invalid)).toThrowError(expect.objectContaining({ code: "DUPLICATE_APPROVED_PRODUCT_IDENTIFIER" }));
  });

  it("preserves long-tail exact literals without pretending they are registry-verified", () => {
    const result = resolveProductIdentity(snapshot(), { rawText: "Acme ZX-9000", proposedModel: "ZX-9000", brand: "Acme" });
    expect(result).toMatchObject({
      outcome: "RESOLVED",
      strength: "USER_CONFIRMED_LITERAL",
      registryVersion: null,
      candidate: null,
      canonicalModel: "ZX-9000",
      providerQuery: "Acme ZX-9000",
    });
    if (result.outcome !== "RESOLVED") throw new Error("expected literal resolution");
    expect(identityBindingFromResolution(result)).toMatchObject({ strength: "USER_CONFIRMED_LITERAL", variantRef: null });
  });

  it("provides a registry port without leaking mutable snapshots", async () => {
    const registry = new InMemoryProductIdentityRegistry(snapshot());
    const first = await registry.getActiveSnapshot();
    first.aliases.length = 0;
    expect((await registry.getActiveSnapshot()).aliases.length).toBeGreaterThan(0);
    await expect(resolveProductIdentityFromRegistry(registry, {
      rawText: "Sony WH-1000XM5",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
    })).resolves.toMatchObject({ outcome: "RESOLVED", strength: "CURATED_ALIAS" });
    await expect(registry.getSnapshot(99)).resolves.toBeNull();
  });
});

describe("legacy quote-target identity upcast", () => {
  it("adds deterministic literal provenance without changing targetRef or query semantics", () => {
    const resolution = resolveQuoteTarget({ rawText: "Sony WH-1000XM5", proposedModel: "WH-1000XM5", brand: "Sony" });
    if (resolution.status !== "RESOLVED") throw new Error("target fixture failed");
    const { identity: _identity, ...legacy } = resolution.target;
    const upcast = upcastLegacyQuoteTarget(legacy);
    expect(upcast.targetRef).toBe(resolution.target.targetRef);
    expect(upcast.canonicalQuery).toBe(resolution.target.canonicalQuery);
    expect(upcast.identity).toMatchObject({ strength: "USER_CONFIRMED_LITERAL", registryVersion: null, evidenceRefs: ["USER_SOURCE_LITERAL"] });
    const state = validateQuoteConversationState({ ...emptyQuoteConversationState(), target: legacy as never });
    expect(state.target).toEqual(upcast);
  });
});
