import { createHash } from "node:crypto";

import { normalizeMerchantTargetUrl, validatedQuoteWebUrl } from "../packages/domain/src/index.js";
import { BuyWhereMcpQuoteClient } from "../packages/runtime/src/buywhere-mcp-quote-client.js";
import { retailPriceEnvironmentValue } from "../packages/runtime/src/environment.js";
import { resolveBuyWhereRuntimeConfig } from "../packages/runtime/src/runtime-config.js";

if (retailPriceEnvironmentValue(process.env, "QUOTE_LIVE_CONFIRM") !== "authorized-buywhere-read") {
  throw new Error("RETAIL_PRICE_QUOTE_LIVE_CONFIRM_MUST_BE_authorized-buywhere-read");
}

const config = resolveBuyWhereRuntimeConfig();
const canonicalQuery = (retailPriceEnvironmentValue(process.env, "QUOTE_PROBE_MODEL") ?? "Sony WH-1000XM5").normalize("NFKC").trim();
if (!canonicalQuery) throw new Error("RETAIL_PRICE_QUOTE_PROBE_MODEL_REQUIRED");

const result = await new BuyWhereMcpQuoteClient(config.apiKey, { timeoutMs: config.timeoutMs }).lookup({ canonicalQuery });

function payloadShape(value: unknown, depth = 0): unknown {
  if (depth >= 5) return Array.isArray(value) ? `array(${value.length})` : typeof value;
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, first: value.length > 0 ? payloadShape(value[0], depth + 1) : null };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, payloadShape(child, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

function parsedTextPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = (value as Record<string, unknown>)["result"];
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const content = (result as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const blockText = (block as Record<string, unknown>)["text"];
    if (typeof blockText !== "string") continue;
    try {
      return JSON.parse(blockText) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

function sanitizedRecord(value: Record<string, unknown>, index: number): Record<string, unknown> {
  const safeText = (candidate: unknown): string | null => typeof candidate === "string" && candidate.trim() ? candidate.trim().slice(0, 300) : null;
  const rawUrl = safeText(value["url"] ?? value["merchant_url"]);
  const safeTarget = rawUrl && validatedQuoteWebUrl(rawUrl) ? normalizeMerchantTargetUrl(rawUrl) : null;
  const price = value["price"] && typeof value["price"] === "object" && !Array.isArray(value["price"])
    ? value["price"] as Record<string, unknown>
    : null;
  return {
    id: `captured-${createHash("sha256").update(`${result.artifactRef ?? "none"}:${index}`).digest("hex").slice(0, 12)}`,
    title: safeText(value["title"]),
    price: price ? { amount: price["amount"] ?? null, currency: safeText(price["currency"]) } : null,
    merchant: safeText(value["merchant"]),
    url: safeTarget,
    outbound_url: safeTarget,
    country_code: safeText(value["country_code"]),
    updated_at: safeText(value["updated_at"]),
    condition: safeText(value["condition"]),
  };
}

process.stdout.write(`${JSON.stringify({
  probe: "buywhere-mcp-v2-quote-provider",
  canonicalQuery,
  serviceMarket: "SG",
  providerStatus: result.status,
  recordCount: result.records.length,
  meta: {
    status: result.meta.status,
    emptinessReason: result.meta.emptinessReason,
    confidence: result.meta.confidence,
    engineStatus: result.meta.engineStatus,
  },
  failure: result.failure,
  providerContractVersion: result.providerContractVersion,
  artifactRef: result.artifactRef,
  observedAt: result.observedAt,
  ...(retailPriceEnvironmentValue(process.env, "QUOTE_PROBE_INCLUDE_SHAPE") === "1"
    ? {
        payloadShape: payloadShape(result.rawPayload),
        parsedTextPayloadShape: payloadShape(parsedTextPayload(result.rawPayload)),
      }
    : {}),
  ...(retailPriceEnvironmentValue(process.env, "QUOTE_PROBE_INCLUDE_SANITIZED_RECORDS") === "1"
    ? {
        sanitization: "selected commerce fields; provider ids hashed; tracking and outbound redirects removed",
        records: result.records.map(sanitizedRecord),
      }
    : {}),
})}\n`);
