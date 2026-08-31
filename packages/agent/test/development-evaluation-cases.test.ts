import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fingerprintEvaluationAuthoringPlan, parseEvaluationAuthoringPlan } from "../src/evaluation-authoring-plan.js";
import { parseDevelopmentEvaluationCases, validateDevelopmentEvaluationCases } from "../src/development-evaluation-cases.js";

function fixtures() {
  const plan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync("spec/evaluation/gold-v1/evaluation-authoring-plan.json", "utf8")));
  const cases = parseDevelopmentEvaluationCases(JSON.parse(readFileSync("spec/evaluation/gold-v1/development-evaluation-cases.json", "utf8")));
  return { plan, cases, hash: fingerprintEvaluationAuthoringPlan(plan) };
}

describe("development evaluation cases", () => {
  it("provides concrete non-metric wording for every plan task", () => {
    const { plan, cases, hash } = fixtures();
    expect(() => validateDevelopmentEvaluationCases(cases, plan, hash)).not.toThrow();
    expect(cases.cases).toHaveLength(39);
    expect(cases.cases.reduce((sum, entry) => sum + entry.userTurns.length, 0)).toBeGreaterThanOrEqual(78);
    expect(cases.eligibleForResumeMetrics).toBe(false);
    expect(cases.cases.filter((entry) => entry.turnExpectations !== undefined).map((entry) => entry.taskId)).toEqual([
      "gbv1-clarify_resume-01",
      "gbv1-clarify_resume-02",
      "gbv1-clarify_resume-03",
    ]);
    expect(cases.cases.filter((entry) => entry.focusDisplayRank !== undefined).map((entry) => entry.taskId).sort()).toEqual([
      "gbv1-compare_existing-02",
      "gbv1-focus_and_restart-01",
      "gbv1-focus_and_restart-03",
      "gbv1-unknown_facts-01",
    ]);
  });

  it("rejects an environment action that drifts from the business plan", () => {
    const { plan, cases, hash } = fixtures();
    const mutated = structuredClone(cases);
    mutated.cases[0]!.environmentAction = "WORKER_RESTART";
    expect(() => validateDevelopmentEvaluationCases(mutated, plan, hash)).toThrow("DEVELOPMENT_EVAL_ENVIRONMENT_MISMATCH");
  });

  it("rejects evaluator meta-language in a user utterance", () => {
    const { plan, cases, hash } = fixtures();
    const mutated = structuredClone(cases);
    mutated.cases[0]!.userTurns[0] = "璇疯璇勫垎鍣ㄦ鏌?working set";
    expect(() => validateDevelopmentEvaluationCases(mutated, plan, hash)).toThrow("DEVELOPMENT_EVAL_META_LANGUAGE");
  });
});
