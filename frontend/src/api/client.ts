import type {
  ChatRequest,
  ChatTurnResponse,
  CatalogReadinessResponse,
  ErrorResponse,
  EvaluationDatasetReadinessResponse,
  EvaluationRunSummary,
  HealthResponse,
  InternalTrace,
  ProductRecommendation,
  ProfileReadinessResponse,
  ReplayResult,
  SessionState,
  SystemReadinessResponse,
  VectorIndexReadinessResponse
} from "../types/contracts";
import {
  clarificationFixture,
  errorFixture,
  evaluationFixture,
  feedbackUpdatedFixture,
  partialSupportFixture,
  recommendationFixture,
  unsupportedFixture
} from "../test/fixtures/chat";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS !== "false";
const API_TIMEOUT_MS = parsePositiveTimeout(import.meta.env.VITE_API_TIMEOUT_MS, 15000);

export interface ApiClient {
  getHealth(): Promise<HealthResponse>;
  chat(request: ChatRequest): Promise<ChatTurnResponse>;
  getProduct(productId: string): Promise<ProductRecommendation>;
  getSession(sessionId: string): Promise<SessionState>;
  runEvaluation(): Promise<EvaluationRunSummary>;
  getEvaluationRun(runId: string): Promise<EvaluationRunSummary>;
  getCatalogReadiness(): Promise<CatalogReadinessResponse>;
  getEvaluationDatasetReadiness(): Promise<EvaluationDatasetReadinessResponse>;
  getProfileReadiness(): Promise<ProfileReadinessResponse>;
  getVectorIndexReadiness(): Promise<VectorIndexReadinessResponse>;
  getSystemReadiness(): Promise<SystemReadinessResponse>;
  getInternalTrace(turnId: string): Promise<InternalTrace>;
  replayTurn(turnId: string): Promise<ReplayResult>;
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(status: number, error: ErrorResponse) {
    super(error.message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = error.code;
    this.details = error.details;
  }
}

export function createFeedbackRequest(
  current: ChatTurnResponse,
  feedbackText: string,
  feedbackType: string,
  anchorProductId: string
): ChatRequest {
  return {
    session_id: current.session_id,
    turn_id: current.turn_id,
    message: feedbackText,
    feedback_text: feedbackText,
    feedback_type: feedbackType,
    anchor_product_id: anchorProductId
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorResponse;
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "code" in body && "message" in body && "details" in body
        ? (body as ErrorResponse)
        : { code: "http_error", message: `Request failed with ${response.status}`, details: {} };
    throw new ApiClientError(response.status, error);
  }
  return body as T;
}

function parsePositiveTimeout(value: string | undefined, fallback: number): number {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestTimeoutError(): ApiClientError {
  return new ApiClientError(0, {
    code: "request_timeout",
    message: "Request timed out. Check the backend connection and try again.",
    details: { timeout_ms: API_TIMEOUT_MS }
  });
}

function networkError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) {
    return error;
  }
  return new ApiClientError(0, {
    code: "network_error",
    message: "Network request failed. Check the backend connection and try again.",
    details: { reason: error instanceof Error ? error.message : String(error) }
  });
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal
    });
    return await readJson<T>(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw requestTimeoutError();
    }
    throw networkError(error);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path);
}

async function postJson<T>(path: string, payload?: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
}

export const liveApiClient: ApiClient = {
  getHealth() {
    return getJson<HealthResponse>("/api/health");
  },
  chat(request) {
    return postJson<ChatTurnResponse>("/api/chat", request);
  },
  getProduct(productId) {
    return getJson<ProductRecommendation>(`/api/products/${encodeURIComponent(productId)}`);
  },
  getSession(sessionId) {
    return getJson<SessionState>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  },
  runEvaluation() {
    return postJson<EvaluationRunSummary>("/api/evaluation/run");
  },
  getEvaluationRun(runId) {
    return getJson<EvaluationRunSummary>(`/api/evaluation/runs/${encodeURIComponent(runId)}`);
  },
  getCatalogReadiness() {
    return getJson<CatalogReadinessResponse>("/api/internal/catalog/readiness");
  },
  getEvaluationDatasetReadiness() {
    return getJson<EvaluationDatasetReadinessResponse>("/api/internal/evaluation/dataset/readiness");
  },
  getProfileReadiness() {
    return getJson<ProfileReadinessResponse>("/api/internal/profiles/readiness");
  },
  getVectorIndexReadiness() {
    return getJson<VectorIndexReadinessResponse>("/api/internal/index/readiness");
  },
  getSystemReadiness() {
    return getJson<SystemReadinessResponse>("/api/internal/readiness");
  },
  getInternalTrace(turnId) {
    return getJson<InternalTrace>(`/api/internal/traces/${encodeURIComponent(turnId)}`);
  },
  replayTurn(turnId) {
    return postJson<ReplayResult>(`/api/internal/replay?turn_id=${encodeURIComponent(turnId)}`);
  }
};

