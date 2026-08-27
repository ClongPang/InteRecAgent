import { describe, expect, it } from "vitest";

import { resolveProductTarget, type Goal } from "@interec/domain";

import { buildResearchProofBundle, BuyWhereClient, FxRatesClient, researchOffers, runResearchCampaign, resolveBuyWhereRuntimeConfig, resolveBuyWhereTimeoutMs, type ProductSearchPort } from "../src/index.js";

describe("provider adapters", () => {
  it("forces BuyWhere keyword mode and a bounded market query", async () => {
    let requested: URL | null = null;
    const client = new BuyWhereClient("test-key", { fetchImpl: (async (input) => {
      requested = new URL(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch });
    await client.search("Sony WH-1000XM5", "US", 99);
    expect(requested!.searchParams.get("mode")).toBe("keyword");
    expect(requested!.searchParams.get("country_code")).toBe("US");
    expect(requested!.searchParams.get("limit")).toBe("8");
  });

  it("normalizes runtime-specific timeout failures at the provider boundary", async () => {
    const client = new BuyWhereClient("test-key", {
      fetchImpl: (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch,
    });
    await expect(client.search("Sony WH-1000XM5", "US", 8)).rejects.toMatchObject({ message: "BUYWHERE_TIMEOUT", retryable: true });
  });

  it("preserves an external run cancellation instead of misreporting it as provider timeout", async () => {
    const controller = new AbortController();
    controller.abort(new Error("RUN_DEADLINE_EXCEEDED"));
    const client = new BuyWhereClient("test-key", {
      fetchImpl: (async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch,
    });
    await expect(client.search("Sony WH-1000XM5", "US", 8, controller.signal)).rejects.toThrow("RUN_DEADLINE_EXCEEDED");
  });

  it("validates and timestamps FX snapshots", async () => {
    const client = new FxRatesClient((async () => new Response(JSON.stringify({ date: "2026-08-26T00:00:00.000Z", rates: { CNY: 7.12 } }), { status: 200 })) as typeof fetch);
    const result = await client.getRate("usd");
    expect(result).toMatchObject({ base: "USD", quote: "CNY", rate: "7.12", provider: "fxratesapi" });
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.parse(result.observedAt));
  });

  it("uses a production-safe bounded BuyWhere timeout configuration", () => {
    expect(resolveBuyWhereTimeoutMs({})).toBe(10_000);
    expect(resolveBuyWhereTimeoutMs({ INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS: "12000" })).toBe(12_000);
    expect(() => resolveBuyWhereTimeoutMs({ INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS: "999" })).toThrow("INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS_OUT_OF_RANGE");
    expect(() => resolveBuyWhereTimeoutMs({ INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS: "fast" })).toThrow("INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS_INVALID");
    expect(resolveBuyWhereRuntimeConfig({ INTEREC_PROVIDER_BUYWHERE_API_KEY: " key ", INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS: "12000" })).toEqual({ apiKey: "key", timeoutMs: 12_000 });
    expect(() => resolveBuyWhereRuntimeConfig({})).toThrow("INTEREC_PROVIDER_BUYWHERE_API_KEY_REQUIRED");
  });
});

describe("evidence-gated cross-market research", () => {
  const goal: Goal = {
    query: "Sony WH-1000XM5 headphones",
    target: resolveProductTarget("Sony WH-1000XM5 headphones"),
    markets: ["US", "SG"],
    budgetCny: "2500",
    stockPreference: "ANY",
    excludedOfferRefs: [],
  };

  it("degrades one failed market and promotes only proof-carrying results", async () => {
    const productSource: ProductSearchPort = {
      search: async (_query, market) => {
        if (market === "SG") throw new Error("BUYWHERE_HTTP_503");
        return {
          market,
          products: [{
            id: "p1",
            title: "Sony WH-1000XM5 Headphones",
            price: { amount: "299", currency: "USD" },
            merchant: "Example",
            url: "https://merchant.us/p1",
            country_code: "US",
            category_path: ["Portable Audio", "Headphones"],
          }],
          artifactRef: "sha256:test",
          rawPayload: {},
          observedAt: "2026-08-26T00:00:00.000Z",
        };
      },
    };
    const result = await researchOffers(goal, goal.query, productSource, {
      getRate: async (base) => ({ id: "fx", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    expect(result.comparisonSet.rankedOffers).toHaveLength(1);
    expect(result.comparisonSet.rankedOffers[0]?.offer.cnyEstimate.amount).toBe("2093.00");
    expect(result.listings[0]?.originalMoney.evidence[0]?.jsonPath).toBe("$.data[0].price.amount");
    expect(result.markets).toEqual([
      expect.objectContaining({ market: "US", status: "COMPLETED" }),
      expect.objectContaining({ market: "SG", status: "FAILED" }),
    ]);
  });

  it("builds proof-backed Discovery candidates for an unregistered category", async () => {
    const openGoal: Goal = {
      query: "lightweight laptop",
      target: { categoryId: "laptop", targetText: "lightweight laptop", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" },
      markets: ["US"],
      budgetCny: null,
      stockPreference: "ANY",
      excludedOfferRefs: [],
      preferenceHints: [{ key: "portable", value: "lightweight", weight: 1 }],
    };
    const product = {
      id: "laptop-1",
      title: "Lightweight Laptop 14",
      price: { amount: "799", currency: "USD" },
      merchant: "Example",
      url: "https://merchant.us/laptop-1",
      country_code: "US",
      category_path: ["Computers", "Laptops"],
      metadata: { product_type: "Notebook Computer" },
    };
    const payload = { data: [product] };
    const campaign = await runResearchCampaign(openGoal, [openGoal.query], {
      search: async (_query, market) => ({ market, products: [product], artifactRef: "sha256:open", rawPayload: payload, observedAt: "2026-08-26T00:00:00.000Z" }),
    }, {
      getRate: async (base) => ({ id: "fx-open", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    const proof = buildResearchProofBundle({ comparisonSet: campaign.comparisonSet, artifacts: campaign.artifacts, coverage: campaign.coverage, workingSetVersion: 2, boundGoalVersion: 1 });
    expect(campaign.comparisonSet.qualifications[0]).toMatchObject({ status: "DISCOVERABLE", offer: { supportLevel: "DISCOVERY" } });
    expect(proof.workingSet.pool[0]).toMatchObject({
      title: "Lightweight Laptop 14",
      discovery: { supportLevel: "DISCOVERY", identityLevel: "OFFER_ONLY", identityKey: null },
    });
    expect(proof.claims.some((claim) => claim.kind === "PRICE")).toBe(true);
  });

  it("keeps a cheap foreign-domain result in the audit ledger but out of comparison", async () => {
    const productSource: ProductSearchPort = {
      search: async (_query, market) => ({
        market,
        products: [{
          id: "foreign",
          title: "Sony WH-1000XM5 Headphones",
          price: { amount: "69", currency: "USD" },
          merchant: "Foreign Merchant",
          url: "https://merchant.kw/sony",
          country_code: market,
          category_path: ["Portable Audio", "Headphones"],
        }],
        artifactRef: `sha256:${market}`,
        rawPayload: {},
        observedAt: "2026-08-26T00:00:00.000Z",
      }),
    };
    const result = await researchOffers({ ...goal, markets: ["SG"] }, goal.query, productSource, {
      getRate: async (base) => ({ id: "fx", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    expect(result.listings).toHaveLength(1);
    expect(result.comparisonSet.rankedOffers).toHaveLength(0);
    expect(result.comparisonSet.qualifications[0]).toMatchObject({ status: "INELIGIBLE", reasonCodes: ["MARKET_EVIDENCE_CONFLICT"] });
  });

  it("returns an explicit unavailable wave with per-market causes when every provider call fails", async () => {
    const result = await researchOffers(goal, goal.query, {
      search: async (_query, market) => { throw new Error(market === "US" ? "BUYWHERE_TIMEOUT" : "BUYWHERE_HTTP_503"); },
    }, {
      getRate: async () => { throw new Error("FX_MUST_NOT_RUN_WITHOUT_ARTIFACTS"); },
    });
    expect(result.availability).toBe("UNAVAILABLE");
    expect(result.artifacts).toEqual([]);
    expect(result.comparisonSet.rankedOffers).toEqual([]);
    expect(result.markets).toEqual([
      expect.objectContaining({ market: "US", status: "FAILED", errorCode: "BUYWHERE_TIMEOUT" }),
      expect.objectContaining({ market: "SG", status: "FAILED", errorCode: "BUYWHERE_HTTP_503" }),
    ]);
  });

  it("merges waves by stable listing identity and stops when a second wave adds no comparable offer", async () => {
    let calls = 0;
    const campaign = await runResearchCampaign({ ...goal, markets: ["US"] }, ["specific", "broader"], {
      search: async (_query, market) => {
        calls += 1;
        return {
          market,
          products: [{
            id: "same-offer",
            title: "Sony WH-1000XM5 Headphones",
            price: { amount: "299", currency: "USD" },
            merchant: "Example",
            url: "https://merchant.us/p1",
            country_code: "US",
            category_path: ["Portable Audio", "Headphones"],
          }],
          artifactRef: `sha256:wave-${calls}`,
          rawPayload: { data: [] },
          observedAt: `2026-08-26T00:00:0${calls}.000Z`,
        };
      },
    }, {
      getRate: async (base) => ({ id: `fx-${calls}`, base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    expect(campaign.waves).toHaveLength(2);
    expect(campaign.listings).toHaveLength(1);
    expect(campaign.coverage).toMatchObject({ comparableCount: 1, stopReason: "NO_NEW_COMPARABLES", adequate: true });
  });
});
