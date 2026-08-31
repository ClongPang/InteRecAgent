import { compareDecimal, convertToCny } from "./money.js";
import { validationPatternMatches, resolveCategoryValidationPolicy, resolveMarketDefinition } from "./catalog-validation-policies.js";
import { resolveCategoryValidationCapability } from "./category-validation.js";
import { buildCandidateRankingMetadata, compareCandidateRankVectors } from "./candidate-ranking.js";
import { assessQueryProductRelevance, decideCandidateAdmission } from "./query-product-relevance.js";
import type { SemanticRelevanceSignal } from "./query-product-relevance-types.js";
import type { ComparableOffer, RankedOfferSet, RetrievedListing, EvidenceRef, FxSnapshot, SearchGoalSnapshot, Market, MarketEvidence, ProductCondition, ListingEligibilityResult, RankedComparableOffer, ValidatedDecision } from "./types.js";

const COUNTRY_TLD = /\.([a-z]{2})$/i;

function countryFromDomain(domain: string): string | null {
  return domain.match(COUNTRY_TLD)?.[1]?.toUpperCase() ?? null;
}

export function assessMarketEvidence(listing: RetrievedListing): MarketEvidence {
  const providerCountry = listing.providerCountry.value?.toUpperCase() ?? null;
  const targetDomainCountry = listing.merchantDomain.value ? countryFromDomain(listing.merchantDomain.value) : null;
  const expected = resolveMarketDefinition(listing.retrievalMarket)?.countryCode ?? null;
  const evidence: EvidenceRef[] = [...listing.providerCountry.evidence, ...listing.merchantDomain.evidence];
  if (!expected || (providerCountry && providerCountry !== expected) || (targetDomainCountry && targetDomainCountry !== expected)) {
    return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "CONFLICTED", evidence };
  }
  if (targetDomainCountry === expected) return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "TARGET_DOMAIN_MARKET_CONSISTENT", evidence };
  if (providerCountry === expected) return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "PROVIDER_ATTESTED", evidence };
  return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "UNVERIFIED", evidence };
}

function conditionAllowed(actual: ProductCondition, goal: SearchGoalSnapshot): boolean {
  if (goal.target.conditionPreference === "ANY") return true;
  if (goal.target.conditionPreference === "NEW") return actual === "NEW";
  if (goal.target.conditionPreference === "REFURBISHED") return actual === "REFURBISHED";
  if (goal.target.conditionPreference === "USED") return actual === "USED";
  return actual === "NEW" || actual === "UNKNOWN";
}

function hardConstraintFailure(listing: RetrievedListing, goal: SearchGoalSnapshot): { status: "INELIGIBLE" | "INSUFFICIENT_EVIDENCE"; reasonCode: string } | null {
  const constraints = goal.hardConstraints ?? [];
  if (constraints.length === 0) return null;
  const policy = resolveCategoryValidationPolicy(goal.target.categoryId);
  const evidenceText = [
    listing.title.value,
    ...(listing.categoryPath.value ?? []),
    listing.providerProductType.value,
  ].filter(Boolean).join(" ");
  for (const constraint of constraints) {
    const validationRule = policy?.attributeValidationRules.find((item) => item.key === constraint.key && item.value === constraint.value);
    if (!validationRule || constraint.operator !== "EQ") {
      return { status: "INSUFFICIENT_EVIDENCE", reasonCode: "HARD_CONSTRAINT_VALIDATION_UNSUPPORTED" };
    }
    if (validationPatternMatches(validationRule.negativeSignals, evidenceText)) {
      return { status: "INELIGIBLE", reasonCode: "HARD_CONSTRAINT_CONFLICT" };
    }
    if (!validationPatternMatches(validationRule.positiveSignals, evidenceText)) {
      return { status: "INSUFFICIENT_EVIDENCE", reasonCode: "HARD_CONSTRAINT_EVIDENCE_REQUIRED" };
    }
  }
  return null;
}

