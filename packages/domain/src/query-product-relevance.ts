import { inferCategoryValidationPolicy, resolveCategoryValidationPolicy } from "./catalog-validation-policies.js";
import { matchSearchTokens, tokenizeSearchText } from "./search-tokenizer.js";
import type { RetrievedListing, SearchGoalSnapshot } from "./types.js";
import type {
  CandidateAdmissionDecision,
  QueryProductRelevanceAssessment,
  QueryProductRelevanceEvidence,
  QueryProductRelevanceLabel,
  SemanticRelevanceSignal,
} from "./query-product-relevance-types.js";

export const QUERY_PRODUCT_RELEVANCE_POLICY_VERSION = "esci-admission-v2" as const;

function listingText(listing: RetrievedListing): string {
  return [listing.title.value, ...(listing.categoryPath.value ?? []), listing.providerProductType.value]
    .filter(Boolean)
    .join(" ");
}

function providerTaxonomyText(listing: RetrievedListing): string {
  return [...(listing.categoryPath.value ?? []), listing.providerProductType.value]
    .filter(Boolean)
    .join(" ");
}

function relevanceTokens(value: string): string[] {
  const tokens = tokenizeSearchText(value);
  return [...new Set(tokens.flatMap((token) => {
    if (!/^[a-z0-9]+$/u.test(token)) return [token];
    if (token.length > 4 && token.endsWith("ies")) return [token, `${token.slice(0, -3)}y`];
    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return [token, token.slice(0, -1)];
    return [token];
  }))];
}

function lexicalScripts(value: string): ReadonlySet<"HAN" | "LATIN" | "OTHER_LETTER"> {
  const scripts = new Set<"HAN" | "LATIN" | "OTHER_LETTER">();
  if (/\p{Script=Han}/u.test(value)) scripts.add("HAN");
  if (/\p{Script=Latin}/u.test(value)) scripts.add("LATIN");
  if (/\p{L}/u.test(value.replace(/[\p{Script=Han}\p{Script=Latin}]/gu, ""))) scripts.add("OTHER_LETTER");
  return scripts;
}

function isLexicallyComparable(targetText: string, listingValue: string): boolean {
  const targetScripts = lexicalScripts(targetText);
  const listingScripts = lexicalScripts(listingValue);
  return targetScripts.size > 0 && [...targetScripts].every((script) => listingScripts.has(script));
}

function fieldEvidence(
  listing: RetrievedListing,
  supports: QueryProductRelevanceLabel,
): QueryProductRelevanceEvidence[] {
  return [
    { source: "PROVIDER_PRODUCT_TYPE" as const, value: listing.providerProductType.value, supports },
    { source: "CATEGORY_PATH" as const, value: listing.categoryPath.value, supports },
    { source: "PRODUCT_IDENTITY" as const, value: listing.identity, supports },
    { source: "TITLE" as const, value: listing.title.value, supports },
  ].filter((item) => item.value !== null && (!Array.isArray(item.value) || item.value.length > 0));
}

