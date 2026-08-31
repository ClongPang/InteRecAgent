import { createHash } from "node:crypto";
import net from "node:net";

import { canonicalDecimal } from "./money.js";
import { resolveProductIdentity } from "./product-identity.js";
import type { BuyWhereRawProduct, RetrievedListing, EvidenceRef, SourceValueStatus, SourcedValue, ListingIngestionContext, Money, StockStatus } from "./types.js";

const SUPPORTED_CURRENCIES = new Set(["USD", "SGD", "CNY"]);
const STOCK_TRUE = new Set(["in_stock", "available", "in stock", "yes"]);
const STOCK_FALSE = new Set(["out_of_stock", "unavailable", "out of stock", "no"]);
const BUYWHERE_REDIRECT_HOSTS = new Set(["buywhere.ai", "www.buywhere.ai", "api.buywhere.ai"]);

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

function evidence(context: ListingIngestionContext, jsonPath: string): EvidenceRef {
  const prefix = context.jsonPathPrefix?.trim();
  const qualifiedPath = prefix ? `${prefix}${jsonPath.slice(1)}` : jsonPath;
  return { artifactRef: context.rawArtifactRef, jsonPath: qualifiedPath, source: "buywhere", observedAt: context.observedAt };
}

function sourcedValue<T>(value: T | null, status: SourceValueStatus, refs: EvidenceRef[]): SourcedValue<T> {
  return { value, status: value === null ? "UNKNOWN" : status, evidence: refs };
}

export function validatedWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || net.isIP(host) !== 0) return null;
    return url;
  } catch {
    return null;
  }
}

function merchantUrls(raw: BuyWhereRawProduct): { target: URL; outbound: URL; targetStatus: "OBSERVED" | "DERIVED"; targetPath: string } | null {
  const rawTarget = safeString(raw.url);
  const rawClick = safeString(raw.click_url);
  const direct = rawTarget ? validatedWebUrl(rawTarget) : null;
  const click = rawClick ? validatedWebUrl(rawClick) : null;
  if (direct && !BUYWHERE_REDIRECT_HOSTS.has(direct.hostname.toLocaleLowerCase("en-US"))) {
    if (!click) return rawClick ? null : { target: direct, outbound: direct, targetStatus: "OBSERVED", targetPath: "$.url" };
    if (!BUYWHERE_REDIRECT_HOSTS.has(click.hostname.toLocaleLowerCase("en-US"))) return null;
    const nested = click.searchParams.get("url");
    const attributedTarget = nested ? validatedWebUrl(nested) : null;
    if (!attributedTarget || attributedTarget.toString() !== direct.toString()) return null;
    return { target: direct, outbound: click, targetStatus: "OBSERVED", targetPath: "$.url" };
  }
  const redirect = click ?? direct;
  if (!redirect || !BUYWHERE_REDIRECT_HOSTS.has(redirect.hostname.toLocaleLowerCase("en-US"))) return null;
  const nested = redirect.searchParams.get("url");
  const target = nested ? validatedWebUrl(nested) : null;
  return target ? { target, outbound: redirect, targetStatus: "DERIVED", targetPath: "$.click_url" } : null;
}

function stockSignal(value: unknown): StockStatus | null {
  if (typeof value === "boolean") return value ? "IN_STOCK" : "OUT_OF_STOCK";
  if (typeof value === "string") {
    const normalized = value.trim().toLocaleLowerCase("en-US");
    if (STOCK_TRUE.has(normalized)) return "IN_STOCK";
    if (STOCK_FALSE.has(normalized)) return "OUT_OF_STOCK";
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return stockSignal(record["in_stock"]) ?? stockSignal(record["status"]);
  }
  return null;
}