export function evaluateListingEligibility(
  listing: RetrievedListing,
  goal: SearchGoalSnapshot,
  fxByCurrency: ReadonlyMap<string, FxSnapshot>,
  semanticSignal?: SemanticRelevanceSignal,
): ListingEligibilityResult {
  const queryProductRelevance = assessQueryProductRelevance({ listing, goal, ...(semanticSignal ? { semanticSignal } : {}) });
  const candidateAdmission = decideCandidateAdmission(queryProductRelevance);
  const reject = (status: ListingEligibilityResult["status"], reasonCode: string): ListingEligibilityResult => ({
    listing,
    status,
    reasonCodes: [reasonCode],
    queryProductRelevance,
    candidateAdmission,
    offer: null,
  });
  if (!candidateAdmission.eligibleForMainRanking) {
    return reject(
      queryProductRelevance.label === "UNRESOLVED" ? "INSUFFICIENT_EVIDENCE" : "INELIGIBLE",
      `QUERY_PRODUCT_${queryProductRelevance.label}`,
    );
  }
  const categoryCapability = resolveCategoryValidationCapability(goal.target.categoryId, goal.target.targetText);
  const ruleValidatedCategory = categoryCapability.validationMode === "RULE_VALIDATED";
  if (goal.excludedOfferRefs.includes(listing.listingRef)) return reject("INELIGIBLE", "USER_EXCLUDED");
  if (!goal.markets.includes(listing.retrievalMarket)) return reject("INELIGIBLE", "MARKET_NOT_REQUESTED");
  if (ruleValidatedCategory && listing.identity.status === "CONFLICTED") return reject("INELIGIBLE", "PRODUCT_IDENTITY_CONFLICT");
  if (ruleValidatedCategory && (listing.identity.status !== "RESOLVED" || !listing.identity.comparisonKey)) {
    return reject("INSUFFICIENT_EVIDENCE", "PRODUCT_IDENTITY_UNRESOLVED");
  }
  if (ruleValidatedCategory) {
    const constraintFailure = hardConstraintFailure(listing, goal);
    if (constraintFailure) return reject(constraintFailure.status, constraintFailure.reasonCode);
  }
  const condition = listing.identity.condition.value ?? "UNKNOWN";
  if (!conditionAllowed(condition, goal)) return reject("INELIGIBLE", "CONDITION_MISMATCH");
  const marketEvidence = assessMarketEvidence(listing);
  if (marketEvidence.level === "CONFLICTED") return reject("INELIGIBLE", "MARKET_EVIDENCE_CONFLICT");
  if (ruleValidatedCategory && marketEvidence.level === "UNVERIFIED") return reject("INSUFFICIENT_EVIDENCE", "MARKET_EVIDENCE_REQUIRED");
  if (listing.stock.value === "OUT_OF_STOCK" && goal.stockPreference === "KNOWN_IN_STOCK") return reject("INELIGIBLE", "CONFIRMED_OUT_OF_STOCK");
  const money = listing.originalMoney.value;
  const title = listing.title.value;
  const merchant = listing.merchantLabel.value;
  const merchantDomain = listing.merchantDomain.value;
  const outboundUrl = listing.outboundUrl.value;
  if (!money || !title || !merchant || !merchantDomain || !outboundUrl) return reject("INSUFFICIENT_EVIDENCE", "COMMERCIAL_FACTS_REQUIRED");
  const fx = fxByCurrency.get(money.currency);
  if (!fx) return reject("INSUFFICIENT_EVIDENCE", "FX_EVIDENCE_REQUIRED");
  const cnyAmount = convertToCny(money, fx);
  if (goal.budgetCny !== null && compareDecimal(cnyAmount, goal.budgetCny) > 0) return reject("INELIGIBLE", "OVER_BUDGET");
  const validationMode = categoryCapability.validationMode;
  const productIdentity = ruleValidatedCategory
    ? listing.identity
    : { ...listing.identity, status: "UNRESOLVED" as const, comparisonKey: null };
  const ranking = buildCandidateRankingMetadata({
    listing,
    goal,
    validationMode,
    marketEvidence,
    stock: listing.stock.value ?? "UNKNOWN",
    cnyAmount,
    hasUnverifiedHardConstraints: !ruleValidatedCategory && (goal.hardConstraints?.length ?? 0) > 0,
  });
  const eligibilityStatus = ruleValidatedCategory ? "COMPARABLE" as const : "DISCOVERABLE" as const;
  const reasonCodes = [
    ruleValidatedCategory ? "PRODUCT_IDENTITY_RESOLVED" : "OFFER_IDENTITY_ONLY",
    validationMode,
    marketEvidence.level,
    ...(!ruleValidatedCategory && (goal.hardConstraints?.length ?? 0) > 0 ? ["HARD_CONSTRAINTS_UNVERIFIED"] : []),
    ...(goal.budgetCny !== null ? ["WITHIN_BUDGET"] : []),
    ...(listing.stock.value === "UNKNOWN" ? ["STOCK_UNKNOWN"] : []),
    ...(condition === "UNKNOWN" ? ["CONDITION_UNKNOWN"] : []),
  ];
  const evidenceRefs = [...listing.title.evidence, ...listing.originalMoney.evidence, ...listing.merchantTargetUrl.evidence, ...listing.providerCountry.evidence, ...listing.identity.categoryId.evidence];
  const offer: ComparableOffer = {
    offerRef: listing.listingRef,
    listingRef: listing.listingRef,
    provider: listing.provider,
    productIdentity,
    targetCategoryId: goal.target.categoryId,
    title,
    originalMoney: money,
    cnyEstimate: { amount: cnyAmount, fxSnapshotId: fx.id },
    retrievalMarket: listing.retrievalMarket,
    marketEvidence,
    merchant,
    merchantDomain,
    outboundUrl,
    stock: listing.stock.value ?? "UNKNOWN",
    condition,
    observedAt: listing.observedAt,
    validationMode,
    ranking,
    queryProductRelevance,
    candidateAdmission,
    evidenceRefs,
    eligibility: { status: eligibilityStatus, policyVersion: "source-grounding-v3", reasonCodes },
  };
  return {
    listing,
    status: eligibilityStatus,
    reasonCodes,
    queryProductRelevance,
    candidateAdmission,
    offer,
  };
}

