import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { compareEvaluationReports, parseEvaluationReport } from "../src/evaluation-drift.js";
import { evaluateTaskTrials, parseEvaluationManifest, parseEvaluationTrials, type EvaluationReport } from "../src/task-evaluator.js";

let baseline: EvaluationReport;

beforeAll(async () => {
  const [manifestJson, trialsJson] = await Promise.all([
    readFile("spec/evaluation/dev/manifest.json", "utf8"),
    readFile("spec/evaluation/dev/trials.json", "utf8"),
  ]);
  baseline = evaluateTaskTrials(parseEvaluationManifest(JSON.parse(manifestJson)), parseEvaluationTrials(JSON.parse(trialsJson)));
});

describe("evaluation drift", () => {
  it("accepts a comparable report with no regression", () => {
    const current = structuredClone(baseline);
    current.implementationVersion = "dev-reference-v2";
    expect(compareEvaluationReports(baseline, current)).toMatchObject({ passed: true, comparable: true, failures: [] });
  });

  it("rejects denominator, safety and metric regressions", () => {
    const current = structuredClone(baseline);
    current.metrics.requiredOperationCoverage.denominator += 1;
    current.metrics.requiredOperationCoverage.value = 0.9;
    current.counts.forbiddenOperations = 1;
    const drift = compareEvaluationReports(baseline, current);
    expect(drift.passed).toBe(false);
    expect(drift.failures).toEqual(expect.arrayContaining([
      "metric_denominator_drift:requiredOperationCoverage:12:13",
      "safety_regression:forbiddenOperations:0:1",
    ]));
    expect(drift.failures.some((failure) => failure.startsWith("metric_regression:requiredOperationCoverage"))).toBe(true);
  });

  it("marks changed model or prompt versions as incomparable", () => {
    const current = structuredClone(baseline);
    current.modelId = "another-model";
    current.promptVersion = "prompt-v2";
    const drift = compareEvaluationReports(baseline, current);
    expect(drift).toMatchObject({ passed: false, comparable: false });
    expect(drift.failures).toEqual(expect.arrayContaining([
      "incomparable:modelId:replay-model-v1:another-model",
      "incomparable:promptVersion:prompt-v1:prompt-v2",
    ]));
  });

  it("parses generated reports before comparison", () => {
    expect(parseEvaluationReport(JSON.parse(JSON.stringify(baseline)))).toMatchObject({ schemaVersion: "interec-eval-report-v1", passed: true });
  });
});
