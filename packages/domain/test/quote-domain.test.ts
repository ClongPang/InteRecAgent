import { describe, expect, it } from "vitest";

import {
  admitQuoteObservation,
  createQuoteObservation,
  groupQuoteObservations,
  normalizeMerchantTargetUrl,
  resolveProductIdentity,
  resolveQuoteTarget,
  type ProductIdentitySnapshot,
  type QuoteObservation,
  type QuoteTarget,
} from "../src/index.js";

const IDENTITY_SNAPSHOT: ProductIdentitySnapshot = {
  schemaVersion: 1,
  registryVersion: 1,
  checksum: "quote-domain-identity-v1",
  brands: [{ registryVersion: 1, brandRef: "brand_sony", canonicalName: "Sony", aliases: ["Sony"], sourceRef: "test:sony" }],
  products: [{ registryVersion: 1, productRef: "product_sony_wh", brandRef: "brand_sony", canonicalName: "WH-1000X", productType: "headphones", sourceRef: "test:sony-wh" }],
  variants: [
    { registryVersion: 1, variantRef: "variant_sony_xm4", productRef: "product_sony_wh", canonicalModel: "WH-1000XM4", attributes: {}, status: "ACTIVE", sourceRef: "test:sony-xm4" },
    { registryVersion: 1, variantRef: "variant_sony_xm5", productRef: "product_sony_wh", canonicalModel: "WH-1000XM5", attributes: {}, status: "ACTIVE", sourceRef: "test:sony-xm5" },
  ],
  identifiers: [],
  aliases: [
    { registryVersion: 1, aliasRef: "alias_sony_xm4", variantRef: "variant_sony_xm4", purpose: "USER_INPUT", displayValue: "WH-1000XM4", normalizedKey: "WH1000XM4", approvalStatus: "APPROVED", priority: 0, sourceRef: "test:user-alias" },
    { registryVersion: 1, aliasRef: "alias_sony_model", variantRef: "variant_sony_xm5", purpose: "USER_INPUT", displayValue: "WH-1000XM5", normalizedKey: "WH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef: "test:user-alias" },
    { registryVersion: 1, aliasRef: "alias_sony_provider", variantRef: "variant_sony_xm5", purpose: "PROVIDER_QUERY", displayValue: "Sony WH-1000XM5 headphones", normalizedKey: "SONYWH1000XM5HEADPHONES", approvalStatus: "APPROVED", priority: 0, sourceRef: "test:provider-alias" },
  ],
  relationships: [],
};

function registryTargetInput(rawText: string, proposedModel: string, brand: string | null, productType: string | null) {
  return {
    rawText,
    proposedModel,
    brand,
    productType,
    identityResolution: resolveProductIdentity(IDENTITY_SNAPSHOT, { rawText, proposedModel, brand, productType }),
  };
}

function target(overrides: Partial<QuoteTarget> = {}): QuoteTarget {
  const resolved = resolveQuoteTarget(registryTargetInput(
    "Sony WH1000XM5 headphones quote",
    "WH1000XM5",
    "Sony",
    "headphones",
  ));
  if (resolved.status !== "RESOLVED") throw new Error("fixture target did not resolve");
  return { ...resolved.target, ...overrides };
}

function admit(value: QuoteObservation, quoteTarget = target()) {
  return admitQuoteObservation(value, quoteTarget, IDENTITY_SNAPSHOT);
}

function observation(index: number, overrides: Record<string, unknown> = {}): QuoteObservation {
  return createQuoteObservation({
    rawRecord: {
      id: `record-${index}`,
      title: "Sony WH-1000XM5 Wireless Headphones",
      price: { amount: "399.90", currency: "SGD" },
      merchant: "Example Shop",
      url: "https://shop.example/products/wh-1000xm5?sku=black",
      outbound_url: "https://shop.example/products/wh-1000xm5?sku=black&utm_source=buywhere",
      country_code: "SG",
      ...overrides,
    },
    recordIndex: index,
    artifactRef: "sha256:provider-envelope",
    observedAt: "2026-09-01T01:00:00.000Z",
  });
}

describe("quote target resolution", () => {
  it("normalizes only model punctuation/case and preserves grounded product-type context", () => {
    const result = resolveQuoteTarget(registryTargetInput(
      "  Sony   WH1000XM5 headphones  ",
      "wh1000xm5",
      "sony",
      "headphones",
    ));
    expect(result).toMatchObject({
      status: "RESOLVED",
      target: {
        canonicalModel: "WH-1000XM5",
        modelKey: "WH1000XM5",
        canonicalQuery: "Sony WH-1000XM5 headphones",
        confirmation: "LEXICALLY_GROUNDED",
      },
    });
    expect(result.normalizationChanges).toContain("MODEL_CASE_OR_PUNCTUATION_NORMALIZED");
  });

  it("does not silently replace model letters or digits", () => {
    const result = resolveQuoteTarget({
      rawText: "Soni WH-1000XM55 quote",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
    });
    expect(result).toMatchObject({ status: "NEEDS_CONFIRMATION", target: null });
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "MODEL_NOT_LEXICALLY_GROUNDED",
      "BRAND_NOT_LEXICALLY_GROUNDED",
    ]));
  });

  it("accepts a corrected identity only when the confirmation is explicit and auditable", () => {
    const result = resolveQuoteTarget({
      rawText: "I confirm Sony WH-1000XM5 headphones",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      productType: "headphones",
      explicitlyConfirmed: true,
    });
    expect(result).toMatchObject({ status: "RESOLVED", target: { confirmation: "EXPLICITLY_CONFIRMED" } });
  });

  it("does not let a model confirmation smuggle invented product-type context into the provider query", () => {
    const result = resolveQuoteTarget({
      rawText: "I confirm Sony WH-1000XM5",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      productType: "headphones",
      explicitlyConfirmed: true,
    });
    expect(result).toMatchObject({
      status: "NEEDS_CONFIRMATION",
      reasonCodes: expect.arrayContaining(["PRODUCT_TYPE_NOT_LEXICALLY_GROUNDED"]),
    });
  });
});