function compareComparableOffers(left: ComparableOffer, right: ComparableOffer): number {
    const vectorOrder = compareCandidateRankVectors(left.ranking.rankVector, right.ranking.rankVector);
    if (vectorOrder !== 0) return vectorOrder;
    const freshnessOrder = right.observedAt.localeCompare(left.observedAt);
    return freshnessOrder !== 0 ? freshnessOrder : left.offerRef.localeCompare(right.offerRef);
}

function normalizedMerchantDomain(domain: string): string {
  return domain.normalize("NFKC").toLocaleLowerCase("en-US").replace(/^www\./, "").replace(/\.$/, "");
}

function merchantProductKey(offer: ComparableOffer): string {
  return [offer.productIdentity.comparisonKey ?? `OFFER:${offer.offerRef}`, offer.retrievalMarket, normalizedMerchantDomain(offer.merchantDomain)].join("|");
}

function deduplicateMerchantProductOffers(eligibilityResults: ListingEligibilityResult[]): ListingEligibilityResult[] {
  const comparable = eligibilityResults.filter((result): result is ListingEligibilityResult & { offer: ComparableOffer } => result.offer !== null);
  const winnerByKey = new Map<string, ListingEligibilityResult & { offer: ComparableOffer }>();
  for (const result of comparable) {
    const key = merchantProductKey(result.offer);
    const current = winnerByKey.get(key);
    if (!current) {
      winnerByKey.set(key, result);
      continue;
    }
    if (compareComparableOffers(result.offer, current.offer) < 0) winnerByKey.set(key, result);
  }
  return eligibilityResults.map((result): ListingEligibilityResult => {
    if (!result.offer || winnerByKey.get(merchantProductKey(result.offer)) === result) return result;
    return { ...result, status: "INELIGIBLE", reasonCodes: ["DUPLICATE_MERCHANT_PRODUCT_OFFER"], offer: null };
  });
}

