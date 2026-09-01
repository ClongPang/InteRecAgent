import { describe, expect, it, vi } from "vitest";

import { FxRatesClient } from "../src/fx-provider.js";

describe("FxRatesClient", () => {
  it("returns a bounded identity snapshot for CNY without a network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await new FxRatesClient(fetchImpl).getRate("cny");
    expect(result).toMatchObject({ base: "CNY", quote: "CNY", rate: "1", provider: "identity" });
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.parse(result.observedAt));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses a positive CNY rate and rejects missing rate evidence", async () => {
    const okFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      date: "2026-09-01T00:00:00.000Z",
      rates: { CNY: 7.21 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(new FxRatesClient(okFetch).getRate("USD")).resolves.toMatchObject({
      base: "USD",
      quote: "CNY",
      rate: "7.21",
      provider: "fxratesapi",
      observedAt: "2026-09-01T00:00:00.000Z",
    });

    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ rates: {} }), { status: 200 }));
    await expect(new FxRatesClient(invalidFetch).getRate("SGD")).rejects.toThrow("FX_CONTRACT_DRIFT");
  });
});
