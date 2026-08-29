import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  evaluateTaskTrials,
  parseEvaluationManifest,
  parseEvaluationTrials,
  type EvaluationManifest,
  type EvaluationTrialArtifact,
} from "../src/task-evaluator.js";

let manifest: EvaluationManifest;
let trials: EvaluationTrialArtifact[];

beforeAll(async () => {
  const [manifestJson, trialsJson] = await Promise.all([
    readFile("spec/evaluation/dev/manifest.json", "utf8"),
    readFile("spec/evaluation/dev/trials.json", "utf8"),
  ]);
  manifest = parseEvaluationManifest(JSON.parse(manifestJson));
  trials = parseEvaluationTrials(JSON.parse(trialsJson));
});

describe("task-level evaluation", () => {
  it("scores the complete three-run development corpus", () => {
    const report = evaluateTaskTrials(manifest, trials);
    expect(report).toMatchObject({ passed: true, validTrialCount: 6, stableTaskCount: 2, failures: [] });
    expect(report.metrics.requiredOperationCoverage).toMatchObject({ numerator: 12, denominator: 12, value: 1 });
    expect(report.metrics.requiredAnswerRecall).toMatchObject({ numerator: 12, denominator: 12, value: 1 });
  });

  it("fails a recommendation that is not independently qualified for recommendation", () => {
    const mutated = structuredClone(trials);
    const turn = mutated[0]!.turns[1]!;
    turn.recommendedOfferRefs = ["offer-b"];
    turn.operations[0]!.resolvedOfferRefs = ["offer-b"];
    const report = evaluateTaskTrials(manifest, mutated);
    expect(report.passed).toBe(false);
    expect(report.counts.wrongCandidateRecommendations).toBe(1);
    expect(report.failures).toEqual(expect.arrayContaining(["wrong_candidate_recommendations:1"]));
  });

  it("counts unannotated visible facts as inconsistent instead of dropping them", () => {
    const mutated = structuredClone(trials);
    mutated[0]!.turns[1]!.unannotatedUserVisibleFactCount = 1;
    const report = evaluateTaskTrials(manifest, mutated);
    expect(report.metrics.factEvidenceConsistency).toMatchObject({ numerator: 3, denominator: 4, value: 0.75, passed: false });
    expect(report.counts.inconsistentFacts).toBe(1);
  });

  it("rejects a version-mismatched artifact rather than scoring mixed runs", () => {
    const mutated = structuredClone(trials);
    mutated[0]!.modelParametersHash = "sha256:different";
    const report = evaluateTaskTrials(manifest, mutated);
    expect(report.passed).toBe(false);
    expect(report.validTrialCount).toBe(5);
    expect(report.failures).toEqual(expect.arrayContaining(["version_mismatch:dev-positive-001-run-1"]));
  });

  it("requires multi-turn tasks and rejects unknown schema fields", async () => {
    const raw = JSON.parse(await readFile("spec/evaluation/dev/manifest.json", "utf8")) as Record<string, unknown>;
    const tasks = raw["tasks"] as Array<Record<string, unknown>>;
    tasks[0]!["turns"] = (tasks[0]!["turns"] as unknown[]).slice(0, 1);
    expect(() => parseEvaluationManifest(raw)).toThrow("EVAL_TURNS_INVALID");

    const trialRaw = JSON.parse(await readFile("spec/evaluation/dev/trials.json", "utf8")) as Array<Record<string, unknown>>;
    trialRaw[0]!["selfReportedSuccess"] = true;
    expect(() => parseEvaluationTrials(trialRaw)).toThrow("EVAL_FIELD_UNKNOWN");
  });
});
