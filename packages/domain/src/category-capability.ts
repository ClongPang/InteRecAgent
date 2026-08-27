import { resolveCategoryContract, type RegisteredCategoryContract } from "./catalog-contracts.js";

export type CategoryRecommendationCapability =
  | {
    supportLevel: "VERIFIED";
    categoryId: string;
    queryTerm: string;
    adapter: RegisteredCategoryContract;
  }
  | {
    supportLevel: "DISCOVERY";
    categoryId: string;
    queryTerm: string;
    adapter: null;
  };

/** The single boundary between generic Discovery and category-specific verification. */
export function resolveCategoryRecommendationCapability(categoryId: string, targetText?: string): CategoryRecommendationCapability {
  const adapter = resolveCategoryContract(categoryId);
  if (adapter) {
    return {
      supportLevel: "VERIFIED",
      categoryId: adapter.categoryId,
      queryTerm: adapter.broaderQueryTerm,
      adapter,
    };
  }
  return {
    supportLevel: "DISCOVERY",
    categoryId,
    queryTerm: targetText?.normalize("NFKC").trim() || categoryId,
    adapter: null,
  };
}
