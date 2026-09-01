import { createHash } from "node:crypto";

import { canonicalDecimal, compareDecimal } from "./money.js";
import { resolveOfferIdentity } from "./offer-identity.js";
import type { ProductIdentitySnapshot } from "./product-identity.js";
import {
  QUOTE_ADMISSION_POLICY_VERSION,
  type QuoteAdmissionDecision,
  type QuoteObservation,
  type QuoteTarget,
} from "./quote-types.js";
import type { Money, ProductCondition } from "./quote-base-types.js";
import { validatedQuoteWebUrl } from "./quote-url.js";

const REFURBISHED_SIGNAL = /\b(?:refurbished|renewed|reconditioned|certified\s+refurbished|outlet\s+grade)\b|翻新|官翻/iu;
const USED_SIGNAL = /\b(?:pre[\s-]?owned|second[\s-]?hand|used)\b|二手|中古/iu;
const NEW_SIGNAL = /\b(?:brand[\s-]?new|new|sealed)\b|全新|未拆封/iu;

function text(value: unknown): string | null {
  return typeof value === "string" && value.normalize("NFKC").trim()
    ? value.normalize("NFKC").trim()
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function timestamp(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function money(value: unknown): Money | null {
  const source = record(value);
  const rawAmount = source["amount"];
  const rawCurrency = text(source["currency"]);
  if ((typeof rawAmount !== "string" && typeof rawAmount !== "number") || !rawCurrency) return null;
  const currency = rawCurrency.toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) return null;
  try {
    const amount = canonicalDecimal(String(rawAmount));
    return compareDecimal(amount, "0") > 0 ? { amount, currency } : null;
  } catch {
    return null;
  }
}

function conditionFrom(raw: Record<string, unknown>, title: string | null): ProductCondition {
  const explicit = text(raw["condition"] ?? record(raw["metadata"])["condition"])?.toLocaleLowerCase("en-US");
  const combined = `${explicit ?? ""} ${title ?? ""}`;
  if (REFURBISHED_SIGNAL.test(combined)) return "REFURBISHED";
  if (USED_SIGNAL.test(combined)) return "USED";
  if (NEW_SIGNAL.test(combined)) return "NEW";
  return "UNKNOWN";
}

function safeUrl(value: unknown): string | null {
  const candidate = text(value);
  return candidate ? validatedQuoteWebUrl(candidate)?.toString() ?? null : null;
}

function cloneUnknown(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value);
}

function identitySignals(raw: Record<string, unknown>): QuoteObservation["identitySignals"] {
  const metadata = record(raw["metadata"]);
  const identifiers = record(raw["identifiers"]);
  const first = (values: Array<[unknown, string]>): { value: string; jsonPath: string } | null => {
    for (const [value, jsonPath] of values) {
      const normalized = text(value);
      if (normalized) return { value: normalized, jsonPath };
    }
    return null;
  };
  const values: QuoteObservation["identitySignals"]["identifiers"] = [];
  const append = (scheme: "GTIN" | "BRAND_MPN", candidates: Array<[unknown, string]>): void => {
    for (const [value, jsonPath] of candidates) {
      const normalized = text(value);
      if (normalized) values.push({ scheme, value: normalized, jsonPath });
    }
  };
  append("GTIN", [
    [raw["gtin"], "$.gtin"], [raw["ean"], "$.ean"], [raw["upc"], "$.upc"],
    [metadata["gtin"], "$.metadata.gtin"], [identifiers["gtin"], "$.identifiers.gtin"],
  ]);
  append("BRAND_MPN", [
    [raw["mpn"], "$.mpn"], [raw["manufacturer_part_number"], "$.manufacturer_part_number"],
    [raw["model_number"], "$.model_number"], [metadata["mpn"], "$.metadata.mpn"], [identifiers["mpn"], "$.identifiers.mpn"],
  ]);
  const deduplicated = [...new Map(values.map((value) => [`${value.scheme}:${value.value}:${value.jsonPath}`, value])).values()];
  return {
    brand: first([[raw["brand"], "$.brand"], [raw["manufacturer"], "$.manufacturer"], [metadata["brand"], "$.metadata.brand"]]),
    model: first([[raw["model"], "$.model"], [raw["model_number"], "$.model_number"], [metadata["model"], "$.metadata.model"]]),
    identifiers: deduplicated,
  };
}

