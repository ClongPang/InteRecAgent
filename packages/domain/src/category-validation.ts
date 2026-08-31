import { resolveCategoryValidationPolicy, type RegisteredCategoryValidationPolicy } from "./catalog-validation-policies.js";

export type CategoryValidationCapability =
  | {
    validationMode: "RULE_VALIDATED";
    categoryId: string;
    queryTerm: string;
    policy: RegisteredCategoryValidationPolicy;
  }
  | {
    validationMode: "SEARCH_ONLY";
    categoryId: string;
    queryTerm: string;
    policy: null;
  };

/** Selects category-specific rule validation when a policy exists; otherwise results remain search-only. */
export function resolveCategoryValidationCapability(categoryId: string, targetText?: string): CategoryValidationCapability {
  const policy = resolveCategoryValidationPolicy(categoryId);
  if (policy) {
    return {
      validationMode: "RULE_VALIDATED",
      categoryId: policy.categoryId,
      queryTerm: policy.broaderQueryTerm,
      policy,
    };
  }
  return {
    validationMode: "SEARCH_ONLY",
    categoryId,
    queryTerm: targetText?.normalize("NFKC").trim() || categoryId,
    policy: null,
  };
}
