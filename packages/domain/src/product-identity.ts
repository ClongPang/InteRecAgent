import {
  canonicalModels,
  canonicalProductModel,
  contractPatternMatches,
  inferCategoryContract,
  resolveCategoryContract,
  type CategoryContract,
} from "./catalog-contracts.js";
import type { EvidenceRef, Fact, ItemRole, ProductCondition, ProductIdentity, ProductTarget } from "./types.js";

const STOP_TOKENS = new Set(["帮我", "比较", "推荐", "价格", "哪里", "购买", "buy", "price", "compare"]);
const ACCESSORY_RELATION = /\b(?:for|fits?|compatible\s+with)\b|适用于|兼容/iu;
const REPLACEMENT_RELATION = /\b(?:replacement|repair|spare\s+part)\b|替换|维修|零件/iu;
const ACCESSORY_CLASSIFICATION = /\b(?:accessories|parts|cases|cables)\b|配件|零件/iu;
const ACCESSORY_PRODUCT = /\b(?:case|cover|protector|charger|charging\s+cable|phone\s+holder|mount|skin|bumper)\b/iu;
const REFURBISHED = /\b(?:refurbished|renewed|reconditioned|reacondicionado|outlet\s+grade)\b|翻新/iu;
const USED = /\b(?:pre[\s-]?owned|used)\b|二手/iu;
const NEW = /\b(?:brand[\s-]?new|new)\b|全新/iu;

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function queryTokens(value: string): string[] {
  return [...new Set(normalizeText(value).split(" "))].filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));
}

export function modelTokens(value: string): string[] {
  return canonicalModels(value);
}

export function isDiscriminativeQuery(query: string): boolean {
  const tokens = queryTokens(query);
  return modelTokens(query).length > 0 || tokens.length >= 2 || normalizeText(query).length >= 8;
}

function conditionPreference(query: string): ProductTarget["conditionPreference"] {
  if (REFURBISHED.test(query)) return "REFURBISHED";
  if (USED.test(query)) return "USED";
  return "NEW_OR_UNSPECIFIED";
}

export function resolveProductTarget(query: string): ProductTarget {
  const contract = inferCategoryContract(query);
  const models = canonicalModels(query, contract?.categoryId);
  const itemRole: ItemRole = REPLACEMENT_RELATION.test(query)
    ? "REPLACEMENT_PART"
    : ACCESSORY_RELATION.test(query) || Boolean(contract && contractPatternMatches(contract.accessorySignals, query))
      ? "ACCESSORY"
      : "PRIMARY_PRODUCT";
  return {
    categoryId: contract?.categoryId ?? "unknown",
    canonicalModel: models[0] ?? null,
    itemRole,
    conditionPreference: conditionPreference(query),
  };
}

function derivedFact<T>(value: T | null, evidence: EvidenceRef[]): Fact<T> {
  return { value, status: value === null ? "UNKNOWN" : "DERIVED", evidence };
}

function classifyItemRole(title: string, classification: string, contract: CategoryContract | null): ItemRole {
  const combined = `${title} ${classification}`;
  if (REPLACEMENT_RELATION.test(combined)) return "REPLACEMENT_PART";
  if (ACCESSORY_RELATION.test(title) || ACCESSORY_PRODUCT.test(title) || Boolean(contract && contractPatternMatches(contract.accessorySignals, title))) {
    return "ACCESSORY";
  }
  if (contract && (contractPatternMatches(contract.primarySignals, title) || canonicalModels(title, contract.categoryId).length > 0)) return "PRIMARY_PRODUCT";
  if (contract && contractPatternMatches(contract.primarySignals, classification)) return "PRIMARY_PRODUCT";
  if (ACCESSORY_CLASSIFICATION.test(classification)) return "ACCESSORY";
  return "UNKNOWN";
}

function classifyCondition(title: string): ProductCondition {
  if (REFURBISHED.test(title)) return "REFURBISHED";
  if (USED.test(title)) return "USED";
  if (NEW.test(title)) return "NEW";
  return "UNKNOWN";
}

export function resolveProductIdentity(title: string, classification: string, target: ProductTarget, evidence: EvidenceRef[]): ProductIdentity {
  const targetContract = resolveCategoryContract(target.categoryId);
  const observedContract = inferCategoryContract(`${title} ${classification}`);
  const titleModels = canonicalModels(title, targetContract?.categoryId);
  const targetModel = target.canonicalModel
    ? canonicalProductModel(target.canonicalModel, targetContract?.categoryId) ?? target.canonicalModel.normalize("NFKC").trim().toUpperCase()
    : null;
  const observedModel = canonicalProductModel(title, targetContract?.categoryId) ?? titleModels[0] ?? null;
  const targetBase = target.canonicalModel ? canonicalModels(target.canonicalModel, targetContract?.categoryId)[0] ?? null : null;
  const observedBase = titleModels[0] ?? null;
  const targetCapacity = targetModel?.match(/\b\d+(?:GB|TB)\b/u)?.[0] ?? null;
  const observedCapacity = observedModel?.match(/\b\d+(?:GB|TB)\b/u)?.[0] ?? null;
  const model = observedModel;
  const conflictingModel = Boolean(targetModel && observedBase && (
    observedBase !== targetBase
    || (targetCapacity && observedCapacity && targetCapacity !== observedCapacity)
  ));
  const categoryId = observedContract?.categoryId ?? null;
  const categoryConflict = Boolean(categoryId && targetContract && categoryId !== targetContract.categoryId);
  const itemRole = classifyItemRole(title, classification, targetContract);
  const condition = classifyCondition(title);
  const modelMatchesTarget = targetModel
    ? observedBase === targetBase && (!targetCapacity || observedCapacity === targetCapacity)
    : true;
  const identityMatches = Boolean(
    !conflictingModel
    && !categoryConflict
    && modelMatchesTarget
    && categoryId === targetContract?.categoryId
    && itemRole === target.itemRole,
  );
  const status = conflictingModel || categoryConflict || (itemRole !== "UNKNOWN" && itemRole !== target.itemRole)
    ? "CONFLICTED" as const
    : identityMatches ? "RESOLVED" as const : "UNRESOLVED" as const;
  const comparisonIdentity = model ?? `TITLE:${normalizeText(title).toUpperCase()}`;
  return {
    categoryId: derivedFact(categoryId, evidence),
    canonicalModel: derivedFact(model, evidence),
    itemRole: derivedFact(itemRole === "UNKNOWN" ? null : itemRole, evidence),
    condition: derivedFact(condition === "UNKNOWN" ? null : condition, evidence),
    comparisonKey: status === "RESOLVED" ? [categoryId, comparisonIdentity, itemRole, condition].join(":") : null,
    status,
  };
}
