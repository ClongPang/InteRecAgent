import { liveApiClient } from "./client";

const runLiveIntegration = import.meta.env.VITE_RUN_LIVE_INTEGRATION === "true";
const liveTest = runLiveIntegration ? test : test.skip;

liveTest("liveApiClient reads the FastAPI chat contract", async () => {
  const health = await liveApiClient.getHealth();
  const response = await liveApiClient.chat({
    message: "Recommend wireless headphones under 100 dollars for commuting."
  });

  expect(health.status).toBe("ok");
  expect(health.service).toBe("InteRecAgent API");
  expect(response.status).toBe("recommendations_ready");
  expect(response.products.length).toBeGreaterThan(0);
  expect(response.trace_summary.task_type).toBe("single_item_recommendation");
});

liveTest("liveApiClient reads internal trace and evaluation contracts", async () => {
  const trace = await liveApiClient.getInternalTrace("turn_001");
  const evaluation = await liveApiClient.runEvaluation();
  const fetchedEvaluation = await liveApiClient.getEvaluationRun(evaluation.run_id);
  const replay = await liveApiClient.replayTurn("turn_001");
  const product = await liveApiClient.getProduct("prod_headphones_001");
  const session = await liveApiClient.getSession("sess_live_contract");

  expect(trace.turn_id).toBe("turn_001");
  expect(trace.task_route.task_type).toBe("single_item_recommendation");
  expect(trace.filtering.output_count).toBeGreaterThan(0);
  expect(evaluation.metrics.task_type_accuracy).toBeGreaterThan(0);
  expect(evaluation.metrics.feedback_recovery).toBeGreaterThan(0);
  expect(fetchedEvaluation.run_id).toBe(evaluation.run_id);
  expect(fetchedEvaluation.metrics.evidence_coverage).toBeGreaterThan(0);
  expect(replay.replayed).toBe(true);
  expect(replay.stages).toContain("filter");
  expect(replay.stages).toContain("respond");
  expect(product.product_id).toBe("prod_headphones_001");
  expect(session.session_id).toBe("sess_live_contract");
});
