import type { FxSnapshot, Money, ProductCondition } from "./quote-base-types.js";
import type { QuoteTargetIdentityBinding } from "./product-identity.js";

export const QUOTE_LEAD_CONTRACT_VERSION = "quote-leads-sg-v1" as const;
export const QUOTE_ADMISSION_POLICY_VERSION = "quote-admission-v2" as const;
export const QUOTE_GROUPING_POLICY_VERSION = "merchant-page-condition-v1" as const;
export const MERCHANT_PAGE_CONFIRMATION = "MERCHANT_PAGE_CHECK_REQUIRED" as const;

export type QuoteConditionPreference = "NEW" | "NEW_OR_UNSPECIFIED" | "REFURBISHED" | "USED" | "ANY";

export interface QuoteTarget {
  targetRef: string;
  rawText: string;
  brand: string | null;
  canonicalModel: string;
  modelKey: string;
  productType: string | null;
  requiredQualifiers: string[];
  itemRole: "PRIMARY_PRODUCT";
  conditionPreference: QuoteConditionPreference;
  canonicalQuery: string;
  confirmation: "LEXICALLY_GROUNDED" | "EXPLICITLY_CONFIRMED";
  normalizationChanges: string[];
  identity: QuoteTargetIdentityBinding;
}

export type QuoteTargetResolution =
  | {
      status: "RESOLVED";
      target: QuoteTarget;
      reasonCodes: [];
      normalizationChanges: string[];
    }
  | {
      status: "NEEDS_CONFIRMATION";
      target: null;
      reasonCodes: string[];
      normalizationChanges: string[];
    };

export interface QuoteObservation {
  observationRef: string;
  provider: "buywhere";
  providerRecordId: string | null;
  recordIndex: number;
  jsonPath: string;
  artifactRef: string;
  observedAt: string;
  title: string | null;
  originalMoney: Money | null;
  merchantLabel: string | null;
  merchantTargetUrl: string | null;
  merchantDomain: string | null;
  outboundUrl: string | null;
  imageUrl: string | null;
  providerCountry: string | null;
  providerUpdatedAt: string | null;
  providerAvailability: unknown;
  condition: ProductCondition;
  identitySignals: {
    brand: { value: string; jsonPath: string } | null;
    model: { value: string; jsonPath: string } | null;
    identifiers: Array<{ scheme: "GTIN" | "BRAND_MPN"; value: string; jsonPath: string }>;
  };
  rawRecord: Record<string, unknown>;
}

export type QuoteAdmissionStatus = "ELIGIBLE" | "REJECTED" | "INSUFFICIENT_EVIDENCE";

export interface QuoteAdmissionDecision {
  observationRef: string;
  status: QuoteAdmissionStatus;
  reasonCodes: string[];
  policyVersion: typeof QUOTE_ADMISSION_POLICY_VERSION;
  identityStrength: "STRONG_IDENTIFIER_MATCH" | "CURATED_TITLE_ALIAS_MATCH" | "EXACT_LEXICAL_MATCH" | "PROBABILISTIC_CANDIDATE" | "IDENTITY_OR_ROLE_CONFLICT";
  identityEvidenceRefs: string[];
}

export interface QuoteCnyEstimate {
  minAmount: string;
  maxAmount: string;
  fxSnapshotId: string;
  fxObservedAt: string;
  fxExpiresAt: string;
}

export interface QuotePriceRange {
  currency: string;
  minAmount: string;
  maxAmount: string;
  observationRefs: string[];
  cnyEstimate: QuoteCnyEstimate | null;
}

export interface QuoteLead {
  quoteLeadRef: string;
  targetRef: string;
  canonicalModel: string;
  representativeTitle: string;
  condition: ProductCondition;
  merchantLabel: string;
  merchantDomain: string;
  merchantTargetUrl: string;
  outboundUrl: string;
  priceRanges: QuotePriceRange[];
  observationRefs: string[];
  observationCount: number;
  firstObservedAt: string;
  latestObservedAt: string;
  latestProviderUpdatedAt: string | null;
  disclosureCode: typeof MERCHANT_PAGE_CONFIRMATION;
  groupingPolicyVersion: typeof QUOTE_GROUPING_POLICY_VERSION;
  admissionPolicyVersion: typeof QUOTE_ADMISSION_POLICY_VERSION;
  identityStrength: Exclude<QuoteAdmissionDecision["identityStrength"], "PROBABILISTIC_CANDIDATE" | "IDENTITY_OR_ROLE_CONFLICT">;
  identityEvidenceRefs: string[];
}

export type QuoteLeadSetOutcome = "QUOTE_LEADS" | "NO_QUOTE_LEADS" | "DEGRADED";

export interface QuoteProviderSummary {
  status: "OK_RESULTS" | "OK_EMPTY" | "DEGRADED" | "FAILED";
  failureCode: string | null;
  retryable: boolean | null;
  contractVersion: string;
  meta: Record<string, unknown>;
}

export interface QuoteLeadSet {
  contractVersion: typeof QUOTE_LEAD_CONTRACT_VERSION;
  quoteLeadSetRef: string;
  target: QuoteTarget;
  outcome: QuoteLeadSetOutcome;
  reasonCodes: string[];
  provider: QuoteProviderSummary;
  observations: QuoteObservation[];
  admissions: QuoteAdmissionDecision[];
  leads: QuoteLead[];
  fxSnapshots: FxSnapshot[];
  observedAt: string;
}