function normalizeStock(raw: BuyWhereRawProduct, context: ListingIngestionContext): SourcedValue<StockStatus> {
  const top = stockSignal(raw.availability);
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata as Record<string, unknown> : null;
  const meta = metadata ? stockSignal(metadata["availability"]) ?? stockSignal(metadata["in_stock"]) : null;
  const refs = [evidence(context, "$.availability"), evidence(context, "$.metadata.availability")];
  if (top && meta && top !== meta) return sourcedValue("UNKNOWN", "CONFLICTED", refs);
  const resolved = top ?? meta;
  return resolved ? sourcedValue(resolved, "OBSERVED", refs) : sourcedValue("UNKNOWN", "UNKNOWN", refs);
}

function normalizeMoney(raw: BuyWhereRawProduct, context: ListingIngestionContext): SourcedValue<Money> | null {
  if (!raw.price || typeof raw.price !== "object") return null;
  const currency = safeString(raw.price.currency)?.toUpperCase() ?? null;
  const rawAmount = raw.price.amount;
  if (!currency || !SUPPORTED_CURRENCIES.has(currency) || (typeof rawAmount !== "string" && typeof rawAmount !== "number")) return null;
  try {
    return sourcedValue({ amount: canonicalDecimal(String(rawAmount)), currency }, "OBSERVED", [evidence(context, "$.price.amount"), evidence(context, "$.price.currency")]);
  } catch {
    return null;
  }
}

export function ingestBuyWhereListing(raw: BuyWhereRawProduct, context: ListingIngestionContext): RetrievedListing | null {
  const providerListingId = safeString(raw.id);
  const title = safeString(raw.title);
  const merchant = safeString(raw.merchant);
  const urls = merchantUrls(raw);
  const money = normalizeMoney(raw, context);
  if (!providerListingId || !title || !merchant || !urls || !money) return null;
  const categoryPath = safeStringArray(raw.category_path);
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata as Record<string, unknown> : null;
  const productType = safeString(metadata?.["product_type"]);
  const identityEvidence = [evidence(context, "$.title"), evidence(context, "$.category_path"), evidence(context, "$.metadata.product_type")];
  const identity = resolveProductIdentity(title, [...categoryPath, productType].filter(Boolean).join(" "), context.target, identityEvidence);
  const listingRef = createHash("sha256").update(`buywhere\u0000${context.retrievalMarket}\u0000${providerListingId}`).digest("hex").slice(0, 24);
  const targetEvidence = evidence(context, urls.targetPath);
  return {
    listingRef,
    provider: "buywhere",
    providerListingId,
    retrievalMarket: context.retrievalMarket,
    title: sourcedValue(title, "OBSERVED", [evidence(context, "$.title")]),
    originalMoney: money,
    merchantLabel: sourcedValue(merchant, "OBSERVED", [evidence(context, "$.merchant")]),
    merchantTargetUrl: sourcedValue(urls.target.toString(), urls.targetStatus, [targetEvidence]),
    merchantDomain: sourcedValue(urls.target.hostname.toLocaleLowerCase("en-US"), urls.targetStatus, [targetEvidence]),
    outboundUrl: sourcedValue(urls.outbound.toString(), "OBSERVED", [evidence(context, raw.click_url ? "$.click_url" : "$.url")]),
    providerCountry: sourcedValue(safeString(raw.country_code), "OBSERVED", [evidence(context, "$.country_code")]),
    categoryPath: sourcedValue(categoryPath, "OBSERVED", [evidence(context, "$.category_path")]),
    providerProductType: sourcedValue(productType, "OBSERVED", [evidence(context, "$.metadata.product_type")]),
    stock: normalizeStock(raw, context),
    identity,
    imageUrl: sourcedValue(safeString(raw.image_url), "OBSERVED", [evidence(context, "$.image_url")]),
    sourceUpdatedAt: sourcedValue(safeString(raw.updated_at), "OBSERVED", [evidence(context, "$.updated_at")]),
    observedAt: context.observedAt,
    rawArtifactRef: context.rawArtifactRef,
  };
}
