export type TaskType =
  | "single_item_recommendation"
  | "negative_feedback"
  | "alternative_recommendation"
  | "comparison"
  | "gift_recommendation"
  | "bundle_recommendation"
  | "unsupported";

export type ChatTurnStatus =
  | "clarification_required"
  | "recommendations_ready"
  | "unsupported"
  | "partial_support"
  | "error";

export type ConstraintStatus = "satisfied" | "violated" | "unknown";

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
}

export interface Budget {
  max: number | null;
  currency: string;
}

export interface Constraint {
  field: string;
  op: string;
  value: unknown;
}

export interface FeedbackRecord {
  turn_id: string;
  feedback_text: string;
  feedback_type?: string | null;
  anchor_product_id?: string | null;
}

export interface IntentState {
  task_type: TaskType;
  category: string;
  goal: string;
  scenario: string;
  budget: Budget | null;
  brand_preference: string[];
  price_sensitivity: string;
  priority_order: string[];
  hard_constraints: Constraint[];
  soft_preferences: string[];
  negative_preferences: string[];
  target_user: string;
  uncertainty_fields: string[];
  feedback_history: FeedbackRecord[];
  long_term_profile: Record<string, unknown>;
}

export interface EvidenceItem {
  source: "metadata" | "review" | "rating" | "profile";
  text: string;
  product_id?: string | null;
}

export interface ClaimEvidenceRecord {
  claim: string;
  product_id?: string | null;
  evidence_type: "metadata" | "review" | "rating" | "profile" | "unknown";
  evidence_text?: string | null;
  supported: boolean;
}

export interface ConstraintCheck {
  field: string;
  status: ConstraintStatus;
  reason: string;
}

export interface ProductRecommendation {
  product_id: string;
  title: string;
  brand?: string | null;
  price?: number | null;
  currency?: string;
  image_url?: string | null;
  category_path: string[];
  leaf_category?: string | null;
  average_rating?: number | null;
  review_count?: number;
  matched_tags: string[];
  evidence: EvidenceItem[];
  uncertainties: string[];
  constraint_status: ConstraintStatus;
  constraint_checks?: ConstraintCheck[];
  score_breakdown?: Record<string, number>;
  rank_reason?: string | null;
  rank: number;
  claim_evidence?: ClaimEvidenceRecord[];
}

export interface ClarificationPayload {
  question: string;
  options: string[];
  allow_free_answer: boolean;
  allow_skip: boolean;
  allow_recommend_anyway: boolean;
}

export interface UnsupportedPayload {
  reason: string;
  can_do: string[];
  cannot_do: string[];
}

export interface SuggestedAction {
  label: string;
  action_type: string;
  payload?: Record<string, unknown>;
}

export interface TraceSummary {
  turn_id: string;
  task_type: TaskType;
  intent_summary: Record<string, unknown>;
  clarification_decision: Record<string, unknown>;
  retrieved_count: number;
  filtered_count: number;
  ranking_summary: Record<string, unknown>;
  rerank_summary: Record<string, unknown>;
  evidence_sources: string[];
  feedback_update?: Record<string, unknown> | null;
  warnings: string[];
}

export interface ChatTurnResponse {
  session_id: string;
  turn_id: string;
  status: ChatTurnStatus;
  task_type: TaskType;
  message: string;
  intent_state: IntentState;
  products: ProductRecommendation[];
  clarification?: ClarificationPayload | null;
  comparison?: Record<string, unknown> | null;
  unsupported?: UnsupportedPayload | null;
  trace_summary: TraceSummary;
  suggested_actions: SuggestedAction[];
}

export interface ChatRequest {
  session_id?: string | null;
  user_id?: string | null;
  message: string;
  turn_id?: string | null;
  feedback_text?: string | null;
  feedback_type?: string | null;
  anchor_product_id?: string | null;
}

export interface SessionState {
  session_id: string;
  messages: Array<Record<string, string>>;
  current_intent: IntentState;
}

export interface ErrorResponse {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface EvaluationRunSummary {
  run_id: string;
  timestamp: string;
  metrics: Record<string, number>;
  readiness?: {
    passed: boolean;
    gates: Record<string, Record<string, unknown>>;
  };
  case_failures: Array<Record<string, unknown>>;
}

export interface CatalogReadinessResponse {
  ready: boolean;
  catalog_path: string;
  demo_pool_path: string;
  quality_report_path: string;
  product_count: number;
  demo_pool_count: number;
  scale_status: string;
  errors: string[];
  warnings: string[];
  quality_report: Record<string, unknown>;
}

export interface EvaluationDatasetReadinessResponse {
  ready: boolean;
  path: string;
  case_count: number;
  labels: string[];
  errors: string[];
  warnings: string[];
}

export interface ProfileReadinessResponse {
  ready: boolean;
  profiles_path: string;
  summary_path: string;
  profile_count: number;
  errors: string[];
  warnings: string[];
  summary: Record<string, unknown>;
}

export interface VectorIndexReadinessResponse {
  ready: boolean;
  index_path: string;
  manifest_path: string;
  product_count: number;
  errors: string[];
  warnings: string[];
  manifest: Record<string, unknown>;
}

export interface InternalTrace {
  turn_id: string;
  session_id: string;
  timestamp: string;
  input: string;
  task_route: Record<string, unknown>;
  intent_before: Record<string, unknown>;
  intent_after: Record<string, unknown>;
  feedback_update: Record<string, unknown>;
  clarification: Record<string, unknown>;
  retrieval: Record<string, unknown>;
  filtering: Record<string, unknown>;
  constraint_checks: Array<Record<string, unknown>>;
  ranking: Record<string, unknown>;
  llm_rerank: Record<string, unknown>;
  final_validation: Record<string, unknown>;
  response: Record<string, unknown>;
  latency_ms: Record<string, number>;
  errors: Array<Record<string, unknown>>;
}

export interface ReplayResult {
  turn_id: string;
  replayed: boolean;
  stages: string[];
}