function assessment(
  label: QueryProductRelevanceLabel,
  listing: RetrievedListing,
  reasonCodes: string[],
  semanticSignal?: SemanticRelevanceSignal,
): QueryProductRelevanceAssessment {
  return {
    label,
    policyVersion: QUERY_PRODUCT_RELEVANCE_POLICY_VERSION,
    reasonCodes,
    evidence: [
      ...fieldEvidence(listing, label),
      ...(semanticSignal ? [{ source: "SEMANTIC_MODEL" as const, value: semanticSignal, supports: semanticSignal.label }] : []),
    ],
  };
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleUpperCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isBroadCategoryTarget(
  targetText: string | null | undefined,
  policy: NonNullable<ReturnType<typeof resolveCategoryValidationPolicy>>,
): boolean {
  const target = normalized(targetText);
  if (!target) return true;
  return [policy.categoryId, policy.broaderQueryTerm, ...policy.aliases]
    .some((value) => normalized(value) === target);
}

/**
 * Assesses query-product relevance before commercial eligibility or ranking.
 * Structured provider/category/identity evidence takes precedence. An optional
 * semantic signal can resolve otherwise-open-world cases, but conflicts fail
 * closed to UNRESOLVED and never directly authorize ranking.
 */
export function assessQueryProductRelevance(input: {
  listing: RetrievedListing;
  goal: SearchGoalSnapshot;
  semanticSignal?: SemanticRelevanceSignal;
}): QueryProductRelevanceAssessment {
  const { listing, goal, semanticSignal } = input;
  const targetPolicy = resolveCategoryValidationPolicy(goal.target.categoryId);
  const observedCategory = listing.identity.categoryId.value;
  const observedRole = listing.identity.itemRole.value;
  const providerTaxonomyPolicy = inferCategoryValidationPolicy(providerTaxonomyText(listing));
  const conclude = (label: QueryProductRelevanceLabel, reasonCodes: string[]): QueryProductRelevanceAssessment => {
    if (!semanticSignal || semanticSignal.confidence < 0.8) return assessment(label, listing, reasonCodes, semanticSignal);
    if (label === "UNRESOLVED") {
      return assessment(semanticSignal.label, listing, ["SEMANTIC_SIGNAL_RESOLVED_OPEN_WORLD_CASE"], semanticSignal);
    }
    if (semanticSignal.label !== label) {
      return assessment("UNRESOLVED", listing, ["STRUCTURED_SEMANTIC_EVIDENCE_CONFLICT"], semanticSignal);
    }
    return assessment(label, listing, reasonCodes, semanticSignal);
  };

  // Item role is query-relative. An accessory is a complement only when the
  // user asked for the primary product (or another role); when the accessory
  // itself is the target, matching accessories remain eligible to be EXACT.
  if (observedRole && observedRole !== goal.target.itemRole) {
    return conclude("COMPLEMENT", ["QUERY_TARGET_ITEM_ROLE_MISMATCH"]);
  }
  if (targetPolicy && observedCategory && observedCategory !== targetPolicy.categoryId) {
    return conclude("IRRELEVANT", ["OBSERVED_CATEGORY_CONFLICT"]);
  }
  if (targetPolicy && observedCategory === targetPolicy.categoryId && observedRole === "PRIMARY_PRODUCT") {
    const targetModel = normalized(goal.target.canonicalModel);
    const observedModel = normalized(listing.identity.canonicalModel.value);
    if (!targetModel) {
      if (providerTaxonomyPolicy?.categoryId === targetPolicy.categoryId && isBroadCategoryTarget(goal.target.targetText, targetPolicy)) {
        return conclude("EXACT", ["INDEPENDENT_PROVIDER_TAXONOMY_PRIMARY_PRODUCT_MATCH"]);
      }
      return conclude("UNRESOLVED", [isBroadCategoryTarget(goal.target.targetText, targetPolicy)
        ? "TITLE_DERIVED_IDENTITY_REQUIRES_SEMANTIC_CORROBORATION"
        : "SPECIFIC_TARGET_REQUIRES_SEMANTIC_CORROBORATION"]);
    }
    if (observedModel === targetModel) return conclude("EXACT", ["EXACT_MODEL_MATCH"]);
    if (observedModel) return conclude("SUBSTITUTE", ["SAME_CATEGORY_DIFFERENT_MODEL"]);
    return conclude("UNRESOLVED", ["TARGET_MODEL_NOT_RESOLVED"]);
  }

  if (observedRole && observedRole === goal.target.itemRole && observedRole !== "PRIMARY_PRODUCT") {
    const targetTokens = relevanceTokens(goal.target.targetText ?? goal.target.categoryId.replaceAll("_", " "));
    const targetCoverage = matchSearchTokens(relevanceTokens(listingText(listing)), targetTokens).coverage;
    return conclude(
      targetTokens.length > 0 && targetCoverage === 1 ? "EXACT" : "UNRESOLVED",
      targetTokens.length > 0 && targetCoverage === 1
        ? ["QUERY_TARGET_ITEM_ROLE_AND_TEXT_MATCH"]
        : ["QUERY_TARGET_ITEM_ROLE_MATCH_REQUIRES_SEMANTIC_CORROBORATION"],
    );
  }

  const haystack = relevanceTokens(listingText(listing));
  const listingValue = listingText(listing);
  const targetValue = goal.target.targetText ?? goal.target.categoryId.replaceAll("_", " ");
  const categoryTokens = relevanceTokens(goal.target.categoryId.replaceAll("_", " "));
  const targetTokens = relevanceTokens(targetValue);
  const modelTokens = relevanceTokens(goal.target.canonicalModel ?? "");
  const categoryCoverage = matchSearchTokens(haystack, categoryTokens).coverage;
  const targetCoverage = matchSearchTokens(haystack, targetTokens).coverage;
  const modelCoverage = matchSearchTokens(haystack, modelTokens).coverage;
  let deterministic: QueryProductRelevanceLabel = "UNRESOLVED";
  let reasonCodes = ["OPEN_WORLD_RELEVANCE_UNRESOLVED"];
  if (modelTokens.length > 0 && modelCoverage === 1) {
    deterministic = "EXACT";
    reasonCodes = ["OPEN_CATEGORY_MODEL_TOKENS_MATCH"];
  } else if (categoryTokens.length > 0 && categoryCoverage === 1 && targetTokens.length > 0 && targetCoverage === 1) {
    deterministic = "EXACT";
    reasonCodes = ["OPEN_CATEGORY_TARGET_TOKENS_MATCH"];
  } else if (categoryTokens.length > 0 && categoryCoverage === 1 && isLexicallyComparable(targetValue, listingValue)) {
    deterministic = "SUBSTITUTE";
    reasonCodes = ["OPEN_CATEGORY_MATCH_WITH_TARGET_DIFFERENCE"];
  } else if (categoryTokens.length > 0 && categoryCoverage === 1) {
    deterministic = "UNRESOLVED";
    reasonCodes = ["CROSS_SCRIPT_TARGET_REQUIRES_SEMANTIC_CORROBORATION"];
  } else if ((listing.providerProductType.value || (listing.categoryPath.value?.length ?? 0) > 0) && categoryCoverage === 0) {
    deterministic = "IRRELEVANT";
    reasonCodes = ["PROVIDER_TAXONOMY_TARGET_MISMATCH"];
  }

  return conclude(deterministic, reasonCodes);
}

export function decideCandidateAdmission(assessment: QueryProductRelevanceAssessment): CandidateAdmissionDecision {
  const cohort = {
    EXACT: "MAIN_RECOMMENDATION",
    SUBSTITUTE: "ALTERNATIVE_COHORT",
    COMPLEMENT: "RELATED_COHORT",
    IRRELEVANT: "INELIGIBLE",
    UNRESOLVED: "INSUFFICIENT_EVIDENCE",
  } as const;
  return {
    cohort: cohort[assessment.label],
    eligibleForMainRanking: assessment.label === "EXACT",
    policyVersion: QUERY_PRODUCT_RELEVANCE_POLICY_VERSION,
    reasonCodes: [`ESCI_${assessment.label}`, `COHORT_${cohort[assessment.label]}`],
  };
}
