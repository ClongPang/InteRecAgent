import { describe, expect, it } from "vitest";

import {
  admitQuoteObservation,
  createQuoteObservation,
  groupQuoteObservations,
  normalizeMerchantTargetUrl,
  resolveQuoteTarget,
  type QuoteObservation,
  type QuoteTarget,
} from "../src/index.js";

function target(overrides: Partial<QuoteTarget> = {}): QuoteTarget {
  const resolved = resolveQuoteTarget({
    rawText: "Sony WH1000XM5 headphones quote",
    proposedModel: "WH1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  if (resolved.status !== "RESOLVED") throw new Error("fixture target did not resolve");
  return { ...resolved.target, ...overrides };
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
    const result = resolveQuoteTarget({
      rawText: "  Sony   WH1000XM5 headphones  ",
      proposedModel: "wh1000xm5",
      brand: "sony",
      productType: "headphones",
    });
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
    expect(admitQuoteObservation(value, target())).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: expect.arrayContaining(["ORIGINAL_PRICE_MISSING_OR_INVALID", "MERCHANT_TARGET_URL_MISSING_OR_UNSAFE"]),
    });
  });

  it("requires an exact model identity rather than a prefix or edit-distance match", () => {
    const value = observation(0, { title: "Sony WH-1000XM55 Wireless Headphones" });
    expect(admitQuoteObservation(value, target())).toMatchObject({
      status: "REJECTED",
      reasonCodes: expect.arrayContaining(["MODEL_EXACT_MISMATCH"]),
    });
  });

  it.each([
    ["Replacement ear pads for Sony WH-1000XM5", "ACCESSORY_RECORD"],
    ["Sony WH-1000XM5 repair service", "SERVICE_RECORD"],
    ["Replacement spare part for Sony WH-1000XM5", "REPLACEMENT_OR_PART_RECORD"],
  ])("rejects a non-primary result: %s", (title, reason) => {
    const decision = admitQuoteObservation(observation(0, { title }), target());
    expect(decision.status).toBe("REJECTED");
    expect(decision.reasonCodes).toContain(reason);
  });

  it("fails closed on required qualifier and condition mismatches", () => {
    const requested = target({ requiredQualifiers: ["256GB"], conditionPreference: "REFURBISHED" });
    const decision = admitQuoteObservation(observation(0, { title: "New Sony WH-1000XM5 128GB Wireless Headphones" }), requested);
    expect(decision).toMatchObject({
      status: "REJECTED",
      reasonCodes: expect.arrayContaining(["REQUIRED_QUALIFIER_MISMATCH", "CONDITION_MISMATCH"]),
    });
  });

  it("never treats provider availability as an admission or ordering signal", () => {
    const unavailable = observation(0, { availability: "out_of_stock" });
    const available = observation(1, { availability: "in_stock" });
    expect(admitQuoteObservation(unavailable, target()).status).toBe("ELIGIBLE");
    expect(admitQuoteObservation(available, target()).status).toBe("ELIGIBLE");
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
    const decisions = values.map((value) => admitQuoteObservation(value, target()));
    const leads = groupQuoteObservations(target(), values, decisions);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      merchantTargetUrl: "https://shop.example/p/item?sku=42",
      observationCount: 3,
      observationRefs: values.map((value) => value.observationRef),
      disclosureCode: "MERCHANT_PAGE_CHECK_REQUIRED",
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
    const leads = groupQuoteObservations(requested, values, values.map((value) => admitQuoteObservation(value, requested)));
    expect(leads.map((lead) => lead.condition).sort()).toEqual(["NEW", "REFURBISHED"]);
    expect(leads.map((lead) => lead.quoteLeadRef)).toHaveLength(2);
  });
});
