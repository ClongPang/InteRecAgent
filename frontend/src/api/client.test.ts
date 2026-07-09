import { ApiClientError, createFeedbackRequest, liveApiClient, mockApiClient } from "./client";
import { recommendationFixture } from "../test/fixtures/chat";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
  expect(response.products[0].constraint_status).toBe("unknown_critical");
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

test("mockApiClient reads catalog readiness contract", async () => {
  const readiness = await mockApiClient.getCatalogReadiness();

  expect(readiness.ready).toBe(false);
  expect(readiness.scale_status).toBe("missing");
  expect(readiness.catalog_path).toContain("normalized_catalog.jsonl");
});

test("mockApiClient reads evaluation dataset readiness contract", async () => {
  const readiness = await mockApiClient.getEvaluationDatasetReadiness();

  expect(readiness.ready).toBe(false);
  expect(readiness.path).toContain("task_cases.jsonl");
  expect(readiness.errors[0]).toContain("task case file is missing");
});

test("mockApiClient reads profile readiness contract", async () => {
  const readiness = await mockApiClient.getProfileReadiness();

  expect(readiness.ready).toBe(false);
  expect(readiness.profiles_path).toContain("user_profiles.jsonl");
  expect(readiness.errors[0]).toContain("user profiles are missing");
});

test("mockApiClient reads vector index readiness contract", async () => {
  const readiness = await mockApiClient.getVectorIndexReadiness();

  expect(readiness.ready).toBe(false);
  expect(readiness.index_path).toContain("product_index.jsonl");
  expect(readiness.errors[0]).toContain("vector index is missing");
});

test("mockApiClient reads aggregate system readiness contract", async () => {
  const readiness = await mockApiClient.getSystemReadiness();

  expect(readiness.ready).toBe(false);
  expect(Object.keys(readiness.gates)).toEqual([
    "catalog",
    "evaluation_cases",
    "profiles",
    "vector_index"
  ]);
  expect(readiness.errors[0]).toContain("catalog:");
});

test("mockApiClient exposes stable error details for missing products", async () => {
  await expect(mockApiClient.getProduct("missing")).rejects.toMatchObject({
    name: "ApiClientError",
    status: 404,
    code: "product_not_found",
    details: { product_id: "missing" }
  } satisfies Partial<ApiClientError>);
});

test("liveApiClient converts network failures into stable recoverable errors", async () => {
  const fetchMock = vi.fn(async () => {
    throw new Error("connection refused");
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(liveApiClient.getHealth()).rejects.toMatchObject({
    name: "ApiClientError",
    status: 0,
    code: "network_error",
    details: { reason: "connection refused" }
  } satisfies Partial<ApiClientError>);

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/health",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});

test("liveApiClient aborts hung requests with a stable timeout error", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const request = liveApiClient.getHealth().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15000);

  await expect(request).resolves.toMatchObject({
    name: "ApiClientError",
    status: 0,
    code: "request_timeout",
    details: { timeout_ms: 15000 }
  } satisfies Partial<ApiClientError>);
});
