import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ApiClient } from "./api/client";
import {
  clarificationFixture,
  recommendationFixture,
  unsupportedFixture
} from "./test/fixtures/chat";

function makeSlowClient(): ApiClient {
  return {
    getHealth: async () => ({
      status: "ok",
      service: "InteRecAgent API",
      version: "0.1.0"
    }),
    chat: async () => recommendationFixture,
    getProduct: () => new Promise(() => {}),
    getSession: async () => ({
      session_id: "sess_demo",
      messages: [],
      current_intent: recommendationFixture.intent_state
    }),
    runEvaluation: async () => ({
      run_id: "eval_demo",
      timestamp: "2026-07-07T00:00:00Z",
      metrics: {},
      case_failures: []
    }),
    getEvaluationRun: async (runId: string) => ({
      run_id: runId,
      timestamp: "2026-07-07T00:00:00Z",
      metrics: {},
      case_failures: []
    }),
    getCatalogReadiness: async () => ({
      ready: false,
      catalog_path: "data/catalog/normalized_catalog.jsonl",
      demo_pool_path: "data/catalog/curated_demo_pool.jsonl",
      quality_report_path: "data/catalog/quality_report.json",
      product_count: 0,
      demo_pool_count: 0,
      scale_status: "missing",
      errors: [],
      warnings: [],
      quality_report: {}
    }),
    getEvaluationDatasetReadiness: async () => ({
      ready: false,
      path: "data/eval/task_cases.jsonl",
      case_count: 0,
      labels: [],
      errors: [],
      warnings: []
    }),
    getProfileReadiness: async () => ({
      ready: false,
      profiles_path: "data/profiles/user_profiles.jsonl",
      summary_path: "data/profiles/profile_summary.json",
      profile_count: 0,
      errors: [],
      warnings: [],
      summary: {}
    }),
    getVectorIndexReadiness: async () => ({
      ready: false,
      index_path: "data/indexes/product_index.jsonl",
      manifest_path: "data/indexes/index_manifest.json",
      product_count: 0,
      errors: [],
      warnings: [],
      manifest: {}
    }),
    getInternalTrace: async () => ({
      turn_id: "turn_001",
      session_id: "sess_demo",
      timestamp: "2026-07-07T00:00:00Z",
      input: "Recommend wireless headphones under 100 dollars.",
      task_route: { task_type: "single_item_recommendation" },
      intent_before: {},
      intent_after: {},
      feedback_update: {},
      clarification: {},
      retrieval: {},
      filtering: {},
      constraint_checks: [],
      ranking: {},
      llm_rerank: {},
      final_validation: {},
      response: {},
      latency_ms: {},
      errors: []
    }),
    replayTurn: async () => ({ turn_id: "turn_001", replayed: true, stages: [] })
  };
}

test("consumer workspace exposes named regions and controls", () => {
  render(<App initialTurn={recommendationFixture} path="/" />);

  expect(screen.getByRole("main")).toBeInTheDocument();
  expect(screen.getByLabelText("Shopping workspace")).toBeInTheDocument();
  expect(screen.getByLabelText("Agent workflow panel")).toBeInTheDocument();
  expect(screen.getByLabelText("Recommendation results")).toBeInTheDocument();
  expect(screen.getByLabelText("Product comparison")).toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
});

test("keyboard users can open and close the product evidence drawer", async () => {
  const user = userEvent.setup();
  render(<App initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  within(firstCard).getByRole("button", { name: "View evidence" }).focus();
  await user.keyboard("{Enter}");

  expect(screen.getByLabelText("Product evidence drawer")).toHaveTextContent(
    "AeroLite Wireless Commuter Headphones"
  );

  screen.getByRole("button", { name: "Close" }).focus();
  await user.keyboard("{Enter}");

  expect(screen.queryByLabelText("Product evidence drawer")).not.toBeInTheDocument();
});

test("product drawer loading state is announced", async () => {
  const user = userEvent.setup();
  render(<App client={makeSlowClient()} initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  await user.click(within(firstCard).getByRole("button", { name: "View evidence" }));

  expect(screen.getByRole("status")).toHaveTextContent("Loading full product facts");
});

test("clarification and unsupported states have readable, named notices", () => {
  const { unmount } = render(<App initialTurn={clarificationFixture} path="/" />);

  expect(screen.getByLabelText("Clarification prompt")).toHaveTextContent(
    "What kind of product should I focus on for work?"
  );
  expect(screen.getByLabelText("Clarification answer")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Recommend anyway" })).toBeInTheDocument();

  unmount();
  render(<App initialTurn={unsupportedFixture} path="/" />);
  expect(screen.getByLabelText("Unsupported request")).toHaveTextContent("Live commerce action");
  expect(screen.getByLabelText("Unsupported request")).toHaveTextContent("Checkout");
  expect(screen.getByRole("status")).toHaveTextContent("No recommendations to show yet.");
});

test("internal pages expose raw trace and evaluation regions only on internal routes", async () => {
  const { rerender } = render(<App initialTurn={recommendationFixture} path="/" />);

  expect(screen.queryByLabelText("Raw trace JSON")).not.toBeInTheDocument();

  rerender(<App path="/internal/trace" />);
  expect(screen.getByRole("heading", { name: "Internal Trace Console" })).toBeInTheDocument();
  expect(screen.getByLabelText("Trace selector")).toBeInTheDocument();
  expect(screen.getByLabelText("Turn ID")).toBeInTheDocument();
  expect(await screen.findByLabelText("Trace errors")).toBeInTheDocument();
  expect(screen.getByLabelText("Raw trace JSON")).toBeInTheDocument();

  rerender(<App path="/internal/eval" />);
  expect(screen.getByRole("heading", { name: "Evaluation dashboard" })).toBeInTheDocument();
  expect(screen.getByLabelText("Evaluation run selector")).toBeInTheDocument();
  expect(screen.getByLabelText("Run ID")).toBeInTheDocument();
  expect(await screen.findByLabelText("Evaluation metrics")).toBeInTheDocument();
  expect(screen.getByLabelText("Evaluation failures")).toBeInTheDocument();
});
