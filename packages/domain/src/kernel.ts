import { compareDecimal, convertToCny } from "./money.js";
import { contractPatternMatches, resolveCategoryContract, resolveMarketContract } from "./catalog-contracts.js";
import { resolveCategoryRecommendationCapability } from "./category-capability.js";
import { buildCandidateDiscoveryMetadata, compareCandidateRankVectors } from "./discovery-ranking.js";
import type { ComparableOffer, ComparisonSet, DiscoveredListing, EvidenceRef, FxSnapshot, Goal, Market, MarketEvidence, ProductCondition, QualificationResult, RankedComparableOffer, ValidatedDecision } from "./types.js";

const COUNTRY_TLD = /\.([a-z]{2})$/i;

function countryFromDomain(domain: string): string | null {
  return domain.match(COUNTRY_TLD)?.[1]?.toUpperCase() ?? null;
}

export function assessMarketEvidence(listing: DiscoveredListing): MarketEvidence {
  const providerCountry = listing.providerCountry.value?.toUpperCase() ?? null;
  const targetDomainCountry = listing.merchantDomain.value ? countryFromDomain(listing.merchantDomain.value) : null;
  const expected = resolveMarketContract(listing.retrievalMarket)?.countryCode ?? null;
  const evidence: EvidenceRef[] = [...listing.providerCountry.evidence, ...listing.merchantDomain.evidence];
  if (!expected || (providerCountry && providerCountry !== expected) || (targetDomainCountry && targetDomainCountry !== expected)) {
    return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "CONFLICTED", evidence };
  }
  if (targetDomainCountry === expected) return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "TARGET_DOMAIN_MARKET_CONSISTENT", evidence };
  if (providerCountry === expected) return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "PROVIDER_ATTESTED", evidence };
  return { retrievalMarket: listing.retrievalMarket, providerCountry, targetDomainCountry, level: "UNVERIFIED", evidence };
}

function conditionAllowed(actual: ProductCondition, goal: Goal): boolean {
  if (goal.target.conditionPreference === "ANY") return true;
  if (goal.target.conditionPreference === "NEW") return actual === "NEW";
  if (goal.target.conditionPreference === "REFURBISHED") return actual === "REFURBISHED";
  if (goal.target.conditionPreference === "USED") return actual === "USED";
  return actual === "NEW" || actual === "UNKNOWN";
}

function hardConstraintFailure(listing: DiscoveredListing, goal: Goal): { status: "INELIGIBLE" | "INSUFFICIENT_EVIDENCE"; reasonCode: string } | null {
  const constraints = goal.hardConstraints ?? [];
  if (constraints.length === 0) return null;
  const contract = resolveCategoryContract(goal.target.categoryId);
  const evidenceText = [
    listing.title.value,
    ...(listing.categoryPath.value ?? []),
    listing.providerProductType.value,
  ].filter(Boolean).join(" ");
  for (const constraint of constraints) {
    const proof = contract?.attributeProofs.find((item) => item.key === constraint.key && item.value === constraint.value);
    if (!proof || constraint.operator !== "EQ") {
      return { status: "INSUFFICIENT_EVIDENCE", reasonCode: "HARD_CONSTRAINT_PROOF_UNSUPPORTED" };
    }
    if (contractPatternMatches(proof.negativeSignals, evidenceText)) {
      return { status: "INELIGIBLE", reasonCode: "HARD_CONSTRAINT_CONFLICT" };
    }
    if (!contractPatternMatches(proof.positiveSignals, evidenceText)) {
      return { status: "INSUFFICIENT_EVIDENCE", reasonCode: "HARD_CONSTRAINT_EVIDENCE_REQUIRED" };
    }
  }
  return null;
}

