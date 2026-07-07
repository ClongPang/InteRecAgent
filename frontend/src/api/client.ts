import type {
  ChatRequest,
  ChatTurnResponse,
  EvaluationRunSummary,
  InternalTrace
} from "../types/contracts";
import {
  clarificationFixture,
  evaluationFixture,
  feedbackUpdatedFixture,
  recommendationFixture,
  unsupportedFixture
} from "../test/fixtures/chat";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS !== "false";

export interface ApiClient {
  chat(request: ChatRequest): Promise<ChatTurnResponse>;
  runEvaluation(): Promise<EvaluationRunSummary>;
  getInternalTrace(turnId: string): Promise<InternalTrace>;
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

async function postJson<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const liveApiClient: ApiClient = {
  chat(request) {
    return postJson<ChatTurnResponse>("/api/chat", request);
  },
  runEvaluation() {
    return postJson<EvaluationRunSummary>("/api/evaluation/run");
  },
  async getInternalTrace(turnId) {
    const response = await fetch(`${API_BASE}/api/internal/traces/${turnId}`);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    return (await response.json()) as InternalTrace;
  }
};

export const mockApiClient: ApiClient = {
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
    return recommendationFixture;
  },
  async runEvaluation() {
    return evaluationFixture;
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
      constraint_checks: [],
      ranking: { ranked_items: ["prod_headphones_001"] },
      llm_rerank: { mode: "mock" },
      final_validation: { passed: true },
      response: { product_ids: ["prod_headphones_001"] },
      latency_ms: { total: 1 },
      errors: []
    };
  }
};

export const apiClient: ApiClient = USE_MOCKS ? mockApiClient : liveApiClient;
