import { canonicalCategoryContract } from "./catalog-contracts.js";
import { resolveCategoryRecommendationCapability } from "./category-capability.js";
import { DomainError } from "./errors.js";
import type { MarketEvidenceLevel, StockStatus } from "./types.js";

export type RecommendationSupportLevel = "DISCOVERY" | "VERIFIED";
export type CandidateIdentityLevel = "OFFER_ONLY" | "VERIFIED_ITEM";

export interface CandidateRankVector {
  eligibilityTier: 0 | 1 | 2 | 3;
  targetCoverage: number;
  positiveCoverage: number;
  negativeConflicts: number;
  evidenceTier: number;
  stockTier: number;
  priceTieBreaker: string | null;
}

export interface CandidateDiscoveryMetadata {
  supportLevel: RecommendationSupportLevel;
  identityLevel: CandidateIdentityLevel;
  identityKey: string | null;
  matchedPreferenceKeys: string[];
  contradictedPreferenceKeys: string[];
  rankVector: CandidateRankVector;
}

export interface DiscoveryCandidateFacts {
  marketEvidenceLevel?: MarketEvidenceLevel;
  stock: StockStatus;
  cnyAmount: string | null;
}

function normalizedOpenCategory(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s/]+/gu, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/_+/gu, "_")
    .replace(/^_|_$/gu, "");
}

/**
 * Returns a stable category hint without making category registration a
 * prerequisite for conversation or discovery. Registered aliases still
 * collapse to their canonical contract ID.
 */
export function canonicalDiscoveryCategory(value: string): string {
  const registered = canonicalCategoryContract(value);
  if (registered) return registered.categoryId;
  const normalized = normalizedOpenCategory(value);
  if (!normalized) throw new DomainError("INVALID_CATEGORY_ID", "A category hint must contain letters or numbers");
  if (normalized.length > 100) throw new DomainError("INVALID_CATEGORY_ID", "A category hint is longer than 100 characters");
  return normalized;
}

export function supportLevelForCategory(categoryId: string): RecommendationSupportLevel {
  return resolveCategoryRecommendationCapability(categoryId).supportLevel;
}
