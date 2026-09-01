import {
  identityLexicalKey,
  normalizeProductIdentifier,
  validateProductIdentitySnapshot,
  type ProductIdentitySnapshot,
} from "./product-identity.js";
import type { QuoteObservation, QuoteTarget } from "./quote-types.js";

export const OFFER_IDENTITY_POLICY_VERSION = "offer-identity-v1" as const;

export type OfferIdentityStrength =
  | "STRONG_IDENTIFIER_MATCH"
  | "CURATED_TITLE_ALIAS_MATCH"
  | "EXACT_LEXICAL_MATCH"
  | "PROBABILISTIC_CANDIDATE"
  | "IDENTITY_OR_ROLE_CONFLICT";

export interface OfferIdentityDecision {
  strength: OfferIdentityStrength;
  publishable: boolean;
  reasonCodes: string[];
  evidenceRefs: string[];
  policyVersion: typeof OFFER_IDENTITY_POLICY_VERSION;
}

const ACCESSORY_OR_SERVICE = /\b(?:accessor(?:y|ies)|case|cover|protector|cable|charger|charging|ear[\s-]?pads?|ear[\s-]?cushions?|stand|holder|mount|adapter|sleeve|skin|compatible\s+with|designed\s+for|repair|service|installation|maintenance|replacement|spare\s+part|parts?\s+only)\b|配件|保护壳|保护套|耳罩|耳垫|充电线|数据线|支架|适用于|兼容|维修|服务|安装|更换|备件|零件/iu;
const BUNDLE = /\b(?:bundle|bundled|combo|kit|with\s+(?:case|charger|accessor(?:y|ies)))\b|套装|组合装|礼包/iu;

