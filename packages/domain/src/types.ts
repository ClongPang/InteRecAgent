import type { MarketId } from "./catalog-contracts.js";
import type { CandidateDiscoveryMetadata, RecommendationSupportLevel } from "./discovery.js";

export type Market = MarketId;
export type StockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
export type EvidenceStatus = "OBSERVED" | "DERIVED" | "VERIFIED" | "UNKNOWN" | "CONFLICTED" | "EXPIRED";

export interface EvidenceRef {
  artifactRef: string;
  jsonPath: string;
  source: string;
  observedAt: string;
}

export interface Fact<T> {
  value: T | null;
  status: EvidenceStatus;
  evidence: EvidenceRef[];
}

export type ItemRole = "PRIMARY_PRODUCT" | "ACCESSORY" | "REPLACEMENT_PART" | "BUNDLE" | "SERVICE" | "UNKNOWN";
export type ProductCondition = "NEW" | "REFURBISHED" | "USED" | "UNKNOWN";

export interface ProductTarget {
  categoryId: string;
  targetText?: string;
  canonicalModel: string | null;
  itemRole: ItemRole;
  conditionPreference: "NEW" | "NEW_OR_UNSPECIFIED" | "REFURBISHED" | "USED" | "ANY";
}

export interface Goal {
  query: string;
  target: ProductTarget;
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
  categoryId: Fact<string>;
  canonicalModel: Fact<string>;
  itemRole: Fact<ItemRole>;
  condition: Fact<ProductCondition>;
  comparisonKey: string | null;
  status: "RESOLVED" | "UNRESOLVED" | "CONFLICTED";
}

export interface DiscoveredListing {
  listingRef: string;
  provider: "buywhere";
  providerListingId: string;
  retrievalMarket: Market;
  title: Fact<string>;
  originalMoney: Fact<Money>;
  merchantLabel: Fact<string>;
  merchantTargetUrl: Fact<string>;
  merchantDomain: Fact<string>;
  outboundUrl: Fact<string>;
  providerCountry: Fact<string>;
  categoryPath: Fact<string[]>;
  providerProductType: Fact<string>;
  stock: Fact<StockStatus>;
  identity: ProductIdentity;
  imageUrl: Fact<string>;
  sourceUpdatedAt: Fact<string>;
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
  /** Goal category hint; distinct from a verified item identity. */
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
  supportLevel: RecommendationSupportLevel;
  discovery: CandidateDiscoveryMetadata;
  evidenceRefs: EvidenceRef[];
  qualification: {
    status: "COMPARABLE" | "DISCOVERABLE";
    policyVersion: "proof-carrying-v1" | "proof-carrying-v2";
    reasonCodes: string[];
  };
}

export interface QualificationResult {
  listing: DiscoveredListing;
  status: "COMPARABLE" | "DISCOVERABLE" | "INELIGIBLE" | "INSUFFICIENT_EVIDENCE";
  reasonCodes: string[];
  offer: ComparableOffer | null;
}

export interface RankedComparableOffer {
  offer: ComparableOffer;
  rank: number;
  rankingReasonCodes: string[];
  rankVector: CandidateDiscoveryMetadata["rankVector"];
}

export interface ComparisonSet {
  policyVersion: "proof-carrying-v1" | "proof-carrying-v2";
  qualifications: QualificationResult[];
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
  target: ProductTarget;
  observedAt: string;
  rawArtifactRef: string;
  jsonPathPrefix?: string;
}