function rankComparableOffers(offers: ComparableOffer[]): RankedComparableOffer[] {
  const sorted = [...offers].sort(compareComparableOffers);
  return sorted.map((offer, index) => ({
    offer,
    rank: index + 1,
    rankVector: offer.ranking.rankVector,
    rankingReasonCodes: [
      offer.validationMode,
      offer.marketEvidence.level,
      `ESCI_${offer.queryProductRelevance.label}`,
      offer.stock === "IN_STOCK" ? "KNOWN_IN_STOCK" : "STOCK_NOT_CONFIRMED",
      "LEXICOGRAPHIC_RANK_VECTOR_V1",
    ],
  }));
}

export function buildRankedOfferSet(
  listings: RetrievedListing[],
  goal: SearchGoalSnapshot,
  fxByCurrency: ReadonlyMap<string, FxSnapshot>,
  semanticSignals: ReadonlyMap<string, SemanticRelevanceSignal> = new Map(),
): RankedOfferSet {
  const eligibilityResults = listings.map((listing) => evaluateListingEligibility(listing, goal, fxByCurrency, semanticSignals.get(listing.listingRef)));
  const comparableKeys = [...new Set(eligibilityResults.flatMap((result) => result.offer?.productIdentity.comparisonKey ? [result.offer.productIdentity.comparisonKey] : []))];
  const conditionPriority = goal.target.conditionPreference === "NEW_OR_UNSPECIFIED"
    ? ["NEW", "UNKNOWN"]
    : goal.target.conditionPreference === "ANY"
      ? ["NEW", "UNKNOWN", "REFURBISHED", "USED"]
      : [goal.target.conditionPreference];
  const selectedKey = conditionPriority
    .flatMap((condition) => comparableKeys.filter((key) => key.endsWith(`:${condition}`)).sort())
    [0] ?? comparableKeys.sort()[0] ?? null;
  const homogeneousEligibilityResults = goal.target.canonicalModel === null
    ? eligibilityResults
    : eligibilityResults.map((result): ListingEligibilityResult => {
      if (!result.offer || result.offer.productIdentity.comparisonKey === selectedKey) return result;
      return { ...result, status: "INELIGIBLE", reasonCodes: ["COMPARISON_KEY_MISMATCH"], offer: null };
    });
  const normalizedEligibilityResults = deduplicateMerchantProductOffers(homogeneousEligibilityResults);
  return {
    policyVersion: "source-grounding-v3",
    eligibilityResults: normalizedEligibilityResults,
    rankedOffers: rankComparableOffers(normalizedEligibilityResults.flatMap((result) => result.offer ? [result.offer] : [])),
  };
}

export function decideRankedOfferSet(rankedOfferSet: RankedOfferSet, clarificationRequired = false): ValidatedDecision {
  if (clarificationRequired) {
    return { mode: "CLARIFICATION", primaryOffer: null, alternatives: [], comparedOffers: [], reasonCodes: ["PRODUCT_TARGET_REQUIRED"], disclosureCodes: [], clarificationCode: "PRODUCT_TARGET_REQUIRED" };
  }
  if (rankedOfferSet.rankedOffers.length === 0) {
    return { mode: "NO_MATCH", primaryOffer: null, alternatives: [], comparedOffers: [], reasonCodes: ["NO_GROUNDED_OFFERS"], disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"], clarificationCode: null };
  }
  const selected = rankedOfferSet.rankedOffers.slice(0, 3);
  const disclosures = new Set(["FX_ESTIMATE", "EXCLUDES_TAX_SHIPPING_PAYMENT", "MERCHANT_CHECKOUT_FINAL"]);
  if (selected.some((item) => item.offer.marketEvidence.level === "PROVIDER_ATTESTED")) disclosures.add("INDEX_MARKET_NOT_DELIVERY_VERIFIED");
  if (selected.some((item) => item.offer.stock === "UNKNOWN")) disclosures.add("STOCK_UNKNOWN");
  if (selected.some((item) => item.offer.condition === "UNKNOWN")) disclosures.add("CONDITION_UNKNOWN");
  return {
    mode: "RECOMMENDATION",
    primaryOffer: selected[0]!,
    alternatives: selected.slice(1),
    comparedOffers: selected,
    reasonCodes: ["SOURCE_GROUNDED_COMPARISON_V1", "DETERMINISTIC_RANKING"],
    disclosureCodes: [...disclosures],
    clarificationCode: null,
  };
}
