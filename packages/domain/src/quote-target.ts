import { createHash } from "node:crypto";

import type { QuoteConditionPreference, QuoteTarget, QuoteTargetResolution } from "./quote-types.js";

const BRAND_ALIASES = new Map<string, readonly string[]>([
  ["Apple", ["apple", "苹果"]],
  ["Dyson", ["dyson", "戴森"]],
  ["Logitech", ["logitech", "罗技"]],
  ["Nintendo", ["nintendo", "任天堂"]],
  ["Samsung", ["samsung", "三星"]],
  ["Sony", ["sony", "索尼"]],
]);

export interface ResolveQuoteTargetInput {
  rawText: string;
  proposedModel: string;
  brand?: string | null;
  productType?: string | null;
  requiredQualifiers?: readonly string[];
  conditionPreference?: QuoteConditionPreference;
  explicitlyConfirmed?: boolean;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function quoteIdentityKey(value: string): string {
  return normalizedText(value).toLocaleUpperCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function canonicalBrand(value: string | null | undefined): string | null {
  const candidate = value ? normalizedText(value).toLocaleLowerCase("en-US") : "";
  if (!candidate) return null;
  for (const [brand, aliases] of BRAND_ALIASES) {
    if (aliases.includes(candidate)) return brand;
  }
  return normalizedText(value!);
}

function rawContainsBrand(rawText: string, canonical: string): boolean {
  const aliases = BRAND_ALIASES.get(canonical) ?? [canonical];
  return aliases.some((alias) => rawContainsIdentity(rawText, alias));
}

function rawContainsIdentity(rawText: string, identity: string): boolean {
  const wanted = quoteIdentityKey(identity);
  if (!wanted) return false;
  const tokens = normalizedText(rawText).toLocaleUpperCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let index = start; index < tokens.length && joined.length <= wanted.length; index += 1) {
      joined += tokens[index]!;
      if (joined === wanted) return true;
    }
  }
  return false;
}

function canonicalModelDisplay(value: string): string {
  const upper = normalizedText(value).toLocaleUpperCase("en-US");
  const sonyWh = upper.match(/^WH[\s-]?(\d{4})[\s-]?(XM\d+)$/u);
  if (sonyWh) return `WH-${sonyWh[1]}${sonyWh[2]}`;
  return upper;
}

function deduplicatedQualifiers(values: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizedText(value);
    const key = quoteIdentityKey(normalized);
    if (key && !byKey.has(key)) byKey.set(key, normalized);
  }
  return [...byKey.values()];
}

function targetRef(parts: readonly string[]): string {
  return `qt_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

export function resolveQuoteTarget(input: ResolveQuoteTargetInput): QuoteTargetResolution {
  const rawText = normalizedText(input.rawText);
  const proposedModel = normalizedText(input.proposedModel);
  const modelKey = quoteIdentityKey(proposedModel);
  const normalizationChanges: string[] = [];
  const reasonCodes: string[] = [];

  if (!rawText) reasonCodes.push("TARGET_TEXT_REQUIRED");
  if (!modelKey || !/[\p{L}]/u.test(modelKey) || !/\p{N}/u.test(modelKey)) reasonCodes.push("MODEL_FORMAT_UNRESOLVED");
  const modelGrounded = rawContainsIdentity(rawText, proposedModel);
  if (!modelGrounded && input.explicitlyConfirmed !== true) reasonCodes.push("MODEL_NOT_LEXICALLY_GROUNDED");

  const brand = canonicalBrand(input.brand);
  if (brand && !rawContainsBrand(rawText, brand)) {
    reasonCodes.push("BRAND_NOT_LEXICALLY_GROUNDED");
  }

  const productType = input.productType ? normalizedText(input.productType) : null;
  // A model confirmation cannot authorize extra query context invented by a planner.
  // Product type and qualifiers must remain present in the auditable source text.
  if (productType && !rawContainsIdentity(rawText, productType)) {
    reasonCodes.push("PRODUCT_TYPE_NOT_LEXICALLY_GROUNDED");
  }

  const qualifiers = deduplicatedQualifiers(input.requiredQualifiers ?? []);
  if (qualifiers.some((value) => !rawContainsIdentity(rawText, value))) {
    reasonCodes.push("QUALIFIER_NOT_LEXICALLY_GROUNDED");
  }

  const canonicalModel = canonicalModelDisplay(proposedModel);
  if (canonicalModel !== proposedModel) normalizationChanges.push("MODEL_CASE_OR_PUNCTUATION_NORMALIZED");
  if (rawText !== input.rawText) normalizationChanges.push("TARGET_UNICODE_SPACE_NORMALIZED");
  if (reasonCodes.length > 0) {
    return { status: "NEEDS_CONFIRMATION", target: null, reasonCodes: [...new Set(reasonCodes)], normalizationChanges };
  }

  const canonicalQuery = [brand, canonicalModel, productType, ...qualifiers]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.findIndex((candidate) => quoteIdentityKey(candidate) === quoteIdentityKey(value)) === index)
    .join(" ");
  // No condition request means "show condition-labelled quote leads", not "assume new".
  const conditionPreference = input.conditionPreference ?? "ANY";
  const target: QuoteTarget = {
    targetRef: targetRef([modelKey, brand ?? "", productType ?? "", qualifiers.map(quoteIdentityKey).join("|"), conditionPreference]),
    rawText,
    brand,
    canonicalModel,
    modelKey,
    productType,
    requiredQualifiers: qualifiers,
    itemRole: "PRIMARY_PRODUCT",
    conditionPreference,
    canonicalQuery,
    confirmation: input.explicitlyConfirmed === true ? "EXPLICITLY_CONFIRMED" : "LEXICALLY_GROUNDED",
    normalizationChanges: [...normalizationChanges],
  };
  return { status: "RESOLVED", target, reasonCodes: [], normalizationChanges };
}
