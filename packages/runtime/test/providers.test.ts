import { describe, expect, it } from "vitest";

import { resolveProductTarget, type SearchGoalSnapshot } from "@interec/domain";

import { buildSearchProvenanceBundle, BuyWhereClient, FxRatesClient, searchOffers, runOfferSearchBatch, resolveBuyWhereRuntimeConfig, resolveBuyWhereTimeoutMs, type ProductSearchPort, type SemanticRelevancePort } from "../src/index.js";

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

describe("evidence-gated cross-market offer search", () => {
  const goal: SearchGoalSnapshot = {
    query: "Sony WH-1000XM5 headphones",
    target: resolveProductTarget("Sony WH-1000XM5 headphones"),
    markets: ["US", "SG"],
    budgetCny: "2500",
    stockPreference: "ANY",
    excludedOfferRefs: [],
  };

  it("degrades one failed market and promotes only source-grounded results", async () => {
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
    const result = await searchOffers(goal, goal.query, productSource, {
      getRate: async (base) => ({ id: "fx", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    expect(result.rankedOfferSet.rankedOffers).toHaveLength(1);
    expect(result.rankedOfferSet.rankedOffers[0]?.offer.cnyEstimate.amount).toBe("2093.00");
    expect(result.listings[0]?.originalMoney.evidence[0]?.jsonPath).toBe("$.data[0].price.amount");
    expect(result.markets).toEqual([
      expect.objectContaining({ market: "US", status: "COMPLETED" }),
      expect.objectContaining({ market: "SG", status: "FAILED" }),
    ]);
  });

  it("builds source-grounded search-only candidates for an unregistered category", async () => {
    const openGoal: SearchGoalSnapshot = {
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
    const batch = await runOfferSearchBatch(openGoal, [openGoal.query], {
      search: async (_query, market) => ({ market, products: [product], artifactRef: "sha256:open", rawPayload: payload, observedAt: "2026-08-26T00:00:00.000Z" }),
    }, {
      getRate: async (base) => ({ id: "fx-open", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    const provenance = buildSearchProvenanceBundle({ rankedOfferSet: batch.rankedOfferSet, artifacts: batch.artifacts, coverage: batch.coverage, workingSetVersion: 2, boundGoalVersion: 1 });
    expect(batch.rankedOfferSet.eligibilityResults[0]).toMatchObject({ status: "DISCOVERABLE", offer: { validationMode: "SEARCH_ONLY" } });
    expect(provenance.workingSet.pool[0]).toMatchObject({
      title: "Lightweight Laptop 14",
      ranking: { validationMode: "SEARCH_ONLY", identityResolution: "LISTING_LEVEL", identityKey: null },
    });
    expect(provenance.claims.some((claim) => claim.kind === "PRICE")).toBe(true);
  });

  it("uses governed semantic corroboration for broad provider taxonomy and keeps related products out of main ranking", async () => {
    const categoryGoal: SearchGoalSnapshot = {
      query: "headphones",
      target: { categoryId: "headphones", targetText: "headphones", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" },
      markets: ["US"],
      budgetCny: null,
      stockPreference: "ANY",
      excludedOfferRefs: [],
    };
    const semanticRelevance: SemanticRelevancePort = {
      classify: async (_goal, listings) => new Map(listings.map((listing) => [listing.listingRef, {
        label: listing.title.value?.includes("Amplifier") ? "COMPLEMENT" as const : "EXACT" as const,
        confidence: 0.98,
        modelId: "semantic-test",
      }])),
    };
    const products = [{
      id: "primary",
      title: "Planar Magnetic Headphones",
      price: { amount: "299", currency: "USD" },
      merchant: "Example",
      url: "https://merchant.us/primary",
      country_code: "US",
      category_path: ["electronics"],
    }, {
      id: "related",
      title: "Desktop DAC Headphone Amplifier",
      price: { amount: "199", currency: "USD" },
      merchant: "Example",
      url: "https://merchant.us/related",
      country_code: "US",
      category_path: ["electronics"],
    }];
    const result = await searchOffers(categoryGoal, categoryGoal.query, {
      search: async (_query, market) => ({ market, products, artifactRef: "sha256:semantic", rawPayload: { data: products }, observedAt: "2026-08-26T00:00:00.000Z" }),
    }, {
      getRate: async (base) => ({ id: "fx-semantic", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    }, undefined, semanticRelevance);

    expect(result.rankedOfferSet.rankedOffers.map((item) => item.offer.title)).toEqual(["Planar Magnetic Headphones"]);
    expect(result.rankedOfferSet.eligibilityResults.map((item) => item.queryProductRelevance.label)).toEqual(["EXACT", "COMPLEMENT"]);
    expect(result.rankedOfferSet.eligibilityResults[1]).toMatchObject({ status: "INELIGIBLE", candidateAdmission: { cohort: "RELATED_COHORT" } });
  });

  it("retries a transient semantic-evidence failure before failing closed", async () => {
    const categoryGoal: SearchGoalSnapshot = {
      query: "washing machine",
      target: { categoryId: "washing_machine", targetText: "前置式洗衣机", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", conditionPreference: "ANY" },
      markets: ["SG"],
      budgetCny: null,
      stockPreference: "ANY",
      excludedOfferRefs: [],
    };
    const product = {
      id: "washer",
      title: "Front Load Washing Machine 10kg",
      price: { amount: "799", currency: "SGD" },
      merchant: "Example",
      url: "https://merchant.sg/washer",
      country_code: "SG",
      category_path: ["Home Appliances", "Washing Machines"],
      metadata: { product_type: "Front Load Washer" },
    };
    let semanticCalls = 0;
    const result = await searchOffers(categoryGoal, categoryGoal.query, {
      search: async (_query, market) => ({ market, products: [product], artifactRef: "sha256:washer", rawPayload: { data: [product] }, observedAt: "2026-08-26T00:00:00.000Z" }),
    }, {
      getRate: async (base) => ({ id: "fx-washer", base, quote: "CNY", rate: "5.4", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    }, undefined, {
      classify: async (_goal, listings) => {
        semanticCalls += 1;
        if (semanticCalls === 1) throw new Error("MODEL_PROVIDER_TEMPORARY");
        return new Map(listings.map((listing) => [listing.listingRef, { label: "EXACT" as const, confidence: 0.99, modelId: "semantic-test" }]));
      },
    });

    expect(result.semanticEvaluation).toEqual({ outcome: "SUCCEEDED", attempts: 2, failureCode: null });
    expect(result.rankedOfferSet.eligibilityResults[0]?.queryProductRelevance.label).toBe("EXACT");
  });

  it("exposes semantic-evidence unavailability after the bounded retry budget", async () => {
    const result = await searchOffers({ ...goal, markets: ["US"] }, goal.query, {
      search: async (_query, market) => ({
        market,
        products: [{
          id: "semantic-unavailable",
          title: "Sony WH-1000XM5 Headphones",
          price: { amount: "299", currency: "USD" },
          merchant: "Example",
          url: "https://merchant.us/semantic-unavailable",
          country_code: "US",
          category_path: ["Portable Audio", "Headphones"],
        }],
        artifactRef: "sha256:semantic-unavailable",
        rawPayload: {},
        observedAt: "2026-08-26T00:00:00.000Z",
      }),
    }, {
      getRate: async (base) => ({ id: "fx-unavailable", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    }, undefined, {
      classify: async () => { throw new Error("SEMANTIC_RELEVANCE_JSON_REQUIRED"); },
    });

    expect(result.semanticEvaluation).toEqual({ outcome: "FAILED", attempts: 2, failureCode: "PROTOCOL_INVALID" });
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
    const result = await searchOffers({ ...goal, markets: ["SG"] }, goal.query, productSource, {
      getRate: async (base) => ({ id: "fx", base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    expect(result.listings).toHaveLength(1);
    expect(result.rankedOfferSet.rankedOffers).toHaveLength(0);
    expect(result.rankedOfferSet.eligibilityResults[0]).toMatchObject({ status: "INELIGIBLE", reasonCodes: ["MARKET_EVIDENCE_CONFLICT"] });
  });

  it("returns an explicit unavailable attempt with per-market causes when every provider call fails", async () => {
    const result = await searchOffers(goal, goal.query, {
      search: async (_query, market) => { throw new Error(market === "US" ? "BUYWHERE_TIMEOUT" : "BUYWHERE_HTTP_503"); },
    }, {
      getRate: async () => { throw new Error("FX_MUST_NOT_RUN_WITHOUT_ARTIFACTS"); },
    });
    expect(result.availability).toBe("UNAVAILABLE");
    expect(result.artifacts).toEqual([]);
    expect(result.rankedOfferSet.rankedOffers).toEqual([]);
    expect(result.markets).toEqual([
      expect.objectContaining({ market: "US", status: "FAILED", errorCode: "BUYWHERE_TIMEOUT" }),
      expect.objectContaining({ market: "SG", status: "FAILED", errorCode: "BUYWHERE_HTTP_503" }),
    ]);
  });

  it("merges attempts by stable listing identity and stops when a second attempt adds no comparable offer", async () => {
    let calls = 0;
    const batch = await runOfferSearchBatch({ ...goal, markets: ["US"] }, ["specific", "broader"], {
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
          artifactRef: `sha256:attempt-${calls}`,
          rawPayload: { data: [] },
          observedAt: `2026-08-26T00:00:0${calls}.000Z`,
        };
      },
    }, {
      getRate: async (base) => ({ id: `fx-${calls}`, base, quote: "CNY", rate: "7", provider: "test", observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z" }),
    });
    expect(batch.attempts).toHaveLength(2);
    expect(batch.listings).toHaveLength(1);
    expect(batch.coverage).toMatchObject({ comparableCount: 1, stopReason: "NO_NEW_COMPARABLES", adequate: true });
  });
});
