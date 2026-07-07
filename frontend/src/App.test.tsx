import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ApiClient } from "./api/client";
import {
  clarificationFixture,
  feedbackUpdatedFixture,
  recommendationFixture,
  unsupportedFixture
} from "./test/fixtures/chat";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    chat: async () => recommendationFixture,
    runEvaluation: async () => ({
      run_id: "eval_demo",
      timestamp: "2026-07-07T00:00:00Z",
      metrics: {},
      case_failures: []
    }),
    getInternalTrace: async () => ({
      turn_id: "turn_001",
      session_id: "sess_demo",
      timestamp: "2026-07-07T00:00:00Z",
      input: "Recommend wireless headphones under 100 dollars.",
      task_route: { task_type: "single_item_recommendation" },
      intent_before: {},
      intent_after: { category: "wireless headphones" },
      feedback_update: {},
      clarification: { should_clarify: false },
      retrieval: { top_k: 3 },
      constraint_checks: [],
      ranking: { ranked_items: ["prod_headphones_001"] },
      llm_rerank: {},
      final_validation: { passed: true },
      response: { product_ids: ["prod_headphones_001"] },
      latency_ms: { total: 1 },
      errors: []
    }),
    ...overrides
  };
}

test("renders recommendation cards and workflow summary from fixture", () => {
  render(<App client={makeClient()} initialTurn={recommendationFixture} path="/" />);

  expect(screen.getByRole("heading", { name: "InteRecAgent" })).toBeInTheDocument();
  expect(screen.getByLabelText("Agent workflow panel")).toHaveTextContent("single_item_recommendation");
  expect(screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones")).toHaveTextContent("USD 79.99");
  expect(screen.getByLabelText("Recommendation 2: MetroBeat Compact Wireless Headphones")).toHaveTextContent("Price unknown");
  expect(screen.getByText("Evidence missing")).toBeInTheDocument();
});

test("submits feedback with anchor context and displays what changed", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => feedbackUpdatedFixture);
  render(<App client={makeClient({ chat })} initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  await user.click(within(firstCard).getByRole("button", { name: "Show cheaper" }));

  expect(chat).toHaveBeenCalledWith({
    session_id: "sess_demo",
    turn_id: "turn_001",
    message: "Too expensive",
    feedback_text: "Too expensive",
    feedback_type: "price",
    anchor_product_id: "prod_headphones_001"
  });
  expect(await screen.findByLabelText("What changed")).toHaveTextContent("price");
});

test("opens product evidence drawer with unknown field details", async () => {
  const user = userEvent.setup();
  render(<App client={makeClient()} initialTurn={recommendationFixture} path="/" />);

  const secondCard = screen.getByLabelText("Recommendation 2: MetroBeat Compact Wireless Headphones");
  await user.click(within(secondCard).getByRole("button", { name: "View evidence" }));

  expect(screen.getByLabelText("Product evidence drawer")).toHaveTextContent("Price unknown");
  expect(screen.getByLabelText("Product evidence drawer")).toHaveTextContent("review evidence missing");
});

test("renders clarification options and sends selected answer", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => recommendationFixture);
  render(<App client={makeClient({ chat })} initialTurn={clarificationFixture} path="/" />);

  await user.click(screen.getByRole("button", { name: "Mouse" }));

  expect(chat).toHaveBeenCalledWith({ session_id: "sess_demo", message: "Mouse" });
});

test("renders unsupported fallback without checkout claims", () => {
  render(<App client={makeClient()} initialTurn={unsupportedFixture} path="/" />);

  expect(screen.getByLabelText("Unsupported request")).toHaveTextContent("Live commerce action");
  expect(screen.getByText(/Cannot do:/)).toHaveTextContent("Checkout");
});

test("consumer route does not render raw internal trace", () => {
  render(<App client={makeClient()} initialTurn={recommendationFixture} path="/" />);

  expect(screen.queryByLabelText("Raw trace JSON")).not.toBeInTheDocument();
  expect(screen.queryByText("raw_profile")).not.toBeInTheDocument();
});

test("internal trace route renders raw trace details", () => {
  render(<App path="/internal/trace" />);

  expect(screen.getByRole("heading", { name: "Internal Trace Console" })).toBeInTheDocument();
  expect(screen.getByLabelText("Raw trace JSON")).toHaveTextContent("loading");
});

test("internal trace route loads trace through API client", async () => {
  render(<App client={makeClient()} path="/internal/trace" />);

  expect(await screen.findByText("Turn: turn_001")).toBeInTheDocument();
  expect(screen.getByLabelText("Raw trace JSON")).toHaveTextContent("single_item_recommendation");
});

test("evaluation route renders five metric dashboard", async () => {
  render(<App path="/internal/eval" />);

  expect(screen.getByRole("heading", { name: "Evaluation dashboard" })).toBeInTheDocument();
  expect(await screen.findByText("task_type_accuracy")).toBeInTheDocument();
  expect(screen.getByLabelText("Evaluation metrics")).toHaveTextContent("feedback_recovery");
});
