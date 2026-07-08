import type { ChatTurnResponse, EvaluationRunSummary, IntentState } from "../../types/contracts";

const baseIntent: IntentState = {
  task_type: "single_item_recommendation",
  category: "wireless headphones",
  goal: "commuting",
  scenario: "daily commute",
  budget: { max: 100, currency: "USD" },
  brand_preference: [],
  price_sensitivity: "",
  priority_order: ["comfort", "battery"],
  hard_constraints: [{ field: "price", op: "<=", value: 100 }],
  soft_preferences: ["comfortable", "portable"],
  negative_preferences: [],
  target_user: "",
  uncertainty_fields: [],
  feedback_history: [],
  long_term_profile: {}
};

export const recommendationFixture: ChatTurnResponse = {
  session_id: "sess_demo",
  turn_id: "turn_001",
  status: "recommendations_ready",
  task_type: "single_item_recommendation",
  message: "I found catalog-backed recommendations that match your request.",
  intent_state: baseIntent,
  products: [
    {
      product_id: "prod_headphones_001",
      title: "AeroLite Wireless Commuter Headphones",
      brand: "AeroLite",
      price: 79.99,
      currency: "USD",
      image_url: null,
      category_path: ["Electronics", "Headphones", "Wireless"],
      leaf_category: "Wireless Headphones",
      average_rating: 4.4,
      review_count: 824,
      matched_tags: ["under $100", "commuting", "comfortable"],
      evidence: [
        {
          source: "review",
          product_id: "prod_headphones_001",
          text: "Reviewers repeatedly mention light weight and comfortable long-wear fit."
        }
      ],
      uncertainties: ["Battery life varies by listening volume."],
      constraint_status: "satisfied",
      constraint_checks: [{ field: "price", status: "satisfied", reason: "79.99 <= 100" }],
      score_breakdown: { intent_match: 0.84, price_fit: 0.9, evidence: 0.72 },
      rank_reason: "Best balance of comfort evidence, commute fit, and budget.",
      rank: 1,
      claim_evidence: [
        {
          claim: "AeroLite Wireless Commuter Headphones has supporting review evidence.",
          product_id: "prod_headphones_001",
          evidence_type: "review",
          evidence_text: "Reviewers repeatedly mention light weight and comfortable long-wear fit.",
          supported: true
        }
      ]
    },
    {
      product_id: "prod_headphones_002",
      title: "MetroBeat Compact Wireless Headphones",
      brand: "MetroBeat",
      price: null,
      currency: "USD",
      image_url: null,
      category_path: ["Electronics", "Headphones", "Wireless"],
      leaf_category: "Wireless Headphones",
      average_rating: 4.1,
      review_count: 311,
      matched_tags: ["compact", "portable"],
      evidence: [],
      uncertainties: ["price unknown", "review evidence missing"],
      constraint_status: "unknown",
      constraint_checks: [
        {
          field: "price",
          status: "unknown",
          reason: "Catalog price is missing and cannot be claimed under budget."
        }
      ],
      score_breakdown: { intent_match: 0.68, price_fit: 0, evidence: 0.2 },
      rank_reason: "Close match, but price and evidence are incomplete.",
      rank: 2,
      claim_evidence: [
        {
          claim: "MetroBeat Compact Wireless Headphones has unknown catalog price.",
          product_id: "prod_headphones_002",
          evidence_type: "unknown",
          evidence_text: null,
          supported: false
        }
      ]
    }
  ],
  trace_summary: {
    turn_id: "turn_001",
    task_type: "single_item_recommendation",
    intent_summary: { category: "wireless headphones", budget: { max: 100, currency: "USD" } },
    clarification_decision: { should_clarify: false },
    retrieved_count: 80,
    filtered_count: 12,
    ranking_summary: { top_score: 0.84, ranker: "mock_rule_ranker" },
    rerank_summary: { mode: "mock", changed_order: false },
    evidence_sources: ["review", "metadata"],
    warnings: ["Some product facts are unknown and labeled explicitly."]
  },
  suggested_actions: [
    {
      label: "Show cheaper",
      action_type: "feedback",
      payload: { feedback_type: "price", anchor_product_id: "prod_headphones_001" }
    },
    {
      label: "Avoid this brand",
      action_type: "feedback",
      payload: { feedback_type: "brand", anchor_product_id: "prod_headphones_001" }
    },
    {
      label: "More portable",
      action_type: "feedback",
      payload: { feedback_type: "portable", anchor_product_id: "prod_headphones_001" }
    }
  ]
};