function containsExact(value: string, identity: string): boolean {
  const wanted = identityLexicalKey(identity);
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

function decision(
  strength: OfferIdentityStrength,
  reasonCodes: string[],
  evidenceRefs: string[],
): OfferIdentityDecision {
  return {
    strength,
    publishable: ["STRONG_IDENTIFIER_MATCH", "CURATED_TITLE_ALIAS_MATCH", "EXACT_LEXICAL_MATCH"].includes(strength),
    reasonCodes: [...new Set(reasonCodes)],
    evidenceRefs: [...new Set(evidenceRefs)].sort(),
    policyVersion: OFFER_IDENTITY_POLICY_VERSION,
  };
}

function titleEvidence(observation: QuoteObservation, kind: string): string {
  return `${observation.artifactRef}#${observation.jsonPath}.title:${kind}`;
}

function fieldEvidence(observation: QuoteObservation, jsonPath: string): string {
  return `${observation.artifactRef}#${observation.jsonPath}${jsonPath.slice(1)}`;
}

function identifierMatch(
  observation: QuoteObservation,
  target: QuoteTarget,
  snapshot: ProductIdentitySnapshot | null,
): OfferIdentityDecision | null {
  if (!snapshot || !target.identity.variantRef) return null;
  const approved = snapshot.identifiers.filter((value) => value.approvalStatus === "APPROVED");
  const matched = new Set<string>();
  const evidence: string[] = [];
  for (const signal of observation.identitySignals.identifiers) {
    let normalized: string;
    try {
      normalized = normalizeProductIdentifier(signal.scheme, signal.value);
    } catch {
      continue;
    }
    for (const identifier of approved) {
      if (identifier.scheme !== signal.scheme || identifier.normalizedValue !== normalized) continue;
      matched.add(identifier.variantRef);
      evidence.push(identifier.identifierRef, fieldEvidence(observation, signal.jsonPath));
    }
  }
  if (matched.size === 0) return null;
  if (matched.size > 1 || !matched.has(target.identity.variantRef)) {
    return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_IDENTIFIER_VARIANT_CONFLICT"], evidence);
  }
  return decision("STRONG_IDENTIFIER_MATCH", [], evidence);
}

function expectedAttributes(target: QuoteTarget, snapshot: ProductIdentitySnapshot | null): string[] {
  const variant = snapshot?.variants.find((value) => value.variantRef === target.identity.variantRef);
  return [...new Set([...target.requiredQualifiers, ...Object.values(variant?.attributes ?? {})].filter(Boolean))];
}

/** Resolves the returned record independently from the query target. Probabilistic evidence never publishes. */
export function resolveOfferIdentity(
  observation: QuoteObservation,
  target: QuoteTarget,
  snapshotInput?: ProductIdentitySnapshot,
): OfferIdentityDecision {
  const snapshot = snapshotInput ? validateProductIdentitySnapshot(snapshotInput) : null;
  if (snapshot && target.identity.registryVersion !== null && snapshot.registryVersion !== target.identity.registryVersion) {
    return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_IDENTITY_REGISTRY_VERSION_MISMATCH"], []);
  }
  const title = observation.title ?? "";
  if (!title) return decision("PROBABILISTIC_CANDIDATE", ["OFFER_TITLE_MISSING"], []);
  if (BUNDLE.test(title) && !target.requiredQualifiers.some((value) => BUNDLE.test(value))) {
    return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_UNREQUESTED_BUNDLE"], [titleEvidence(observation, "bundle")]);
  }
  if (ACCESSORY_OR_SERVICE.test(title)) {
    return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_NON_PRIMARY_ROLE"], [titleEvidence(observation, "role")]);
  }

  const attributes = expectedAttributes(target, snapshot);
  if (attributes.some((value) => !containsExact(title, value))) {
    return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_REQUIRED_VARIANT_ATTRIBUTE_MISMATCH"], [titleEvidence(observation, "variant")]);
  }
  const signalledBrand = observation.identitySignals.brand?.value ?? null;
  if (signalledBrand && target.brand && identityLexicalKey(signalledBrand) !== identityLexicalKey(target.brand)) {
    return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_BRAND_FIELD_CONFLICT"], [fieldEvidence(observation, observation.identitySignals.brand!.jsonPath)]);
  }

  const strong = identifierMatch(observation, target, snapshot);
  if (strong?.strength === "IDENTITY_OR_ROLE_CONFLICT") return strong;

  const targetVariantRef = target.identity.variantRef;
  if (snapshot && targetVariantRef) {
    const conflictingAlias = snapshot.aliases.find((alias) => alias.approvalStatus === "APPROVED"
      && alias.purpose === "USER_INPUT"
      && alias.variantRef !== targetVariantRef
      && containsExact(title, alias.displayValue));
    if (conflictingAlias) {
      return decision("IDENTITY_OR_ROLE_CONFLICT", ["OFFER_VARIANT_ALIAS_CONFLICT"], [conflictingAlias.aliasRef, titleEvidence(observation, "variant")]);
    }
  }
  if (strong) return strong;

  const brandGrounded = !target.brand
    || containsExact(title, target.brand)
    || Boolean(signalledBrand && identityLexicalKey(signalledBrand) === identityLexicalKey(target.brand));
  if (!brandGrounded) return decision("PROBABILISTIC_CANDIDATE", ["OFFER_BRAND_EVIDENCE_MISSING"], []);

  if (snapshot && targetVariantRef) {
    const alias = snapshot.aliases
      .filter((value) => value.variantRef === targetVariantRef && value.approvalStatus === "APPROVED" && value.purpose === "USER_INPUT")
      .sort((left, right) => right.normalizedKey.length - left.normalizedKey.length || left.priority - right.priority)
      .find((value) => containsExact(title, value.displayValue));
    if (alias) return decision("CURATED_TITLE_ALIAS_MATCH", [], [alias.aliasRef, titleEvidence(observation, "curated-alias")]);
  }
  if (containsExact(title, target.canonicalModel)) {
    return decision("EXACT_LEXICAL_MATCH", [], [titleEvidence(observation, "canonical-model")]);
  }
  return decision("PROBABILISTIC_CANDIDATE", ["OFFER_IDENTITY_NOT_DETERMINISTIC"], []);
}
