export type QueryProductRelevanceLabel = "EXACT" | "SUBSTITUTE" | "COMPLEMENT" | "IRRELEVANT" | "UNRESOLVED";

export type QueryProductRelevanceEvidenceSource =
  | "PROVIDER_PRODUCT_TYPE"
  | "CATEGORY_PATH"
  | "PRODUCT_IDENTITY"
  | "TITLE"
  | "SEMANTIC_MODEL";

export interface QueryProductRelevanceEvidence {
  source: QueryProductRelevanceEvidenceSource;
  value: unknown;
  supports: QueryProductRelevanceLabel;
}

export interface QueryProductRelevanceAssessment {
  label: QueryProductRelevanceLabel;
  policyVersion: "esci-admission-v2";
  reasonCodes: string[];
  evidence: QueryProductRelevanceEvidence[];
}

export type CandidateAdmissionCohort =
  | "MAIN_RECOMMENDATION"
  | "ALTERNATIVE_COHORT"
  | "RELATED_COHORT"
  | "INELIGIBLE"
  | "INSUFFICIENT_EVIDENCE";

export interface CandidateAdmissionDecision {
  cohort: CandidateAdmissionCohort;
  eligibleForMainRanking: boolean;
  policyVersion: "esci-admission-v2";
  reasonCodes: string[];
}

export interface SemanticRelevanceSignal {
  label: Exclude<QueryProductRelevanceLabel, "UNRESOLVED">;
  confidence: number;
  modelId: string;
}