export const clarificationFixture: ChatTurnResponse = {
  ...recommendationFixture,
  status: "clarification_required",
  message: "What kind of product should I focus on for work?",
  products: [],
  intent_state: { ...baseIntent, category: "", goal: "work", uncertainty_fields: ["category"] },
  clarification: {
    question: "What kind of product should I focus on for work?",
    options: ["Headphones", "Mouse", "Desk accessory"],
    allow_free_answer: true,
    allow_skip: true,
    allow_recommend_anyway: true
  },
  trace_summary: {
    ...recommendationFixture.trace_summary,
    clarification_decision: { should_clarify: true, reason: "missing category" },
    warnings: ["category is ambiguous"]
  }
};

export const unsupportedFixture: ChatTurnResponse = {
  ...recommendationFixture,
  status: "unsupported",
  task_type: "unsupported",
  message:
    "I cannot check live stock, shipping, payment, or checkout in this demo. I can still recommend catalog-backed alternatives.",
  products: [],
  unsupported: {
    reason: "Live commerce action is outside MVP scope.",
    can_do: ["Recommend products from the loaded catalog", "Explain known product evidence"],
    cannot_do: ["Live inventory", "Payment", "Checkout", "Shipping"]
  },
  trace_summary: {
    ...recommendationFixture.trace_summary,
    task_type: "unsupported",
    warnings: ["live commerce action unsupported"]
  }
};

export const partialSupportFixture: ChatTurnResponse = {
  ...recommendationFixture,
  status: "partial_support",
  message:
    "I found catalog-backed options, but some requested facts are unknown and marked explicitly.",
  products: [recommendationFixture.products[1]],
  trace_summary: {
    ...recommendationFixture.trace_summary,
    turn_id: "turn_partial",
    filtered_count: 1,
    warnings: ["Some requested facts are unavailable in the catalog."]
  }
};

export const errorFixture: ChatTurnResponse = {
  ...recommendationFixture,
  status: "error",
  message: "I could not complete this recommendation safely. Please try again.",
  products: [],
  trace_summary: {
    ...recommendationFixture.trace_summary,
    turn_id: "turn_error",
    retrieved_count: 0,
    filtered_count: 0,
    ranking_summary: {},
    rerank_summary: {},
    evidence_sources: [],
    warnings: ["A recoverable recommendation error occurred."]
  },
  suggested_actions: []
};

export const feedbackUpdatedFixture: ChatTurnResponse = {
  ...recommendationFixture,
  turn_id: "turn_feedback",
  task_type: "negative_feedback",
  message: "I updated the recommendations based on your feedback.",
  intent_state: {
    ...baseIntent,
    task_type: "negative_feedback",
    price_sensitivity: "high",
    feedback_history: [
      {
        turn_id: "turn_001",
        feedback_text: "Too expensive",
        feedback_type: "price",
        anchor_product_id: "prod_headphones_001"
      }
    ]
  },
  trace_summary: {
    ...recommendationFixture.trace_summary,
    turn_id: "turn_feedback",
    task_type: "negative_feedback",
    feedback_update: { feedback_type: "price" },
    filtered_count: 18
  }
};

export const evaluationFixture: EvaluationRunSummary = {
  run_id: "eval_demo",
  timestamp: "2026-07-07T00:00:00Z",
  metrics: {
    task_type_accuracy: 1,
    intent_slot_f1: 0.92,
    constraint_satisfaction: 1,
    evidence_coverage: 0.75,
    feedback_recovery: 0.9
  },
  case_failures: []
};
