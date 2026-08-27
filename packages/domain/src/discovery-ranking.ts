import { compareDecimal } from "./money.js";
import { matchDiscoveryTokens, tokenizeDiscoveryText } from "./discovery-tokenizer.js";
import type { CandidateDiscoveryMetadata, CandidateRankVector, RecommendationSupportLevel } from "./discovery.js";
import type { DiscoveredListing, Goal, MarketEvidence, StockStatus } from "./types.js";

function scalarText(value: string | number | boolean | string[]): string {
  return Array.isArray(value) ? value.join(" ") : String(value);
}

function listingText(listing: DiscoveredListing): string {
  return [
    listing.title.value,
    ...(listing.categoryPath.value ?? []),
    listing.providerProductType.value,
  ].filter(Boolean).join(" ");
}

function evidenceTier(evidence: MarketEvidence): number {
  if (evidence.level === "TARGET_DOMAIN_MARKET_CONSISTENT") return 3;
  if (evidence.level === "PROVIDER_ATTESTED") return 2;
  if (evidence.level === "UNVERIFIED") return 1;
  return 0;
}

function stockTier(stock: StockStatus): number {
  if (stock === "IN_STOCK") return 2;
  if (stock === "UNKNOWN") return 1;
  return 0;
}

export function buildCandidateDiscoveryMetadata(input: {
  listing: DiscoveredListing;
  goal: Goal;
  supportLevel: RecommendationSupportLevel;
  marketEvidence: MarketEvidence;
  stock: StockStatus;
  cnyAmount: string;
  hasUnverifiedHardConstraints?: boolean;
}): CandidateDiscoveryMetadata {
  const haystack = tokenizeDiscoveryText(listingText(input.listing));
  const targetTokens = tokenizeDiscoveryText([
    input.goal.target.targetText,
    input.goal.target.canonicalModel,
    input.goal.target.categoryId,
    input.goal.query,
  ].filter(Boolean).join(" "));
  const targetCoverage = matchDiscoveryTokens(haystack, targetTokens).coverage;
  const matchedPreferenceKeys: string[] = [];
  for (const preference of input.goal.preferenceHints ?? []) {
    const tokens = tokenizeDiscoveryText(scalarText(preference.value));
    if (tokens.length > 0 && matchDiscoveryTokens(haystack, tokens).coverage === 1) {
      matchedPreferenceKeys.push(preference.key);
    }
  }
  const hardConstraintCoverage = (input.goal.hardConstraints ?? []).map((constraint) => {
    const tokens = tokenizeDiscoveryText(scalarText(constraint.value));
    return tokens.length > 0 && matchDiscoveryTokens(haystack, tokens).coverage === 1;
  });
  const missingHardConstraints = hardConstraintCoverage.filter((matched) => !matched).length;
  const rankVector: CandidateRankVector = {
    eligibilityTier: input.supportLevel === "VERIFIED"
      ? 3
      : input.hasUnverifiedHardConstraints || missingHardConstraints > 0 ? 1 : 2,
    targetCoverage,
    positiveCoverage: (input.goal.preferenceHints ?? []).length === 0
      ? 0
      : matchedPreferenceKeys.length / (input.goal.preferenceHints ?? []).length,
    negativeConflicts: 0,
    evidenceTier: evidenceTier(input.marketEvidence),
    stockTier: stockTier(input.stock),
    priceTieBreaker: input.cnyAmount,
  };
  return {
    supportLevel: input.supportLevel,
    identityLevel: input.supportLevel === "VERIFIED" && input.listing.identity.status === "RESOLVED"
      ? "VERIFIED_ITEM"
      : "OFFER_ONLY",
    identityKey: input.supportLevel === "VERIFIED" ? input.listing.identity.comparisonKey : null,
    matchedPreferenceKeys,
    contradictedPreferenceKeys: [],
    rankVector,
  };
}

function descending(left: number, right: number): number {
  return right - left;
}

/** Lexicographic and deliberately non-learned: every ranking decision is inspectable. */
export function compareCandidateRankVectors(left: CandidateRankVector, right: CandidateRankVector): number {
  return descending(left.eligibilityTier, right.eligibilityTier)
    || descending(left.targetCoverage, right.targetCoverage)
    || descending(left.positiveCoverage, right.positiveCoverage)
    || (left.negativeConflicts - right.negativeConflicts)
    || descending(left.evidenceTier, right.evidenceTier)
    || descending(left.stockTier, right.stockTier)
    || (left.priceTieBreaker === null
      ? right.priceTieBreaker === null ? 0 : 1
      : right.priceTieBreaker === null ? -1 : compareDecimal(left.priceTieBreaker, right.priceTieBreaker));
}
