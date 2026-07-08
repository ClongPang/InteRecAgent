import type {
  ChatRequest,
  ChatTurnResponse,
  ErrorResponse,
  EvaluationRunSummary,
  HealthResponse,
  InternalTrace,
  ProductRecommendation,
  ReplayResult,
  SessionState
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

export interface ApiClient {
  getHealth(): Promise<HealthResponse>;
  chat(request: ChatRequest): Promise<ChatTurnResponse>;
  getProduct(productId: string): Promise<ProductRecommendation>;
  getSession(sessionId: string): Promise<SessionState>;
  runEvaluation(): Promise<EvaluationRunSummary>;
  getEvaluationRun(runId: string): Promise<EvaluationRunSummary>;
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

async function getJson<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(`${API_BASE}${path}`));
}

async function postJson<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  return readJson<T>(response);
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
