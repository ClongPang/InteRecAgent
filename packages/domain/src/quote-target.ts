import { createHash } from "node:crypto";

import {
  identityLexicalKey,
  legacyLiteralIdentityBinding,
  type ProductIdentityResolution,
} from "./product-identity.js";
import { identityBindingFromResolution } from "./product-identity-registry.js";
import type { QuoteConditionPreference, QuoteTarget, QuoteTargetResolution } from "./quote-types.js";

export interface ResolveQuoteTargetInput {
  rawText: string;
  proposedModel: string;
  brand?: string | null;
  productType?: string | null;
  requiredQualifiers?: readonly string[];
  conditionPreference?: QuoteConditionPreference;
  explicitlyConfirmed?: boolean;
  /** Host-bound resolver output. This field is never accepted from the model schema. */
  identityResolution?: ProductIdentityResolution;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function quoteIdentityKey(value: string): string {
  return identityLexicalKey(normalizedText(value));
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

/** Pure target binding. Brand/model knowledge comes from a host-bound registry resolution, never source branches. */
export function resolveQuoteTarget(input: ResolveQuoteTargetInput): QuoteTargetResolution {
  const rawText = normalizedText(input.rawText);
  const proposedModel = normalizedText(input.proposedModel);
  const proposedModelKey = quoteIdentityKey(proposedModel);
  const normalizationChanges: string[] = [];
  const reasonCodes: string[] = [];
  const identityResolution = input.identityResolution;
  const resolvedIdentity = identityResolution?.outcome === "RESOLVED" ? identityResolution : null;

  if (!rawText) reasonCodes.push("TARGET_TEXT_REQUIRED");
  if (!proposedModelKey || !/[\p{L}]/u.test(proposedModelKey) || !/\p{N}/u.test(proposedModelKey)) {
    reasonCodes.push("MODEL_FORMAT_UNRESOLVED");
  }
  if (!rawContainsIdentity(rawText, proposedModel) && input.explicitlyConfirmed !== true) {
    reasonCodes.push("MODEL_NOT_LEXICALLY_GROUNDED");
  }

  const sourceBrand = input.brand ? normalizedText(input.brand) : null;
  if (sourceBrand && !rawContainsIdentity(rawText, sourceBrand)) reasonCodes.push("BRAND_NOT_LEXICALLY_GROUNDED");
  const sourceProductType = input.productType ? normalizedText(input.productType) : null;
  if (sourceProductType && !rawContainsIdentity(rawText, sourceProductType)) reasonCodes.push("PRODUCT_TYPE_NOT_LEXICALLY_GROUNDED");
  const qualifiers = deduplicatedQualifiers(input.requiredQualifiers ?? []);
  if (qualifiers.some((value) => !rawContainsIdentity(rawText, value))) reasonCodes.push("QUALIFIER_NOT_LEXICALLY_GROUNDED");

  if (identityResolution && identityResolution.outcome !== "RESOLVED") reasonCodes.push(...identityResolution.reasonCodes);
  const canonicalModel = resolvedIdentity?.canonicalModel ?? proposedModel.toLocaleUpperCase("en-US");
  const modelKey = quoteIdentityKey(canonicalModel);
  if (modelKey !== proposedModelKey && input.explicitlyConfirmed !== true) {
    reasonCodes.push("MODEL_CANONICAL_ALIAS_REQUIRES_CONFIRMATION");
  }
  if (canonicalModel !== proposedModel) {
    normalizationChanges.push(modelKey === proposedModelKey
      ? "MODEL_CASE_OR_PUNCTUATION_NORMALIZED"
      : "MODEL_CANONICAL_ALIAS_CONFIRMED");
  }
  if (rawText !== input.rawText) normalizationChanges.push("TARGET_UNICODE_SPACE_NORMALIZED");
  if (reasonCodes.length > 0) {
    return { status: "NEEDS_CONFIRMATION", target: null, reasonCodes: [...new Set(reasonCodes)], normalizationChanges };
  }

  const brand = resolvedIdentity?.canonicalBrand ?? sourceBrand;
  const productType = sourceProductType ?? resolvedIdentity?.productType ?? null;
  const canonicalQuery = resolvedIdentity?.providerQuery ?? [brand, canonicalModel, productType, ...qualifiers]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.findIndex((candidate) => quoteIdentityKey(candidate) === quoteIdentityKey(value)) === index)
    .join(" ");
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
    identity: resolvedIdentity
      ? identityBindingFromResolution(resolvedIdentity)
      : legacyLiteralIdentityBinding(input.explicitlyConfirmed === true),
  };
  return { status: "RESOLVED", target, reasonCodes: [], normalizationChanges };
}

export function upcastLegacyQuoteTarget(target: QuoteTarget | Omit<QuoteTarget, "identity">): QuoteTarget {
  if ("identity" in target && target.identity) return structuredClone(target as QuoteTarget);
  return {
    ...structuredClone(target),
    identity: legacyLiteralIdentityBinding(target.confirmation === "EXPLICITLY_CONFIRMED"),
  };
}
