import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ApiClient } from "./api/client";
import {
  clarificationFixture,
  errorFixture,
  feedbackUpdatedFixture,
  partialSupportFixture,
  recommendationFixture,
  unsupportedFixture
} from "./test/fixtures/chat";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getHealth: async () => ({
      status: "ok",
      service: "InteRecAgent API",
      version: "0.1.0"
    }),
    chat: async () => recommendationFixture,
    getProduct: async () => recommendationFixture.products[0],
    getSession: async () => ({
      session_id: "sess_demo",
      messages: [{ role: "user", content: "Recommend wireless headphones." }],
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
      errors: ["normalized catalog is missing: data/catalog/normalized_catalog.jsonl"],
      warnings: [],
      quality_report: {}
    }),
    getEvaluationDatasetReadiness: async () => ({
      ready: false,
      path: "data/eval/task_cases.jsonl",
      case_count: 0,
      labels: [],
      errors: ["task case file is missing: data/eval/task_cases.jsonl"],
      warnings: []
    }),
    getProfileReadiness: async () => ({
      ready: false,
      profiles_path: "data/profiles/user_profiles.jsonl",
      summary_path: "data/profiles/profile_summary.json",
      profile_count: 0,
      errors: ["user profiles are missing: data/profiles/user_profiles.jsonl"],
      warnings: [],
      summary: {}
    }),
    getVectorIndexReadiness: async () => ({
      ready: false,
      index_path: "data/indexes/product_index.jsonl",
      manifest_path: "data/indexes/index_manifest.json",
      product_count: 0,
      errors: ["vector index is missing: data/indexes/product_index.jsonl"],
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
      intent_after: { category: "wireless headphones" },
      feedback_update: {},
      clarification: { should_clarify: false },
      retrieval: { top_k: 3 },
      filtering: { input_count: 3, output_count: 2, unknown_constraints: [] },
      constraint_checks: [],
      ranking: { ranked_items: ["prod_headphones_001"] },
      llm_rerank: {},
      final_validation: { passed: true },
      response: { product_ids: ["prod_headphones_001"] },
      latency_ms: { total: 1 },
      errors: []
    }),
    replayTurn: async () => ({
      turn_id: "turn_001",
      replayed: true,
      stages: ["route", "intent", "retrieve", "filter", "verify", "rank", "respond"]
    }),
    ...overrides
  };
}

