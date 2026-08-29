import { describe, expect, it } from "vitest";

import { evaluateLiveServiceDrift, parseLiveServiceDriftBaseline, type LiveServiceDriftInput } from "../src/index.js";

function passingInput(): LiveServiceDriftInput {
  return {
    generatedAt: "2026-08-28T00:00:00.000Z",
    configuration: { modelProvider: "deepseek", modelId: "deepseek-v4-flash", query: "test", market: "US", runs: 2 },
    samples: [1, 2].map((runIndex) => ({
      runIndex,
      buyWhere: { ok: true, resultCount: 2, contractFingerprint: "sha256:buywhere", artifactRefPrefix: "sha256:artifact", durationMs: 10, errorCode: null },
      model: { ok: true, provider: "deepseek", requestedModel: "deepseek-v4-flash", responseModel: "deepseek-v4-flash", stopReason: "stop", text: "LIVE_OK", contractFingerprint: "sha256:model", durationMs: 20, inputTokens: 8, outputTokens: 2, errorCode: null },
    })),
  };
}

describe("live service drift evaluator", () => {
  it("passes stable real-service-shaped samples", () => {
    expect(evaluateLiveServiceDrift(passingInput())).toMatchObject({ passed: true, comparableToBaseline: false, failures: [] });
  });

  it("fails provider, model identity, probe text and contract instability", () => {
    const input = passingInput();
    input.samples[0]!.buyWhere.resultCount = 0;
    input.samples[1]!.buyWhere.contractFingerprint = "sha256:changed";
    input.samples[1]!.model.provider = "other";
    input.samples[1]!.model.text = "LIVE OK";
    const report = evaluateLiveServiceDrift(input);
    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      "buywhere_empty:1",
      "model_provider_drift:2:other",
      "model_probe_text:2:LIVE OK",
      "buywhere_contract_unstable:2",
    ]));
  });

  it("compares a new sample set with a compatible baseline", () => {
    const baseline = evaluateLiveServiceDrift(passingInput());
    const current = passingInput();
    current.baseline = baseline;
    expect(evaluateLiveServiceDrift(current)).toMatchObject({ passed: true, comparableToBaseline: true });
    current.samples[0]!.model.contractFingerprint = "sha256:new";
    current.samples[1]!.model.contractFingerprint = "sha256:new";
    expect(evaluateLiveServiceDrift(current).failures).toEqual(expect.arrayContaining(["baseline_model_contract_drift:sha256:model:sha256:new"]));
  });

  it("does not use a failed run as a drift baseline", () => {
    const baseline = evaluateLiveServiceDrift(passingInput());
    baseline.passed = false;
    baseline.failures = ["historical_failure"];
    const current = passingInput();
    current.baseline = baseline;
    expect(evaluateLiveServiceDrift(current)).toMatchObject({ passed: false, comparableToBaseline: false, failures: ["baseline_report_failed"] });
  });

  it("strictly parses a persisted baseline before comparison", () => {
    const baseline = evaluateLiveServiceDrift(passingInput());
    expect(parseLiveServiceDriftBaseline(JSON.parse(JSON.stringify(baseline)))).toMatchObject({ passed: true, configuration: { runs: 2 } });
    const invalid = structuredClone(baseline) as unknown as Record<string, unknown>;
    (invalid["configuration"] as Record<string, unknown>)["runs"] = "2";
    expect(() => parseLiveServiceDriftBaseline(invalid)).toThrow("LIVE_DRIFT_BASELINE_INVALID:report.configuration.runs");
  });
});
