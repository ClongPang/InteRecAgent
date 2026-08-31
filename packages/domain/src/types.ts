import type { MarketId } from "./catalog-validation-policies.js";
import type { CandidateRankingMetadata, CategoryValidationMode } from "./candidate-ranking-types.js";
import type { CandidateAdmissionDecision, QueryProductRelevanceAssessment } from "./query-product-relevance-types.js";

export type Market = MarketId;
export type StockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
export type SourceValueStatus = "OBSERVED" | "DERIVED" | "UNKNOWN" | "CONFLICTED" | "EXPIRED";

export interface EvidenceRef {
  artifactRef: string;
  jsonPath: string;
  source: string;
  observedAt: string;
}

export interface SourcedValue<T> {
  value: T | null;
  status: SourceValueStatus;
  evidence: EvidenceRef[];
}

export type ItemRole = "PRIMARY_PRODUCT" | "ACCESSORY" | "REPLACEMENT_PART" | "BUNDLE" | "SERVICE" | "UNKNOWN";
export type ProductCondition = "NEW" | "REFURBISHED" | "USED" | "UNKNOWN";

export interface SearchTargetSnapshot {
  categoryId: string;
  targetText?: string;
  canonicalModel: string | null;
  itemRole: ItemRole;
  conditionPreference: "NEW" | "NEW_OR_UNSPECIFIED" | "REFURBISHED" | "USED" | "ANY";
}

export interface SearchGoalSnapshot {
  query: string;
  target: SearchTargetSnapshot;
  markets: Market[];
  budgetCny: string | null;
  stockPreference: "ANY" | "KNOWN_IN_STOCK";
  excludedOfferRefs: string[];
  hardConstraints?: Array<{
    key: string;
    operator: "EQ" | "IN" | "LTE" | "GTE" | "CONTAINS";
    value: string | number | boolean | string[];
  }>;
  preferenceHints?: Array<{
    key: string;
    value: string | number | boolean | string[];
    weight: number;
  }>;
}

export interface Money {
  amount: string;
  currency: string;
}

export interface FxSnapshot {
  id: string;
  base: string;
  quote: "CNY";
  rate: string;
  provider: string;
  observedAt: string;
  expiresAt: string;
}

export interface ProductIdentity {
  categoryId: SourcedValue<string>;
  canonicalModel: SourcedValue<string>;
  itemRole: SourcedValue<ItemRole>;
  condition: SourcedValue<ProductCondition>;
  comparisonKey: string | null;
  status: "RESOLVED" | "UNRESOLVED" | "CONFLICTED";
}

export interface RetrievedListing {
  listingRef: string;
  provider: "buywhere";
  providerListingId: string;
  retrievalMarket: Market;
  title: SourcedValue<string>;
  originalMoney: SourcedValue<Money>;
  merchantLabel: SourcedValue<string>;
  merchantTargetUrl: SourcedValue<string>;
  merchantDomain: SourcedValue<string>;
  outboundUrl: SourcedValue<string>;
  providerCountry: SourcedValue<string>;
  categoryPath: SourcedValue<string[]>;
  providerProductType: SourcedValue<string>;
  stock: SourcedValue<StockStatus>;
  identity: ProductIdentity;
  imageUrl: SourcedValue<string>;
  sourceUpdatedAt: SourcedValue<string>;
  observedAt: string;
  rawArtifactRef: string;
}

export type MarketEvidenceLevel = "TARGET_DOMAIN_MARKET_CONSISTENT" | "PROVIDER_ATTESTED" | "UNVERIFIED" | "CONFLICTED";

export interface MarketEvidence {
  retrievalMarket: Market;
  providerCountry: string | null;
  targetDomainCountry: string | null;
  level: MarketEvidenceLevel;
  evidence: EvidenceRef[];
}

export interface ComparableOffer {
  offerRef: string;
  listingRef: string;
  provider: "buywhere";
  productIdentity: ProductIdentity;
  /** Shopping-goal category hint; distinct from a rule-resolved product identity. */
  targetCategoryId: string;
  title: string;
  originalMoney: Money;
  cnyEstimate: { amount: string; fxSnapshotId: string };
  retrievalMarket: Market;
  marketEvidence: MarketEvidence;
  merchant: string;
  merchantDomain: string;
  outboundUrl: string;
  stock: StockStatus;
  condition: ProductCondition;
  observedAt: string;
  validationMode: CategoryValidationMode;
  ranking: CandidateRankingMetadata;
  queryProductRelevance: QueryProductRelevanceAssessment;
  candidateAdmission: CandidateAdmissionDecision;
  evidenceRefs: EvidenceRef[];
  eligibility: {
    status: "COMPARABLE" | "DISCOVERABLE";
    policyVersion: "source-grounding-v1" | "source-grounding-v2" | "source-grounding-v3";
    reasonCodes: string[];
  };
}

export interface ListingEligibilityResult {
  listing: RetrievedListing;
  status: "COMPARABLE" | "DISCOVERABLE" | "INELIGIBLE" | "INSUFFICIENT_EVIDENCE";
  reasonCodes: string[];
  queryProductRelevance: QueryProductRelevanceAssessment;
  candidateAdmission: CandidateAdmissionDecision;
  offer: ComparableOffer | null;
}

export interface RankedComparableOffer {
  offer: ComparableOffer;
  rank: number;
  rankingReasonCodes: string[];
  rankVector: CandidateRankingMetadata["rankVector"];
}

export interface RankedOfferSet {
  policyVersion: "source-grounding-v1" | "source-grounding-v2" | "source-grounding-v3";
  eligibilityResults: ListingEligibilityResult[];
  rankedOffers: RankedComparableOffer[];
}

export type DecisionMode = "RECOMMENDATION" | "CLARIFICATION" | "NO_MATCH" | "FAILED";

export interface ValidatedDecision {
  mode: DecisionMode;
  primaryOffer: RankedComparableOffer | null;
  alternatives: RankedComparableOffer[];
  comparedOffers: RankedComparableOffer[];
  reasonCodes: string[];
  disclosureCodes: string[];
  clarificationCode: string | null;
}

export interface BuyWhereRawProduct {
  id?: unknown;
  title?: unknown;
  price?: { amount?: unknown; currency?: unknown } | null;
  merchant?: unknown;
  url?: unknown;
  click_url?: unknown;
  image_url?: unknown;
  country_code?: unknown;
  category_path?: unknown;
  updated_at?: unknown;
  availability?: unknown;
  metadata?: unknown;
}

export interface ListingIngestionContext {
  retrievalMarket: Market;
  target: SearchTargetSnapshot;
  observedAt: string;
  rawArtifactRef: string;
  jsonPathPrefix?: string;
}
