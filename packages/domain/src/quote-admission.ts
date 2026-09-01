import { createHash } from "node:crypto";

import { canonicalDecimal, compareDecimal } from "./money.js";
import { quoteIdentityKey } from "./quote-target.js";
import {
  QUOTE_ADMISSION_POLICY_VERSION,
  type QuoteAdmissionDecision,
  type QuoteObservation,
  type QuoteTarget,
} from "./quote-types.js";
import type { Money, ProductCondition } from "./quote-base-types.js";
import { validatedQuoteWebUrl } from "./quote-url.js";

const ACCESSORY_SIGNAL = /\b(?:accessor(?:y|ies)|case|cover|protector|cable|charger|charging|ear[\s-]?pads?|ear[\s-]?cushions?|stand|holder|mount|adapter|sleeve|skin|compatible\s+with|designed\s+for)\b|配件|保护壳|保护套|耳罩|耳垫|充电线|数据线|支架|适用于|兼容/iu;
const SERVICE_SIGNAL = /\b(?:repair|service|display\s+service|installation|warranty|maintenance)\b|维修|服务|安装|保修/iu;
const REPLACEMENT_SIGNAL = /\b(?:replacement|spare\s+part|parts?\s+only|screen\s+replacement)\b|替换|更换|备件|零件/iu;
const REFURBISHED_SIGNAL = /\b(?:refurbished|renewed|reconditioned|certified\s+refurbished|outlet\s+grade)\b|翻新|官翻/iu;
const USED_SIGNAL = /\b(?:pre[\s-]?owned|second[\s-]?hand|used)\b|二手|中古/iu;
const NEW_SIGNAL = /\b(?:brand[\s-]?new|new|sealed)\b|全新|未拆封/iu;

function text(value: unknown): string | null {
  return typeof value === "string" && value.normalize("NFKC").trim()
    ? value.normalize("NFKC").trim()
    : null;
}

function timestamp(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function money(value: unknown): Money | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawAmount = record["amount"];
  const rawCurrency = text(record["currency"]);
  if ((typeof rawAmount !== "string" && typeof rawAmount !== "number") || !rawCurrency) return null;
  const currency = rawCurrency.toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) return null;
  try {
    const amount = canonicalDecimal(String(rawAmount));
    if (compareDecimal(amount, "0") <= 0) return null;
    return { amount, currency };
  } catch {
    return null;
  }
}

function conditionFrom(raw: Record<string, unknown>, title: string | null): ProductCondition {
  const explicit = text(raw["condition"] ?? (raw["metadata"] as Record<string, unknown> | undefined)?.["condition"])?.toLocaleLowerCase("en-US");
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
    rawRecord,
  };
}

function containsExactIdentity(value: string, identity: string): boolean {
  const wanted = quoteIdentityKey(identity);
  if (!wanted) return false;
  const tokens = value.normalize("NFKC").toLocaleUpperCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let index = start; index < tokens.length && joined.length <= wanted.length; index += 1) {
      joined += tokens[index]!;
      if (joined === wanted) return true;
    }
  }
  return false;
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

export function admitQuoteObservation(observation: QuoteObservation, target: QuoteTarget): QuoteAdmissionDecision {
  const insufficient: string[] = [];
  const rejected: string[] = [];
  if (!observation.title) insufficient.push("TITLE_MISSING");
  if (!observation.originalMoney) insufficient.push("ORIGINAL_PRICE_MISSING_OR_INVALID");
  if (!observation.merchantTargetUrl || !observation.merchantDomain) insufficient.push("MERCHANT_TARGET_URL_MISSING_OR_UNSAFE");
  if (!observation.outboundUrl) insufficient.push("OUTBOUND_URL_MISSING_OR_UNSAFE");

  const title = observation.title ?? "";
  if (title && !containsExactIdentity(title, target.canonicalModel)) rejected.push("MODEL_EXACT_MISMATCH");
  if (title && target.brand && !containsExactIdentity(title, target.brand)) rejected.push("BRAND_MISMATCH_OR_MISSING");
  for (const qualifier of target.requiredQualifiers) {
    if (title && !containsExactIdentity(title, qualifier)) rejected.push("REQUIRED_QUALIFIER_MISMATCH");
  }
  if (title && SERVICE_SIGNAL.test(title)) rejected.push("SERVICE_RECORD");
  if (title && REPLACEMENT_SIGNAL.test(title)) rejected.push("REPLACEMENT_OR_PART_RECORD");
  if (title && ACCESSORY_SIGNAL.test(title)) rejected.push("ACCESSORY_RECORD");
  if (!conditionMatches(target, observation.condition)) rejected.push("CONDITION_MISMATCH");

  const status = rejected.length > 0 ? "REJECTED" : insufficient.length > 0 ? "INSUFFICIENT_EVIDENCE" : "ELIGIBLE";
  return {
    observationRef: observation.observationRef,
    status,
    reasonCodes: [...new Set([...rejected, ...insufficient])],
    policyVersion: QUOTE_ADMISSION_POLICY_VERSION,
  };
}