export function qualifyListing(listing: DiscoveredListing, goal: Goal, fxByCurrency: ReadonlyMap<string, FxSnapshot>): QualificationResult {
  const reject = (status: QualificationResult["status"], reasonCode: string): QualificationResult => ({ listing, status, reasonCodes: [reasonCode], offer: null });
  const categoryCapability = resolveCategoryRecommendationCapability(goal.target.categoryId, goal.target.targetText);
  const verifiedCategory = categoryCapability.supportLevel === "VERIFIED";
  if (goal.excludedOfferRefs.includes(listing.listingRef)) return reject("INELIGIBLE", "USER_EXCLUDED");
  if (!goal.markets.includes(listing.retrievalMarket)) return reject("INELIGIBLE", "MARKET_NOT_REQUESTED");
  if (verifiedCategory && listing.identity.status === "CONFLICTED") return reject("INELIGIBLE", "PRODUCT_IDENTITY_CONFLICT");
  if (verifiedCategory && (listing.identity.status !== "RESOLVED" || !listing.identity.comparisonKey)) {
    return reject("INSUFFICIENT_EVIDENCE", "PRODUCT_IDENTITY_UNRESOLVED");
  }
  if (verifiedCategory) {
    const constraintFailure = hardConstraintFailure(listing, goal);
    if (constraintFailure) return reject(constraintFailure.status, constraintFailure.reasonCode);
  }
  const condition = listing.identity.condition.value ?? "UNKNOWN";
  if (!conditionAllowed(condition, goal)) return reject("INELIGIBLE", "CONDITION_MISMATCH");
  const marketEvidence = assessMarketEvidence(listing);
  if (marketEvidence.level === "CONFLICTED") return reject("INELIGIBLE", "MARKET_EVIDENCE_CONFLICT");
  if (verifiedCategory && marketEvidence.level === "UNVERIFIED") return reject("INSUFFICIENT_EVIDENCE", "MARKET_EVIDENCE_REQUIRED");
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
  const supportLevel = categoryCapability.supportLevel;
  const productIdentity = verifiedCategory
    ? listing.identity
    : { ...listing.identity, status: "UNRESOLVED" as const, comparisonKey: null };
  const discovery = buildCandidateDiscoveryMetadata({
    listing,
    goal,
    supportLevel,
    marketEvidence,
    stock: listing.stock.value ?? "UNKNOWN",
    cnyAmount,
    hasUnverifiedHardConstraints: !verifiedCategory && (goal.hardConstraints?.length ?? 0) > 0,
  });
  const qualificationStatus = verifiedCategory ? "COMPARABLE" as const : "DISCOVERABLE" as const;
  const reasonCodes = [
    verifiedCategory ? "PRODUCT_IDENTITY_RESOLVED" : "OFFER_IDENTITY_ONLY",
    supportLevel,
    marketEvidence.level,
    ...(!verifiedCategory && (goal.hardConstraints?.length ?? 0) > 0 ? ["HARD_CONSTRAINTS_UNVERIFIED"] : []),
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
    supportLevel,
    discovery,
    evidenceRefs,
    qualification: { status: qualificationStatus, policyVersion: "proof-carrying-v2", reasonCodes },
  };
  return { listing, status: qualificationStatus, reasonCodes, offer };
}

