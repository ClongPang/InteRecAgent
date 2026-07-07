import { liveApiClient } from "./client";

const runLiveIntegration = import.meta.env.VITE_RUN_LIVE_INTEGRATION === "true";
const liveTest = runLiveIntegration ? test : test.skip;

liveTest("liveApiClient reads the FastAPI chat contract", async () => {
  const response = await liveApiClient.chat({
    message: "Recommend wireless headphones under 100 dollars for commuting."
  });

  expect(response.status).toBe("recommendations_ready");
  expect(response.products.length).toBeGreaterThan(0);
  expect(response.trace_summary.task_type).toBe("single_item_recommendation");
});

liveTest("liveApiClient reads internal trace and evaluation contracts", async () => {
  const trace = await liveApiClient.getInternalTrace("turn_001");
  const evaluation = await liveApiClient.runEvaluation();

  expect(trace.turn_id).toBe("turn_001");
  expect(trace.task_route.task_type).toBe("single_item_recommendation");
  expect(evaluation.metrics.task_type_accuracy).toBeGreaterThan(0);
  expect(evaluation.metrics.feedback_recovery).toBeGreaterThan(0);
});