export function createQuoteObservation(input: {
  rawRecord: Record<string, unknown>;
  recordIndex: number;
  artifactRef: string;
  observedAt: string;
}): QuoteObservation {
  const rawRecord = structuredClone(input.rawRecord);
  const providerRecordId = text(rawRecord["id"]);
  const title = text(rawRecord["title"]);
  const targetUrl = safeUrl(rawRecord["url"] ?? rawRecord["merchant_url"]);
  const target = targetUrl ? new URL(targetUrl) : null;
  const outboundUrl = safeUrl(rawRecord["outbound_url"] ?? rawRecord["click_url"]) ?? targetUrl;
  const jsonPath = `$.records[${input.recordIndex}]`;
  const observationRef = `qo_${createHash("sha256")
    .update(`${input.artifactRef}\u0000${input.recordIndex}\u0000${providerRecordId ?? ""}`)
    .digest("hex").slice(0, 24)}`;
  return {
    observationRef,
    provider: "buywhere",
    providerRecordId,
    recordIndex: input.recordIndex,
    jsonPath,
    artifactRef: input.artifactRef,
    observedAt: new Date(input.observedAt).toISOString(),
    title,
    originalMoney: money(rawRecord["price"]),
    merchantLabel: text(rawRecord["merchant"]),
    merchantTargetUrl: targetUrl,
    merchantDomain: target?.hostname.toLocaleLowerCase("en-US") ?? null,
    outboundUrl,
    imageUrl: safeUrl(rawRecord["image_url"]),
    providerCountry: text(rawRecord["country_code"]),
    providerUpdatedAt: timestamp(rawRecord["updated_at"]),
    providerAvailability: cloneUnknown(rawRecord["availability"]),
    condition: conditionFrom(rawRecord, title),
    identitySignals: identitySignals(rawRecord),
    rawRecord,
  };
}

function conditionMatches(target: QuoteTarget, observed: ProductCondition): boolean {
  switch (target.conditionPreference) {
    case "ANY": return true;
    case "NEW": return observed === "NEW";
    case "NEW_OR_UNSPECIFIED": return observed === "NEW" || observed === "UNKNOWN";
    case "REFURBISHED": return observed === "REFURBISHED";
    case "USED": return observed === "USED";
  }
}

export function admitQuoteObservation(
  observation: QuoteObservation,
  target: QuoteTarget,
  identitySnapshot?: ProductIdentitySnapshot,
): QuoteAdmissionDecision {
  const insufficient: string[] = [];
  const rejected: string[] = [];
  if (!observation.title) insufficient.push("TITLE_MISSING");
  if (!observation.originalMoney) insufficient.push("ORIGINAL_PRICE_MISSING_OR_INVALID");
  if (!observation.merchantTargetUrl || !observation.merchantDomain) insufficient.push("MERCHANT_TARGET_URL_MISSING_OR_UNSAFE");
  if (!observation.outboundUrl) insufficient.push("OUTBOUND_URL_MISSING_OR_UNSAFE");

  const identity = resolveOfferIdentity(observation, target, identitySnapshot);
  if (identity.strength === "IDENTITY_OR_ROLE_CONFLICT") rejected.push(...identity.reasonCodes);
  else if (!identity.publishable) insufficient.push(...identity.reasonCodes);
  if (!conditionMatches(target, observation.condition)) rejected.push("CONDITION_MISMATCH");

  return {
    observationRef: observation.observationRef,
    status: rejected.length > 0 ? "REJECTED" : insufficient.length > 0 ? "INSUFFICIENT_EVIDENCE" : "ELIGIBLE",
    reasonCodes: [...new Set([...rejected, ...insufficient])],
    policyVersion: QUOTE_ADMISSION_POLICY_VERSION,
    identityStrength: identity.strength,
    identityEvidenceRefs: [...identity.evidenceRefs],
  };
}