function compareComparableOffers(left: ComparableOffer, right: ComparableOffer): number {
    const vectorOrder = compareCandidateRankVectors(left.discovery.rankVector, right.discovery.rankVector);
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

function deduplicateMerchantProductOffers(qualifications: QualificationResult[]): QualificationResult[] {
  const comparable = qualifications.filter((result): result is QualificationResult & { offer: ComparableOffer } => result.offer !== null);
  const winnerByKey = new Map<string, QualificationResult & { offer: ComparableOffer }>();
  for (const result of comparable) {
    const key = merchantProductKey(result.offer);
    const current = winnerByKey.get(key);
    if (!current) {
      winnerByKey.set(key, result);
      continue;
    }
    if (compareComparableOffers(result.offer, current.offer) < 0) winnerByKey.set(key, result);
  }
  return qualifications.map((result): QualificationResult => {
    if (!result.offer || winnerByKey.get(merchantProductKey(result.offer)) === result) return result;
    return { listing: result.listing, status: "INELIGIBLE", reasonCodes: ["DUPLICATE_MERCHANT_PRODUCT_OFFER"], offer: null };
  });
}

function rankComparableOffers(offers: ComparableOffer[]): RankedComparableOffer[] {
  const sorted = [...offers].sort(compareComparableOffers);
  return sorted.map((offer, index) => ({
    offer,
    rank: index + 1,
    rankVector: offer.discovery.rankVector,
    rankingReasonCodes: [
      offer.supportLevel,
      offer.marketEvidence.level,
      offer.stock === "IN_STOCK" ? "KNOWN_IN_STOCK" : "STOCK_NOT_CONFIRMED",
      "LEXICOGRAPHIC_RANK_VECTOR_V1",
    ],
  }));
}

export function buildComparisonSet(listings: DiscoveredListing[], goal: Goal, fxByCurrency: ReadonlyMap<string, FxSnapshot>): ComparisonSet {
  const qualifications = listings.map((listing) => qualifyListing(listing, goal, fxByCurrency));
  const comparableKeys = [...new Set(qualifications.flatMap((result) => result.offer?.productIdentity.comparisonKey ? [result.offer.productIdentity.comparisonKey] : []))];
  const conditionPriority = goal.target.conditionPreference === "NEW_OR_UNSPECIFIED"
    ? ["NEW", "UNKNOWN"]
    : goal.target.conditionPreference === "ANY"
      ? ["NEW", "UNKNOWN", "REFURBISHED", "USED"]
      : [goal.target.conditionPreference];
  const selectedKey = conditionPriority
    .flatMap((condition) => comparableKeys.filter((key) => key.endsWith(`:${condition}`)).sort())
    [0] ?? comparableKeys.sort()[0] ?? null;
  const homogeneousQualifications = goal.target.canonicalModel === null
    ? qualifications
    : qualifications.map((result): QualificationResult => {
      if (!result.offer || result.offer.productIdentity.comparisonKey === selectedKey) return result;
      return { listing: result.listing, status: "INELIGIBLE", reasonCodes: ["COMPARISON_KEY_MISMATCH"], offer: null };
    });
  const normalizedQualifications = deduplicateMerchantProductOffers(homogeneousQualifications);
  return {
    policyVersion: "proof-carrying-v2",
    qualifications: normalizedQualifications,
    rankedOffers: rankComparableOffers(normalizedQualifications.flatMap((result) => result.offer ? [result.offer] : [])),
  };
}

export function decideComparisonSet(comparisonSet: ComparisonSet, clarificationRequired = false): ValidatedDecision {
  if (clarificationRequired) {
    return { mode: "CLARIFICATION", primaryOffer: null, alternatives: [], comparedOffers: [], reasonCodes: ["PRODUCT_TARGET_REQUIRED"], disclosureCodes: [], clarificationCode: "PRODUCT_TARGET_REQUIRED" };
  }
  if (comparisonSet.rankedOffers.length === 0) {
    return { mode: "NO_MATCH", primaryOffer: null, alternatives: [], comparedOffers: [], reasonCodes: ["NO_PROOF_CARRYING_OFFERS"], disclosureCodes: ["UNVERIFIED_RESULTS_NOT_RECOMMENDED"], clarificationCode: null };
  }
  const selected = comparisonSet.rankedOffers.slice(0, 3);
  const disclosures = new Set(["FX_ESTIMATE", "EXCLUDES_TAX_SHIPPING_PAYMENT", "MERCHANT_CHECKOUT_FINAL"]);
  if (selected.some((item) => item.offer.marketEvidence.level === "PROVIDER_ATTESTED")) disclosures.add("INDEX_MARKET_NOT_DELIVERY_VERIFIED");
  if (selected.some((item) => item.offer.stock === "UNKNOWN")) disclosures.add("STOCK_UNKNOWN");
  if (selected.some((item) => item.offer.condition === "UNKNOWN")) disclosures.add("CONDITION_UNKNOWN");
  return {
    mode: "RECOMMENDATION",
    primaryOffer: selected[0]!,
    alternatives: selected.slice(1),
    comparedOffers: selected,
    reasonCodes: ["PROOF_CARRYING_COMPARISON_V1", "DETERMINISTIC_RANKING"],
    disclosureCodes: [...disclosures],
    clarificationCode: null,
  };
}