export const mockApiClient: ApiClient = {
  async getHealth() {
    return {
      status: "ok",
      service: "InteRecAgent API",
      version: "0.1.0"
    };
  },
  async chat(request) {
    const message = `${request.message} ${request.feedback_text ?? ""}`.toLowerCase();
    if (request.feedback_type) {
      return feedbackUpdatedFixture;
    }
    if (message.includes("something for work")) {
      return clarificationFixture;
    }
    if (message.includes("stock") || message.includes("buy") || message.includes("checkout")) {
      return unsupportedFixture;
    }
    if (message.includes("partial") || message.includes("unknown facts")) {
      return partialSupportFixture;
    }
    if (message.includes("recoverable error")) {
      return errorFixture;
    }
    return recommendationFixture;
  },
  async getProduct(productId) {
    const product = recommendationFixture.products.find((item) => item.product_id === productId);
    if (!product) {
      throw new ApiClientError(404, {
        code: "product_not_found",
        message: "Product was not found in the demo catalog.",
        details: { product_id: productId }
      });
    }
    return product;
  },
  async getSession(sessionId) {
    return {
      session_id: sessionId,
      messages: [
        { role: "user", content: "I need wireless headphones under $100 for commuting." },
        { role: "assistant", content: recommendationFixture.message }
      ],
      current_intent: recommendationFixture.intent_state
    };
  },
  async runEvaluation() {
    return evaluationFixture;
  },
  async getEvaluationRun(runId) {
    return {
      ...evaluationFixture,
      run_id: runId
    };
  },
  async getCatalogReadiness() {
    return {
      ready: false,
      catalog_path: "data/catalog/normalized_catalog.jsonl",
      demo_pool_path: "data/catalog/curated_demo_pool.jsonl",
      quality_report_path: "data/catalog/quality_report.json",
      product_count: 0,
      demo_pool_count: 0,
      scale_status: "missing",
      errors: ["normalized catalog is missing: data/catalog/normalized_catalog.jsonl"],
      warnings: [],
      quality_report: {}
    };
  },
  async getEvaluationDatasetReadiness() {
    return {
      ready: false,
      path: "data/eval/task_cases.jsonl",
      case_count: 0,
      labels: [],
      errors: ["task case file is missing: data/eval/task_cases.jsonl"],
      warnings: []
    };
  },
  async getProfileReadiness() {
    return {
      ready: false,
      profiles_path: "data/profiles/user_profiles.jsonl",
      summary_path: "data/profiles/profile_summary.json",
      profile_count: 0,
      errors: ["user profiles are missing: data/profiles/user_profiles.jsonl"],
      warnings: [],
      summary: {}
    };
  },
  async getVectorIndexReadiness() {
    return {
      ready: false,
      index_path: "data/indexes/product_index.jsonl",
      manifest_path: "data/indexes/index_manifest.json",
      product_count: 0,
      errors: ["vector index is missing: data/indexes/product_index.jsonl"],
      warnings: [],
      manifest: {}
    };
  },
  async getSystemReadiness() {
    return {
      ready: false,
      gates: {
        catalog: {
          ready: false,
          errors: ["normalized catalog is missing: data/catalog/normalized_catalog.jsonl"],
          warnings: []
        },
        evaluation_cases: {
          ready: false,
          errors: ["task case file is missing: data/eval/task_cases.jsonl"],
          warnings: []
        },
        profiles: {
          ready: false,
          errors: ["user profiles are missing: data/profiles/user_profiles.jsonl"],
          warnings: []
        },
        vector_index: {
          ready: false,
          errors: ["vector index is missing: data/indexes/product_index.jsonl"],
          warnings: []
        }
      },
      errors: [
        "catalog: normalized catalog is missing: data/catalog/normalized_catalog.jsonl",
        "evaluation_cases: task case file is missing: data/eval/task_cases.jsonl",
        "profiles: user profiles are missing: data/profiles/user_profiles.jsonl",
        "vector_index: vector index is missing: data/indexes/product_index.jsonl"
      ],
      warnings: []
    };
  },
  async getInternalTrace(turnId) {
    return {
      turn_id: turnId,
      session_id: "sess_demo",
      timestamp: "2026-07-07T00:00:00Z",
      input: "Recommend wireless headphones under 100 dollars.",
      task_route: { task_type: "single_item_recommendation", confidence: 1 },
      intent_before: {},
      intent_after: { category: "wireless headphones" },
      feedback_update: {},
      clarification: { should_clarify: false },
      retrieval: { top_k: 3, retrieved_items: ["prod_headphones_001"] },
      filtering: { input_count: 3, output_count: 1, hard_constraint_violations: [] },
      constraint_checks: [],
      ranking: { ranked_items: ["prod_headphones_001"] },
      llm_rerank: { mode: "mock" },
      final_validation: { passed: true },
      response: { product_ids: ["prod_headphones_001"] },
      latency_ms: { total: 1 },
      errors: []
    };
  },
  async replayTurn(turnId) {
    return {
      turn_id: turnId,
      replayed: true,
      stages: ["route", "intent", "retrieve", "filter", "verify", "rank", "respond"]
    };
  }
};

export const apiClient: ApiClient = USE_MOCKS ? mockApiClient : liveApiClient;
