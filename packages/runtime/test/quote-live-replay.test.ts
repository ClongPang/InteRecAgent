import { readFile } from "node:fs/promises";

import { resolveQuoteTarget } from "@retail-price/domain";
import { describe, expect, it } from "vitest";

import {
  QuoteLookupService,
  parseBuyWhereMcpToolResponse,
  type QuoteProvider,
} from "../src/index.js";

interface CapturedFixture {
  fixtureVersion: number;
  captureKind: string;
  canonicalQuery: string;
  serviceMarket: string;
  providerStatus: string;
  providerContractVersion: string;
  sourceArtifactRef: string;
  sourceObservedAt: string;
  sanitization: string;
  records: Record<string, unknown>[];
}

async function fixture(): Promise<CapturedFixture> {
  return JSON.parse(await readFile(new URL("./fixtures/buywhere-wh1000xm5-2026-09-01.json", import.meta.url), "utf8")) as CapturedFixture;
}

describe("sanitized live BuyWhere quote replay", () => {
  it("retains nine real observations while publishing one refurbished merchant-page lead", async () => {
    const captured = await fixture();
    expect(captured).toMatchObject({
      fixtureVersion: 1,
      captureKind: "SANITIZED_LIVE_BUYWHERE_MCP_V2",
      canonicalQuery: "Sony WH-1000XM5 headphones",
      serviceMarket: "SG",
      providerStatus: "OK_RESULTS",
      providerContractVersion: "buywhere-mcp-v2-quote-records-v1",
    });
    expect(captured.sourceArtifactRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(captured.sanitization).toContain("tracking parameters");

    const payload = { best_price: captured.records[0], alternatives: captured.records.slice(1), meta: { status: "ok" } };
    const rawEnvelope = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    };
    const providerResult = parseBuyWhereMcpToolResponse(rawEnvelope, captured.sourceObservedAt);
    const provider: QuoteProvider = { lookup: async () => providerResult };
    const target = resolveQuoteTarget({
      rawText: "Sony WH-1000XM5 refurbished headphones quote",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      productType: "headphones",
      conditionPreference: "REFURBISHED",
    });
    const execution = await new QuoteLookupService(provider).lookup(target);
    expect(execution.status).toBe("LOOKUP_COMPLETED");
    if (execution.status !== "LOOKUP_COMPLETED") throw new Error("fixture target did not resolve");
    expect(execution.leadSet).toMatchObject({
      outcome: "QUOTE_LEADS",
      observations: new Array(9).fill(expect.any(Object)),
      admissions: new Array(9).fill(expect.objectContaining({ status: "ELIGIBLE" })),
      leads: [{
        condition: "REFURBISHED",
        merchantDomain: "joesge.myshopify.com",
        observationCount: 9,
        priceRanges: [{ currency: "USD", minAmount: "215", maxAmount: "249.99", cnyEstimate: null }],
        disclosureCode: "MERCHANT_PAGE_CHECK_REQUIRED",
      }],
    });
  });

  it("does not assume a new-product condition when the user did not request one", async () => {
    const captured = await fixture();
    const payload = { best_price: captured.records[0], alternatives: captured.records.slice(1), meta: { status: "ok" } };
    const providerResult = parseBuyWhereMcpToolResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    }, captured.sourceObservedAt);
    const target = resolveQuoteTarget({
      rawText: "Sony WH-1000XM5 headphones quote",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      productType: "headphones",
    });
    const execution = await new QuoteLookupService({ lookup: async () => providerResult }).lookup(target);
    if (execution.status !== "LOOKUP_COMPLETED") throw new Error("fixture target did not resolve");
    expect(execution.leadSet.target.conditionPreference).toBe("ANY");
    expect(execution.leadSet.leads[0]?.condition).toBe("REFURBISHED");
  });
});
