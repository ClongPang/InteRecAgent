import { createHash } from "node:crypto";

import { resolveQuoteTarget, type FxSnapshot, type QuoteTargetResolution } from "@retail-price/domain";
import { describe, expect, it, vi } from "vitest";

import {
  QUOTE_PROVIDER_CONTRACT_VERSION,
  QuoteLookupService,
  buildQuoteProvenance,
  type FxPort,
  type QuoteProvider,
  type QuoteProviderResult,
} from "../src/index.js";

function resolvedTarget(): QuoteTargetResolution {
  return resolveQuoteTarget({
    rawText: "Sony WH-1000XM5 headphones quote",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
}

function rawRecord(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `record-${index}`,
    title: "Sony WH-1000XM5 Wireless Headphones",
    price: { amount: String(400 - index * 10), currency: "SGD" },
    merchant: "Example Shop",
    url: "https://shop.example/product/wh-1000xm5?sku=black",
    outbound_url: "https://shop.example/product/wh-1000xm5?sku=black&utm_source=buywhere",
    updated_at: "2026-09-01T00:30:00.000Z",
    ...overrides,
  };
}

function providerResult(status: QuoteProviderResult["status"], records: Record<string, unknown>[], failure: QuoteProviderResult["failure"] = null): QuoteProviderResult {
  const rawPayload = { best_price: records[0] ?? null, alternatives: records.slice(1), meta: { status: status.toLowerCase() } };
  const artifactRef = `sha256:${createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex")}`;
  return {
    status,
    records,
    meta: { status: status.toLowerCase(), emptinessReason: null, confidence: null, engineStatus: null, raw: { status: status.toLowerCase() } },
    failure,
    rawPayload,
    artifactRef,
    observedAt: "2026-09-01T01:00:00.000Z",
    providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
  };
}

function provider(result: QuoteProviderResult) {
  const lookup = vi.fn<QuoteProvider["lookup"]>().mockResolvedValue(result);
  return { value: { lookup } satisfies QuoteProvider, lookup };
}

function fxSnapshot(base: string, rate: string): FxSnapshot {
  return {
    id: `11111111-1111-4111-8111-${base === "SGD" ? "111111111111" : "222222222222"}`,
    base,
    quote: "CNY",
    rate,
    provider: "fixture-fx",
    observedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("QuoteLookupService", () => {
  it("does not call BuyWhere when the target is not resolved", async () => {
    const harness = provider(providerResult("OK_EMPTY", []));
    const service = new QuoteLookupService(harness.value);
    const unresolved = resolveQuoteTarget({ rawText: "Soni WH-1000XM55 quote", proposedModel: "WH-1000XM5", brand: "Sony" });
    await expect(service.lookup(unresolved)).resolves.toMatchObject({
      status: "TARGET_CONFIRMATION_REQUIRED",
      leadSet: null,
    });
    expect(harness.lookup).not.toHaveBeenCalled();
  });

  it("distinguishes provider empty from provider degradation", async () => {
    const emptyService = new QuoteLookupService(provider(providerResult("OK_EMPTY", [])).value);
    const empty = await emptyService.lookup(resolvedTarget());
    expect(empty).toMatchObject({
      status: "LOOKUP_COMPLETED",
      leadSet: { outcome: "NO_QUOTE_LEADS", reasonCodes: ["PROVIDER_RETURNED_EMPTY"], observations: [] },
    });

    const degradedService = new QuoteLookupService(provider(providerResult(
      "DEGRADED",
      [rawRecord(0)],
      { code: "BUYWHERE_DEGRADED_TIMEOUT", retryable: true },
    )).value);
    const degraded = await degradedService.lookup(resolvedTarget());
    expect(degraded).toMatchObject({
      status: "LOOKUP_COMPLETED",
      leadSet: {
        outcome: "DEGRADED",
        reasonCodes: ["BUYWHERE_DEGRADED_TIMEOUT"],
        observations: [{ providerRecordId: "record-0" }],
        leads: [],
      },
    });
  });

  it("reports all returned-but-rejected records separately from an empty provider response", async () => {
    const service = new QuoteLookupService(provider(providerResult("OK_RESULTS", [
      rawRecord(0, { title: "Replacement ear pads for Sony WH-1000XM5" }),
      rawRecord(1, { title: "Sony WH-1000XM5 repair service" }),
    ])).value);
    const execution = await service.lookup(resolvedTarget());
    expect(execution).toMatchObject({
      leadSet: {
        outcome: "NO_QUOTE_LEADS",
        reasonCodes: ["ALL_RECORDS_REJECTED"],
        observations: [{}, {}],
        admissions: [{ status: "REJECTED" }, { status: "REJECTED" }],
        leads: [],
      },
    });
  });

  it("keeps original-currency leads when every FX lookup fails", async () => {
    const fx: FxPort = { getRate: vi.fn().mockRejectedValue(new Error("FX_UNAVAILABLE")) };
    const service = new QuoteLookupService(provider(providerResult("OK_RESULTS", [
      rawRecord(0, { price: { amount: "399.90", currency: "SGD" } }),
      rawRecord(1, { price: { amount: "279.00", currency: "USD" } }),
    ])).value, fx);
    const execution = await service.lookup(resolvedTarget());
    expect(execution.status).toBe("LOOKUP_COMPLETED");
    if (execution.status !== "LOOKUP_COMPLETED") throw new Error("unexpected target result");
    expect(execution.leadSet.outcome).toBe("QUOTE_LEADS");
    expect(execution.leadSet.fxSnapshots).toEqual([]);
    expect(execution.leadSet.leads[0]?.priceRanges).toEqual([
      expect.objectContaining({ currency: "SGD", minAmount: "399.9", cnyEstimate: null }),
      expect.objectContaining({ currency: "USD", minAmount: "279", cnyEstimate: null }),
    ]);
  });

  it("adds an explicitly timestamped CNY estimate without replacing original money", async () => {
    const fx: FxPort = {
      getRate: vi.fn(async (base) => base === "SGD" ? fxSnapshot("SGD", "5.55") : fxSnapshot("USD", "7.25")),
    };
    const service = new QuoteLookupService(provider(providerResult("OK_RESULTS", [rawRecord(0)])).value, fx);
    const execution = await service.lookup(resolvedTarget());
    if (execution.status !== "LOOKUP_COMPLETED") throw new Error("unexpected target result");
    expect(execution.leadSet.leads[0]?.priceRanges[0]).toMatchObject({
      currency: "SGD",
      minAmount: "400",
      cnyEstimate: {
        minAmount: "2220.00",
        maxAmount: "2220.00",
        fxObservedAt: "2026-09-01T00:00:00.000Z",
      },
    });
  });

  it("ignores an FX snapshot with an invalid validity window", async () => {
    const invalid = { ...fxSnapshot("SGD", "5.55"), expiresAt: "2026-08-31T00:00:00.000Z" };
    const service = new QuoteLookupService(provider(providerResult("OK_RESULTS", [rawRecord(0)])).value, {
      getRate: vi.fn().mockResolvedValue(invalid),
    });
    const execution = await service.lookup(resolvedTarget());
    if (execution.status !== "LOOKUP_COMPLETED") throw new Error("unexpected target result");
    expect(execution.leadSet.fxSnapshots).toEqual([]);
    expect(execution.leadSet.leads[0]?.priceRanges[0]?.cnyEstimate).toBeNull();
  });

  it("passes exactly the deterministic canonical query to the provider", async () => {
    const harness = provider(providerResult("OK_EMPTY", []));
    await new QuoteLookupService(harness.value).lookup(resolvedTarget());
    expect(harness.lookup).toHaveBeenCalledWith({ canonicalQuery: "Sony WH-1000XM5 headphones" }, undefined);
  });
});

describe("quote provenance", () => {
  it("grounds every visible field in observation facts and FX snapshots", async () => {
    const fx: FxPort = { getRate: vi.fn(async () => fxSnapshot("SGD", "5.55")) };
    const execution = await new QuoteLookupService(provider(providerResult("OK_RESULTS", [
      rawRecord(0, { availability: "in_stock" }),
      rawRecord(1, { price: { amount: "350", currency: "SGD" }, availability: "out_of_stock" }),
    ])).value, fx).lookup(resolvedTarget());
    if (execution.status !== "LOOKUP_COMPLETED") throw new Error("unexpected target result");
    const provenance = buildQuoteProvenance(execution.leadSet);
    const factRefs = new Set(provenance.sourceFacts.map((fact) => fact.sourceFactRef));
    expect(provenance.claims.length).toBeGreaterThan(0);
    expect(provenance.claims.every((claim) => claim.evidenceRefs.length > 0)).toBe(true);
    expect(provenance.claims.flatMap((claim) => claim.evidenceRefs).every((item) => factRefs.has(item.sourceFactRef))).toBe(true);
    expect(provenance.claims.some((claim) => claim.kind === "CNY_ESTIMATE_RANGE" && claim.evidenceRefs.every((ref) => ref.fxSnapshotId))).toBe(true);
    expect(provenance.sourceFacts.some((fact) => fact.factKind.includes("AVAILABILITY"))).toBe(false);
    expect(provenance.claims.some((claim) => JSON.stringify(claim.canonicalValue).includes("in_stock"))).toBe(false);
  });
});
