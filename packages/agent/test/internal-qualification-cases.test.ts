import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fingerprintGoldBlueprint, parseGoldBlueprint } from "../src/gold-blueprint.js";
import { parseInternalQualificationCases, validateInternalQualificationCases } from "../src/internal-qualification-cases.js";

function fixtures() {
  const blueprint = parseGoldBlueprint(JSON.parse(readFileSync("spec/evaluation/gold-v1/authoring-blueprint.json", "utf8")));
  const cases = parseInternalQualificationCases(JSON.parse(readFileSync("spec/evaluation/gold-v1/internal-qualification-cases.json", "utf8")));
  return { blueprint, cases, hash: fingerprintGoldBlueprint(blueprint) };
}

describe("internal qualification cases", () => {
  it("provides concrete non-metric wording for every blueprint task", () => {
    const { blueprint, cases, hash } = fixtures();
    expect(() => validateInternalQualificationCases(cases, blueprint, hash)).not.toThrow();
    expect(cases.cases).toHaveLength(39);
    expect(cases.cases.reduce((sum, entry) => sum + entry.userTurns.length, 0)).toBeGreaterThanOrEqual(78);
    expect(cases.eligibleForResumeMetrics).toBe(false);
    expect(cases.cases.filter((entry) => entry.focusDisplayRank !== undefined).map((entry) => entry.taskId).sort()).toEqual([
      "gbv1-compare_existing-02",
      "gbv1-focus_and_restart-01",
      "gbv1-focus_and_restart-03",
      "gbv1-unknown_facts-01",
    ]);
  });

  it("rejects an environment action that drifts from the business blueprint", () => {
    const { blueprint, cases, hash } = fixtures();
    const mutated = structuredClone(cases);
    mutated.cases[0]!.environmentAction = "WORKER_RESTART";
    expect(() => validateInternalQualificationCases(mutated, blueprint, hash)).toThrow("QUALIFICATION_ENVIRONMENT_MISMATCH");
  });

  it("rejects evaluator meta-language in a user utterance", () => {
    const { blueprint, cases, hash } = fixtures();
    const mutated = structuredClone(cases);
    mutated.cases[0]!.userTurns[0] = "请让评分器检查 working set";
    expect(() => validateInternalQualificationCases(mutated, blueprint, hash)).toThrow("QUALIFICATION_META_LANGUAGE");
  });
});
