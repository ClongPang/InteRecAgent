import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseEvaluationAuthoringPlan, validateEvaluationAuthoringPlan } from "../src/evaluation-authoring-plan.js";

function loadFixture(): { plan: ReturnType<typeof parseEvaluationAuthoringPlan>; contract: { requiredCapabilities: string[]; invariantIds: string[] } } {
  const plan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync("spec/evaluation/gold-v1/evaluation-authoring-plan.json", "utf8")));
  const raw = JSON.parse(readFileSync("spec/conversational-agent-product-contract.json", "utf8")) as {
    requiredCapabilities: string[];
    invariants: Array<{ id: string }>;
  };
  return { plan, contract: { requiredCapabilities: raw.requiredCapabilities, invariantIds: raw.invariants.map((item) => item.id) } };
}

describe("Evaluation authoring plan", () => {
  it("freezes 39 diverse task intentions while remaining ineligible for resume metrics", () => {
    const { plan, contract } = loadFixture();
    const report = validateEvaluationAuthoringPlan(plan, contract);

    expect(plan.status).toBe("AUTHORING_CANDIDATE");
    expect(plan.eligibleForResumeMetrics).toBe(false);
    expect(report.taskCount).toBe(39);
    expect(Object.values(report.familyCounts)).toEqual(expect.arrayContaining([3]));
    expect(Object.values(report.familyCounts).every((count) => count === 3)).toBe(true);
    expect(report.positiveTaskCount).toBeGreaterThanOrEqual(18);
    expect(report.plannedFactDenominator).toBeGreaterThanOrEqual(108);
    expect(report.semanticSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a same-family variant that changes fewer than two axes", () => {
    const { plan, contract } = loadFixture();
    const mutated = structuredClone(plan);
    mutated.tasks[1]!.variationProfile = structuredClone(mutated.tasks[0]!.variationProfile);

    expect(() => validateEvaluationAuthoringPlan(mutated, contract)).toThrow(/EVALUATION_PLAN_VARIATION_WEAK/u);
  });

  it("rejects attempts to present the authoring plan as held-out evaluation evidence", () => {
    const raw = JSON.parse(readFileSync("spec/evaluation/gold-v1/evaluation-authoring-plan.json", "utf8")) as Record<string, unknown>;
    raw["eligibleForResumeMetrics"] = true;

    expect(() => parseEvaluationAuthoringPlan(raw)).toThrow("EVALUATION_PLAN_CANNOT_AUTHORIZE_RESUME_METRICS");
  });

  it("rejects missing independent coverage even when task count remains 39", () => {
    const { plan, contract } = loadFixture();
    const mutated = structuredClone(plan);
    for (const task of mutated.tasks) task.capabilities = task.capabilities.filter((item) => item !== "provider_partial_failure");

    expect(() => validateEvaluationAuthoringPlan(mutated, contract)).toThrow(/EVALUATION_PLAN_FAMILY_CAPABILITY_MISSING|EVALUATION_PLAN_CAPABILITY_UNCOVERED/u);
  });

  it("rejects a target archetype that is not backed by the current capability design", () => {
    const { plan, contract } = loadFixture();
    const mutated = structuredClone(plan);
    mutated.tasks[0]!.variationProfile.targetArchetype = "VERIFIED_COMPUTER_ACCESSORY";

    expect(() => validateEvaluationAuthoringPlan(mutated, contract)).toThrow("EVALUATION_PLAN_TARGET_ARCHETYPE_UNSUPPORTED");
  });
});
