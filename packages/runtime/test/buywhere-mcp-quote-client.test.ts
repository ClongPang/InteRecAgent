import { describe, expect, it } from "vitest";

import {
  BuyWhereMcpQuoteClient,
  QUOTE_PROVIDER_CONTRACT_VERSION,
} from "../src/index.js";

const observedAt = "2026-09-01T03:00:00.000Z";

function mcpText(payload: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "request-1",
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch): BuyWhereMcpQuoteClient {
  return new BuyWhereMcpQuoteClient("test-key", {
    fetchImpl,
    now: () => new Date(observedAt),
    requestId: () => "request-1",
  });
}

describe("BuyWhereMcpQuoteClient", () => {
  it("calls only find_best_price_v2 with the adapter-owned SG scope", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let requestUrl: URL | null = null;
    const provider = client((async (input, init) => {
      requestUrl = new URL(String(input));
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mcpText({ data: [] });
    }) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: " Sony WH-1000XM5 " })).resolves.toMatchObject({ status: "OK_EMPTY" });
    expect(requestUrl?.pathname).toBe("/mcp");
    expect(requestBody).toMatchObject({
      method: "tools/call",
      params: {
        name: "find_best_price_v2",
        arguments: {
          product_name: "Sony WH-1000XM5",
          deliver_to: "SG",
        },
      },
    });
    expect(JSON.stringify(requestBody)).not.toMatch(/search_products|semantic|hybrid|mode|price_asc/u);
  });

  it("returns OK_RESULTS and preserves records, meta, artifact, and observation time", async () => {
    const provider = client((async () => mcpText({
      data: [{ id: "quote-1", title: "Sony WH-1000XM5", price: { amount: 215, currency: "USD" } }],
      meta: { status: "ok", confidence: "high", engine_status: "ok" },
    })) as typeof fetch);

    const result = await provider.lookup({ canonicalQuery: "Sony WH-1000XM5" });
    expect(result).toMatchObject({
      status: "OK_RESULTS",
      observedAt,
      providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
      failure: null,
      meta: { status: "ok", confidence: "high", engineStatus: "ok" },
    });
    expect(result.records).toHaveLength(1);
    expect(result.artifactRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.rawPayload).not.toBeNull();
  });

  it("returns OK_EMPTY only for a non-degraded empty envelope", async () => {
    const provider = client((async () => mcpText({
      data: [],
      meta: { status: "ok", emptiness_reason: "no_match", confidence: "high", engine_status: "ok" },
    })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Unknown Model X1" })).resolves.toMatchObject({
      status: "OK_EMPTY",
      records: [],
      failure: null,
      meta: { emptinessReason: "no_match" },
    });
  });

  it("parses the live find_best_price_v2 best_price and alternatives shape", async () => {
    const provider = client((async () => mcpText({
      best_price: { id: "best", price: { amount: 215, currency: "USD" } },
      alternatives: [{ id: "alternative", price: { amount: 220, currency: "USD" } }],
      meta: { status: "ok", degraded: false, diagnostic: { engine_status: "ok" } },
    })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "OK_RESULTS",
      records: [{ id: "best" }, { id: "alternative" }],
      meta: { engineStatus: "ok" },
    });
  });

  it("classifies a live-shape degraded empty response before treating it as no quote", async () => {
    const provider = client((async () => mcpText({
      best_price: null,
      alternatives: [],
      meta: {
        status: "degraded",
        degraded: true,
        degraded_kind: "timeout",
        emptiness_reason: "timeout",
        confidence: "low",
        diagnostic: { engine_status: "timeout", timed_out_stage: "fbp" },
      },
    })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "DEGRADED",
      records: [],
      meta: { engineStatus: "timeout" },
      failure: { code: "BUYWHERE_DEGRADED_TIMEOUT", retryable: true },
    });
  });

  it("returns DEGRADED for an HTTP 200 degraded envelope even when partial records exist", async () => {
    const provider = client((async () => mcpText({
      data: [{ id: "partial-1" }],
      meta: { status: "degraded", emptiness_reason: "timeout", confidence: "low", engine_status: "timeout" },
    })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "DEGRADED",
      records: [{ id: "partial-1" }],
      failure: { code: "BUYWHERE_DEGRADED_TIMEOUT", retryable: true },
    });
  });

  it("prioritizes DEGRADED over CONTRACT_DRIFT when a degraded envelope omits record arrays", async () => {
    const provider = client((async () => mcpText({
      meta: { status: "degraded", emptiness_reason: "timeout", diagnostic: { engine_status: "timeout" } },
    })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "DEGRADED",
      records: [],
      failure: { code: "BUYWHERE_DEGRADED_TIMEOUT", retryable: true },
    });
  });

  it("parses structuredContent without concatenating duplicate result arrays", async () => {
    const raw = {
      jsonrpc: "2.0",
      id: "request-1",
      result: {
        structuredContent: {
          data: [{ id: "data-record" }],
          products: [{ id: "duplicated-product-record" }],
          meta: { status: "ok" },
        },
      },
    };
    const provider = client((async () => new Response(JSON.stringify(raw), { status: 200 })) as typeof fetch);

    const result = await provider.lookup({ canonicalQuery: "Sony WH-1000XM5" });
    expect(result.status).toBe("OK_RESULTS");
    expect(result.records).toEqual([{ id: "data-record" }]);
  });

  it("turns JSON-RPC internal errors into retryable FAILED results", async () => {
    const provider = client((async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      error: { code: -32603, message: "internal error" },
    }), { status: 200 })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "FAILED",
      records: [],
      failure: { code: "BUYWHERE_MCP_-32603", retryable: true },
    });
  });

  it("classifies rate limiting separately and keeps the error artifact", async () => {
    const provider = client((async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })) as typeof fetch);

    const result = await provider.lookup({ canonicalQuery: "Sony WH-1000XM5" });
    expect(result).toMatchObject({
      status: "FAILED",
      failure: { code: "BUYWHERE_HTTP_429", retryable: true },
    });
    expect(result.artifactRef).toMatch(/^sha256:/u);
  });

  it("returns a retryable timeout failure without inventing an empty result", async () => {
    const provider = client((async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "FAILED",
      records: [],
      failure: { code: "BUYWHERE_TIMEOUT", retryable: true },
      artifactRef: null,
    });
  });

  it("preserves external cancellation instead of reporting a provider failure", async () => {
    const abort = new AbortController();
    abort.abort(new Error("RUN_DEADLINE_EXCEEDED"));
    const provider = client((async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" }, abort.signal)).rejects.toThrow("RUN_DEADLINE_EXCEEDED");
  });

  it("fails closed on CONTRACT_DRIFT when a successful payload has no recognized record array", async () => {
    const provider = client((async () => mcpText({ meta: { status: "ok" }, answer: "not a record array" })) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "Sony WH-1000XM5" })).resolves.toMatchObject({
      status: "FAILED",
      records: [],
      failure: { code: "BUYWHERE_CONTRACT_DRIFT", retryable: false },
    });
  });

  it("rejects an empty canonical query before any provider call", async () => {
    let called = false;
    const provider = client((async () => {
      called = true;
      return mcpText({ data: [] });
    }) as typeof fetch);

    await expect(provider.lookup({ canonicalQuery: "  " })).rejects.toThrow("QUOTE_QUERY_REQUIRED");
    expect(called).toBe(false);
  });
});