test("renders recommendation cards and workflow summary from fixture", () => {
  render(<App client={makeClient()} initialTurn={recommendationFixture} path="/" />);

  expect(screen.getByRole("heading", { name: "InteRecAgent" })).toBeInTheDocument();
  expect(screen.getByLabelText("System status")).toHaveTextContent("Checking API");
  expect(screen.getByLabelText("Agent workflow panel")).toHaveTextContent("single_item_recommendation");
  expect(screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones")).toHaveTextContent("USD 79.99");
  expect(screen.getByLabelText("Recommendation 2: MetroBeat Compact Wireless Headphones")).toHaveTextContent("Price unknown");
  expect(screen.getAllByText("Evidence missing").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Product comparison")).toHaveTextContent("Suggested choice");
  expect(screen.getByLabelText("Product comparison")).toHaveTextContent("review evidence missing");
});

test("renders API health status in consumer workspace", async () => {
  render(<App client={makeClient()} initialTurn={recommendationFixture} path="/" />);

  expect(await screen.findByLabelText("System status")).toHaveTextContent("InteRecAgent API · ok");
});

test("renders degraded API health status when health check fails", async () => {
  render(
    <App
      client={makeClient({
        getHealth: async () => {
          throw new Error("offline");
        }
      })}
      initialTurn={recommendationFixture}
      path="/"
    />
  );

  expect(await screen.findByLabelText("System status")).toHaveTextContent("API status unavailable");
});

test("loads a session summary through API client", async () => {
  const user = userEvent.setup();
  const getSession = vi.fn(async (sessionId: string) => ({
    session_id: sessionId,
    messages: [
      { role: "user", content: "Recommend wireless headphones." },
      { role: "assistant", content: "I found catalog-backed recommendations." }
    ],
    current_intent: {
      ...recommendationFixture.intent_state,
      category: "wireless headphones"
    }
  }));
  render(<App client={makeClient({ getSession })} initialTurn={recommendationFixture} path="/" />);

  await user.clear(screen.getByLabelText("Session ID"));
  await user.type(screen.getByLabelText("Session ID"), "sess_restore");
  await user.click(screen.getByRole("button", { name: "Load session" }));

  expect(getSession).toHaveBeenCalledWith("sess_restore");
  expect(await screen.findByLabelText("Session summary")).toHaveTextContent("sess_restore");
  expect(screen.getByLabelText("Session summary")).toHaveTextContent("2");
  expect(screen.getByLabelText("Session summary")).toHaveTextContent("wireless headphones");
});

test("reports recoverable session restore errors", async () => {
  const user = userEvent.setup();
  const getSession = vi.fn(async () => {
    throw new Error("offline");
  });
  render(<App client={makeClient({ getSession })} initialTurn={recommendationFixture} path="/" />);

  await user.click(screen.getByRole("button", { name: "Load session" }));

  expect(getSession).toHaveBeenCalledWith("sess_demo");
  expect(await screen.findByRole("alert")).toHaveTextContent("Session summary could not be loaded.");
});

test("shows pipeline loading state while chat request is pending", async () => {
  const user = userEvent.setup();
  let resolveChat: (value: typeof recommendationFixture) => void = () => {};
  const chat = vi.fn(
    () =>
      new Promise<typeof recommendationFixture>((resolve) => {
        resolveChat = resolve;
      })
  );
  render(<App client={makeClient({ chat })} initialTurn={recommendationFixture} path="/" />);

  const input = screen.getByLabelText("Message");
  await user.clear(input);
  await user.type(input, "Need a quieter pair");
  await user.click(screen.getByRole("button", { name: "Send" }));

  expect(screen.getByLabelText("Loading pipeline")).toHaveTextContent("Understanding request");
  expect(screen.getByLabelText("Loading pipeline")).toHaveTextContent("Checking catalog");
  expect(screen.getByLabelText("Loading pipeline")).toHaveTextContent("Verifying constraints");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

  resolveChat(recommendationFixture);

  await waitFor(() => expect(screen.queryByLabelText("Loading pipeline")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.getByLabelText("Message")).toHaveValue("");
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

test("submits portable feedback with anchor context", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => feedbackUpdatedFixture);
  render(<App client={makeClient({ chat })} initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  await user.click(within(firstCard).getByRole("button", { name: "More portable" }));

  expect(chat).toHaveBeenCalledWith({
    session_id: "sess_demo",
    turn_id: "turn_001",
    message: "Need something more portable",
    feedback_text: "Need something more portable",
    feedback_type: "portable",
    anchor_product_id: "prod_headphones_001"
  });
});

test("submits custom feedback with anchor context", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => feedbackUpdatedFixture);
  render(<App client={makeClient({ chat })} initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  await user.type(within(firstCard).getByLabelText("Custom feedback"), "Need a softer headband");
  await user.click(within(firstCard).getByRole("button", { name: "Send feedback" }));

  expect(chat).toHaveBeenCalledWith({
    session_id: "sess_demo",
    turn_id: "turn_001",
    message: "Need a softer headband",
    feedback_text: "Need a softer headband",
    feedback_type: "generic",
    anchor_product_id: "prod_headphones_001"
  });
  expect(within(firstCard).getByLabelText("Custom feedback")).toHaveValue("");
});

test("keeps message draft and retries after chat error", async () => {
  const user = userEvent.setup();
  const chat = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(recommendationFixture);
  render(<App client={makeClient({ chat })} initialTurn={recommendationFixture} path="/" />);

  const input = screen.getByLabelText("Message");
  await user.clear(input);
  await user.type(input, "Need a lighter pair");
  await user.click(screen.getByRole("button", { name: "Send" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
  expect(screen.getByLabelText("Message")).toHaveValue("Need a lighter pair");

  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(chat).toHaveBeenNthCalledWith(1, {
    session_id: "sess_demo",
    message: "Need a lighter pair"
  });
  expect(chat).toHaveBeenNthCalledWith(2, {
    session_id: "sess_demo",
    message: "Need a lighter pair"
  });
  expect(screen.getByLabelText("Message")).toHaveValue("");
});

test("retries failed feedback with anchor context", async () => {
  const user = userEvent.setup();
  const chat = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(feedbackUpdatedFixture);
  render(<App client={makeClient({ chat })} initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  await user.click(within(firstCard).getByRole("button", { name: "Show cheaper" }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Retry" }));

  const feedbackRequest = {
    session_id: "sess_demo",
    turn_id: "turn_001",
    message: "Too expensive",
    feedback_text: "Too expensive",
    feedback_type: "price",
    anchor_product_id: "prod_headphones_001"
  };
  expect(chat).toHaveBeenNthCalledWith(1, feedbackRequest);
  expect(chat).toHaveBeenNthCalledWith(2, feedbackRequest);
  expect(await screen.findByLabelText("What changed")).toHaveTextContent("price");
});

test("opens product evidence drawer with unknown field details", async () => {
  const user = userEvent.setup();
  const getProduct = vi.fn(async () => recommendationFixture.products[1]);
  render(<App client={makeClient({ getProduct })} initialTurn={recommendationFixture} path="/" />);

  const secondCard = screen.getByLabelText("Recommendation 2: MetroBeat Compact Wireless Headphones");
  await user.click(within(secondCard).getByRole("button", { name: "View evidence" }));

  expect(getProduct).toHaveBeenCalledWith("prod_headphones_002");
  expect(screen.getByLabelText("Product evidence drawer")).toHaveTextContent("Price unknown");
  expect(screen.getByLabelText("Product evidence drawer")).toHaveTextContent("review evidence missing");
  expect(screen.getByLabelText("Claim evidence")).toHaveTextContent("Unsupported");
});

test("product evidence drawer keeps current facts when product lookup fails", async () => {
  const user = userEvent.setup();
  const getProduct = vi.fn(async () => {
    throw new Error("lookup failed");
  });
  render(<App client={makeClient({ getProduct })} initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  await user.click(within(firstCard).getByRole("button", { name: "View evidence" }));

  expect(getProduct).toHaveBeenCalledWith("prod_headphones_001");
  expect(await screen.findByRole("alert")).toHaveTextContent("Full product facts could not be loaded");
  expect(screen.getByLabelText("Product evidence drawer")).toHaveTextContent("USD 79.99");
});

test("renders clarification options and sends selected answer", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => recommendationFixture);
  render(<App client={makeClient({ chat })} initialTurn={clarificationFixture} path="/" />);

  expect(screen.getByLabelText("Recommendation results")).toHaveTextContent("No recommendations to show yet.");
  await user.click(screen.getByRole("button", { name: "Mouse" }));

  expect(chat).toHaveBeenCalledWith({ session_id: "sess_demo", message: "Mouse" });
});

test("sends free-form clarification answer", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => recommendationFixture);
  render(<App client={makeClient({ chat })} initialTurn={clarificationFixture} path="/" />);

  await user.type(screen.getByLabelText("Clarification answer"), "ergonomic mouse");
  await user.click(screen.getByRole("button", { name: "Submit answer" }));

  expect(chat).toHaveBeenCalledWith({ session_id: "sess_demo", message: "ergonomic mouse" });
});

test("supports skipping clarification", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => recommendationFixture);
  render(<App client={makeClient({ chat })} initialTurn={clarificationFixture} path="/" />);

  await user.click(screen.getByRole("button", { name: "Skip" }));

  expect(chat).toHaveBeenCalledWith({ session_id: "sess_demo", message: "skip clarification" });
});

test("supports recommending anyway from clarification", async () => {
  const user = userEvent.setup();
  const chat = vi.fn(async () => recommendationFixture);
  render(<App client={makeClient({ chat })} initialTurn={clarificationFixture} path="/" />);

  await user.click(screen.getByRole("button", { name: "Recommend anyway" }));

  expect(chat).toHaveBeenCalledWith({ session_id: "sess_demo", message: "recommend anyway" });
});

test("renders unsupported fallback without checkout claims", () => {
  render(<App client={makeClient()} initialTurn={unsupportedFixture} path="/" />);

  expect(screen.getByLabelText("Unsupported request")).toHaveTextContent("Live commerce action");
  expect(screen.getByText(/Cannot do:/)).toHaveTextContent("Checkout");
  expect(screen.getByLabelText("Recommendation results")).toHaveTextContent("No recommendations to show yet.");
});

test("renders partial support fixture with unknown state", () => {
  render(<App client={makeClient()} initialTurn={partialSupportFixture} path="/" />);

  expect(screen.getByLabelText("Partial support")).toHaveTextContent("Some details are limited");
  expect(screen.getByLabelText("Recommendation results")).toHaveTextContent("Price unknown");
  expect(screen.getByLabelText("Agent workflow panel")).toHaveTextContent(
    "Some requested facts are unavailable"
  );
});

test("renders response-level error fixture without raw internals", () => {
  render(<App client={makeClient()} initialTurn={errorFixture} path="/" />);

  expect(screen.getByLabelText("Recommendation error")).toHaveTextContent(
    "Recommendation could not be completed"
  );
  expect(screen.getByLabelText("Recommendation results")).toHaveTextContent("No recommendations to show yet.");
  expect(screen.queryByText("stack")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Raw trace JSON")).not.toBeInTheDocument();
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
  expect(screen.getByLabelText("Trace selector")).toHaveTextContent("Turn ID");
  expect(screen.getByLabelText("Trace stages")).toHaveTextContent("Task route");
  expect(screen.getByLabelText("Trace stages")).toHaveTextContent("Retrieval");
  expect(screen.getByLabelText("Trace stages")).toHaveTextContent("Filtering");
  expect(screen.getByLabelText("Trace errors")).toHaveTextContent("No trace errors");
  expect(screen.getByLabelText("Raw trace JSON")).toHaveTextContent("single_item_recommendation");
});

test("internal trace route renders trace error list", async () => {
  render(
    <App
      client={makeClient({
        getInternalTrace: async () => ({
          turn_id: "turn_error",
          session_id: "sess_demo",
          timestamp: "2026-07-07T00:00:00Z",
          input: "Broken turn",
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
          errors: [
            {
              code: "retrieval_timeout",
              message: "Retriever exceeded local threshold.",
              details: { stage: "retrieval" }
            }
          ]
        })
      })}
      path="/internal/trace"
    />
  );

  expect(await screen.findByText("Turn: turn_error")).toBeInTheDocument();
  expect(screen.getByLabelText("Trace errors")).toHaveTextContent("retrieval_timeout");
  expect(screen.getByLabelText("Trace errors")).toHaveTextContent("Retriever exceeded local threshold.");
  expect(screen.getByLabelText("Trace errors")).toHaveTextContent("retrieval");
});

test("internal trace route loads selected turn id", async () => {
  const user = userEvent.setup();
  const getInternalTrace = vi.fn(async (turnId: string) => ({
    turn_id: turnId,
    session_id: "sess_demo",
    timestamp: "2026-07-07T00:00:00Z",
    input: "Selected turn",
    task_route: { task_type: "comparison" },
    intent_before: {},
    intent_after: { category: "wireless headphones" },
    feedback_update: {},
    clarification: { should_clarify: false },
    retrieval: { top_k: 2 },
    filtering: { input_count: 2, output_count: 2 },
    constraint_checks: [],
    ranking: { ranked_items: [] },
    llm_rerank: {},
    final_validation: { passed: true },
    response: { product_ids: [] },
    latency_ms: { total: 1 },
    errors: []
  }));
  render(<App client={makeClient({ getInternalTrace })} path="/internal/trace" />);

  await screen.findByText("Turn: turn_001");
  await user.clear(screen.getByLabelText("Turn ID"));
  await user.type(screen.getByLabelText("Turn ID"), "turn_selected");
  await user.click(screen.getByRole("button", { name: "Load trace" }));

  expect(await screen.findByText("Turn: turn_selected")).toBeInTheDocument();
  expect(getInternalTrace).toHaveBeenLastCalledWith("turn_selected");
  expect(screen.getByLabelText("Raw trace JSON")).toHaveTextContent("comparison");
});

test("internal trace route reports selected trace load errors", async () => {
  const user = userEvent.setup();
  const getInternalTrace = vi
    .fn()
    .mockResolvedValueOnce({
      turn_id: "turn_001",
      session_id: "sess_demo",
      timestamp: "2026-07-07T00:00:00Z",
      input: "Default turn",
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
    })
    .mockRejectedValueOnce(new Error("missing"));
  render(<App client={makeClient({ getInternalTrace })} path="/internal/trace" />);

  await screen.findByText("Turn: turn_001");
  await user.clear(screen.getByLabelText("Turn ID"));
  await user.type(screen.getByLabelText("Turn ID"), "missing_turn");
  await user.click(screen.getByRole("button", { name: "Load trace" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Trace could not be loaded");
  expect(screen.getByText("Turn: turn_001")).toBeInTheDocument();
});

test("internal trace route can replay a turn", async () => {
  const user = userEvent.setup();
  const replayTurn = vi.fn(async () => ({
    turn_id: "turn_001",
    replayed: true,
    stages: ["route", "intent", "retrieve", "filter", "verify", "rank", "respond"]
  }));
  render(<App client={makeClient({ replayTurn })} path="/internal/trace" />);

  await screen.findByText("Turn: turn_001");
  await user.click(screen.getByRole("button", { name: "Replay turn" }));

  expect(replayTurn).toHaveBeenCalledWith("turn_001");
  expect(await screen.findByLabelText("Replay result")).toHaveTextContent("Replay completed");
  expect(screen.getByLabelText("Replay result")).toHaveTextContent("retrieve -> filter -> verify");
});

test("evaluation route renders five metric dashboard", async () => {
  render(<App path="/internal/eval" />);

  expect(screen.getByRole("heading", { name: "Evaluation dashboard" })).toBeInTheDocument();
  expect(await screen.findByText("Run: eval_demo")).toBeInTheDocument();
  expect(screen.getByLabelText("Evaluation metrics")).toHaveTextContent("task_type_accuracy");
  expect(screen.getByLabelText("MVP readiness")).toHaveTextContent("Not passed");
  expect(screen.getByLabelText("MVP readiness")).toHaveTextContent("evidence_coverage");
  expect(screen.getByLabelText("Evaluation metrics")).toHaveTextContent("feedback_recovery");
  expect(screen.getByLabelText("Evaluation failures")).toHaveTextContent("No case failures");
});

test("evaluation route renders passing MVP readiness gates", async () => {
  render(
    <App
      client={makeClient({
        runEvaluation: async () => ({
          run_id: "eval_ready",
          timestamp: "2026-07-07T00:00:00Z",
          metrics: {
            task_type_accuracy: 1,
            intent_slot_f1: 1,
            constraint_satisfaction: 1,
            evidence_coverage: 1,
            feedback_recovery: 1
          },
          readiness: {
            passed: true,
            gates: {
              task_type_accuracy: { actual: 1, operator: ">=", threshold: 0.95, passed: true },
              final_validation_violation_rate: { actual: 0, operator: "<=", threshold: 0, passed: true }
            }
          },
          case_failures: []
        })
      })}
      path="/internal/eval"
    />
  );

  const readiness = await screen.findByLabelText("MVP readiness");
  expect(readiness).toHaveTextContent("Passed");
  expect(readiness).toHaveTextContent("final_validation_violation_rate");
});

test("evaluation route loads selected run id", async () => {
  const user = userEvent.setup();
  const getEvaluationRun = vi.fn(async (runId: string) => ({
    run_id: runId,
    timestamp: "2026-07-07T00:00:00Z",
    metrics: {
      task_type_accuracy: 0.25,
      intent_slot_f1: 0.5,
      constraint_satisfaction: 0.75,
      evidence_coverage: 1,
      feedback_recovery: 0.5
    },
    case_failures: []
  }));
  render(<App client={makeClient({ getEvaluationRun })} path="/internal/eval" />);

  await screen.findByText("Run: eval_demo");
  await user.clear(screen.getByLabelText("Run ID"));
  await user.type(screen.getByLabelText("Run ID"), "eval_selected");
  await user.click(screen.getByRole("button", { name: "Load run" }));

  expect(getEvaluationRun).toHaveBeenCalledWith("eval_selected");
  expect(await screen.findByText("Run: eval_selected")).toBeInTheDocument();
  expect(screen.getByLabelText("Evaluation metrics")).toHaveTextContent("25%");
});

test("evaluation route reports run lookup errors", async () => {
  const user = userEvent.setup();
  const getEvaluationRun = vi.fn(async () => {
    throw new Error("missing run");
  });
  render(<App client={makeClient({ getEvaluationRun })} path="/internal/eval" />);

  await screen.findByText("Run: eval_demo");
  await user.clear(screen.getByLabelText("Run ID"));
  await user.type(screen.getByLabelText("Run ID"), "missing_eval");
  await user.click(screen.getByRole("button", { name: "Load run" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Evaluation run could not be loaded");
  expect(screen.getByText("Run: eval_demo")).toBeInTheDocument();
});

test("evaluation route renders failure drilldown rows", async () => {
  render(
    <App
      client={makeClient({
        runEvaluation: async () => ({
          run_id: "eval_failure",
          timestamp: "2026-07-07T00:00:00Z",
          metrics: {
            task_type_accuracy: 0.5,
            intent_slot_f1: 0.5,
            constraint_satisfaction: 1,
            evidence_coverage: 0.75,
            feedback_recovery: 0.9
          },
          case_failures: [
            {
              case_id: "task_001",
              expected: "unsupported",
              actual: "single_item_recommendation"
            }
          ]
        })
      })}
      path="/internal/eval"
    />
  );

  expect(await screen.findByText("task_001")).toBeInTheDocument();
  expect(screen.getByLabelText("Evaluation failures")).toHaveTextContent("unsupported");
  expect(screen.getByLabelText("Evaluation failures")).toHaveTextContent("single_item_recommendation");
});

test("evaluation route renders catalog readiness status", async () => {
  render(
    <App
      client={makeClient({
        getCatalogReadiness: async () => ({
          ready: true,
          catalog_path: "data/catalog/normalized_catalog.jsonl",
          demo_pool_path: "data/catalog/curated_demo_pool.jsonl",
          quality_report_path: "data/catalog/quality_report.json",
          product_count: 20000,
          demo_pool_count: 50,
          scale_status: "target_met",
          errors: [],
          warnings: [],
          quality_report: { product_count: 20000 }
        })
      })}
      path="/internal/eval"
    />
  );

  const readiness = await screen.findByLabelText("Catalog readiness");
  expect(readiness).toHaveTextContent("Ready");
  expect(readiness).toHaveTextContent("20000");
  expect(readiness).toHaveTextContent("target_met");
});

test("evaluation route renders task case readiness status", async () => {
  render(
    <App
      client={makeClient({
        getEvaluationDatasetReadiness: async () => ({
          ready: true,
          path: "data/eval/task_cases.jsonl",
          case_count: 140,
          labels: ["single_item_recommendation", "unsupported"],
          errors: [],
          warnings: []
        })
      })}
      path="/internal/eval"
    />
  );

  const readiness = await screen.findByLabelText("Task case readiness");
  expect(readiness).toHaveTextContent("Ready");
  expect(readiness).toHaveTextContent("140");
  expect(readiness).toHaveTextContent("single_item_recommendation");
});

test("evaluation route renders profile readiness status", async () => {
  render(
    <App
      client={makeClient({
        getProfileReadiness: async () => ({
          ready: true,
          profiles_path: "data/profiles/user_profiles.jsonl",
          summary_path: "data/profiles/profile_summary.json",
          profile_count: 125,
          errors: [],
          warnings: [],
          summary: { profile_count: 125 }
        })
      })}
      path="/internal/eval"
    />
  );

  const readiness = await screen.findByLabelText("Profile readiness");
  expect(readiness).toHaveTextContent("Ready");
  expect(readiness).toHaveTextContent("125");
  expect(readiness).toHaveTextContent("user_profiles.jsonl");
});

test("evaluation route renders vector index readiness status", async () => {
  render(
    <App
      client={makeClient({
        getVectorIndexReadiness: async () => ({
          ready: true,
          index_path: "data/indexes/product_index.jsonl",
          manifest_path: "data/indexes/index_manifest.json",
          product_count: 20000,
          errors: [],
          warnings: [],
          manifest: { index_type: "deterministic_token_jaccard" }
        })
      })}
      path="/internal/eval"
    />
  );

  const readiness = await screen.findByLabelText("Vector index readiness");
  expect(readiness).toHaveTextContent("Ready");
  expect(readiness).toHaveTextContent("20000");
  expect(readiness).toHaveTextContent("product_index.jsonl");
});
