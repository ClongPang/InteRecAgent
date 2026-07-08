import { ApiClientError, createFeedbackRequest, mockApiClient } from "./client";
import { recommendationFixture } from "../test/fixtures/chat";

test("createFeedbackRequest preserves turn and anchor context", () => {
  const request = createFeedbackRequest(
    recommendationFixture,
    "Too expensive",
    "price",
    "prod_headphones_001"
  );

  expect(request).toEqual({
    session_id: "sess_demo",
    turn_id: "turn_001",
    message: "Too expensive",
    feedback_text: "Too expensive",
    feedback_type: "price",
    anchor_product_id: "prod_headphones_001"
  });
});

test("mockApiClient reads health contract", async () => {
  const health = await mockApiClient.getHealth();

  expect(health).toEqual({
    status: "ok",
    service: "InteRecAgent API",
    version: "0.1.0"
  });
});

test("mockApiClient returns unsupported fixture for live commerce requests", async () => {
  const response = await mockApiClient.chat({ message: "Can you buy it and check stock?" });

  expect(response.status).toBe("unsupported");
  expect(response.unsupported?.cannot_do).toContain("Checkout");
});

test("mockApiClient returns partial support fixture for unknown fact requests", async () => {
  const response = await mockApiClient.chat({ message: "Recommend with partial unknown facts." });

  expect(response.status).toBe("partial_support");
  expect(response.products[0].constraint_status).toBe("unknown");
});

test("mockApiClient returns response-level error fixture for recoverable errors", async () => {
  const response = await mockApiClient.chat({ message: "Trigger recoverable error fixture." });

  expect(response.status).toBe("error");
  expect(response.products).toEqual([]);
});

test("mockApiClient replays a turn with deterministic stages", async () => {
  const result = await mockApiClient.replayTurn("turn_001");

  expect(result.replayed).toBe(true);
  expect(result.stages).toEqual(["route", "intent", "retrieve", "filter", "verify", "rank", "respond"]);
});

test("mockApiClient reads product and session contracts", async () => {
  const product = await mockApiClient.getProduct("prod_headphones_001");
  const session = await mockApiClient.getSession("sess_demo");

  expect(product.title).toBe("AeroLite Wireless Commuter Headphones");
  expect(session.session_id).toBe("sess_demo");
  expect(session.current_intent.category).toBe("wireless headphones");
});

test("mockApiClient reads evaluation run by id", async () => {
  const evaluation = await mockApiClient.getEvaluationRun("eval_selected");

  expect(evaluation.run_id).toBe("eval_selected");
  expect(evaluation.metrics.feedback_recovery).toBeGreaterThan(0);
});

test("mockApiClient exposes stable error details for missing products", async () => {
  await expect(mockApiClient.getProduct("missing")).rejects.toMatchObject({
    name: "ApiClientError",
    status: 404,
    code: "product_not_found",
    details: { product_id: "missing" }
  } satisfies Partial<ApiClientError>);
});