describe("quote observation and admission", () => {
  it("retains malformed provider records as observations instead of dropping them", () => {
    const rawRecord = { id: "bad-1", title: "Sony WH-1000XM5", price: null, url: "javascript:alert(1)", availability: { status: "available" } };
    const value = createQuoteObservation({ rawRecord, recordIndex: 3, artifactRef: "sha256:x", observedAt: "2026-09-01T00:00:00Z" });
    expect(value).toMatchObject({
      providerRecordId: "bad-1",
      recordIndex: 3,
      originalMoney: null,
      merchantTargetUrl: null,
      providerAvailability: { status: "available" },
      rawRecord,
    });
    expect(admit(value)).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: expect.arrayContaining(["ORIGINAL_PRICE_MISSING_OR_INVALID", "MERCHANT_TARGET_URL_MISSING_OR_UNSAFE"]),
    });
  });

  it("requires an exact model identity rather than a prefix or edit-distance match", () => {
    const value = observation(0, { title: "Sony WH-1000XM55 Wireless Headphones" });
    expect(admit(value)).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      identityStrength: "PROBABILISTIC_CANDIDATE",
      reasonCodes: expect.arrayContaining(["OFFER_IDENTITY_NOT_DETERMINISTIC"]),
    });
  });

  it("rejects a curated sibling Variant even when its title is otherwise plausible", () => {
    expect(admit(observation(0, { title: "Sony WH-1000XM4 Wireless Headphones" }))).toMatchObject({
      status: "REJECTED",
      identityStrength: "IDENTITY_OR_ROLE_CONFLICT",
      reasonCodes: expect.arrayContaining(["OFFER_VARIANT_ALIAS_CONFLICT"]),
    });
  });

  it.each([
    ["Replacement ear pads for Sony WH-1000XM5", "OFFER_NON_PRIMARY_ROLE"],
    ["Sony WH-1000XM5 repair service", "OFFER_NON_PRIMARY_ROLE"],
    ["Replacement spare part for Sony WH-1000XM5", "OFFER_NON_PRIMARY_ROLE"],
  ])("rejects a non-primary result: %s", (title, reason) => {
    const decision = admit(observation(0, { title }));
    expect(decision.status).toBe("REJECTED");
    expect(decision.reasonCodes).toContain(reason);
  });

  it("fails closed on required qualifier and condition mismatches", () => {
    const requested = target({ requiredQualifiers: ["256GB"], conditionPreference: "REFURBISHED" });
    const decision = admit(observation(0, { title: "New Sony WH-1000XM5 128GB Wireless Headphones" }), requested);
    expect(decision).toMatchObject({
      status: "REJECTED",
      reasonCodes: expect.arrayContaining(["OFFER_REQUIRED_VARIANT_ATTRIBUTE_MISMATCH", "CONDITION_MISMATCH"]),
    });
  });

  it("never treats provider availability as an admission or ordering signal", () => {
    const unavailable = observation(0, { availability: "out_of_stock" });
    const available = observation(1, { availability: "in_stock" });
    expect(admit(unavailable).status).toBe("ELIGIBLE");
    expect(admit(available).status).toBe("ELIGIBLE");
  });
});

describe("merchant-page quote grouping", () => {
  it("strips only known tracking parameters and preserves product/variant parameters", () => {
    expect(normalizeMerchantTargetUrl("https://SHOP.example/p/item/?utm_source=x&variant=blue&sku=42#reviews"))
      .toBe("https://shop.example/p/item?sku=42&variant=blue");
  });

  it("groups the same normalized URL and condition while retaining every observation and original-currency range", () => {
    const values = [
      observation(0, { price: { amount: "399.90", currency: "SGD" }, url: "https://shop.example/p/item?sku=42&utm_source=a" }),
      observation(1, { price: { amount: "349.50", currency: "SGD" }, url: "https://SHOP.example/p/item/?sku=42&utm_campaign=b" }),
      observation(2, { price: { amount: "279.00", currency: "USD" }, url: "https://shop.example/p/item?sku=42" }),
    ];
    const decisions = values.map((value) => admit(value));
    const leads = groupQuoteObservations(target(), values, decisions);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      merchantTargetUrl: "https://shop.example/p/item?sku=42",
      observationCount: 3,
      observationRefs: values.map((value) => value.observationRef),
      disclosureCode: "MERCHANT_PAGE_CHECK_REQUIRED",
      admissionPolicyVersion: "quote-admission-v2",
      identityStrength: "CURATED_TITLE_ALIAS_MATCH",
      priceRanges: [
        { currency: "SGD", minAmount: "349.5", maxAmount: "399.9", cnyEstimate: null },
        { currency: "USD", minAmount: "279", maxAmount: "279", cnyEstimate: null },
      ],
    });
  });

  it("keeps the same merchant page in separate condition groups", () => {
    const fresh = observation(0, { condition: "new", title: "New Sony WH-1000XM5 Wireless Headphones" });
    const renewed = observation(1, { condition: "refurbished", title: "Refurbished Sony WH-1000XM5 Wireless Headphones" });
    const requested = target({ conditionPreference: "ANY" });
    const values = [fresh, renewed];
    const leads = groupQuoteObservations(requested, values, values.map((value) => admit(value, requested)));
    expect(leads.map((lead) => lead.condition).sort()).toEqual(["NEW", "REFURBISHED"]);
    expect(leads.map((lead) => lead.quoteLeadRef)).toHaveLength(2);
  });
});
