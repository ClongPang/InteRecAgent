import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseGoldBlueprint, validateGoldBlueprint } from "../src/gold-blueprint.js";

function loadFixture(): { blueprint: ReturnType<typeof parseGoldBlueprint>; contract: { requiredCapabilities: string[]; invariantIds: string[] } } {
  const blueprint = parseGoldBlueprint(JSON.parse(readFileSync("spec/evaluation/gold-v1/authoring-blueprint.json", "utf8")));
  const raw = JSON.parse(readFileSync("spec/conversational-agent-product-contract.json", "utf8")) as {
    requiredCapabilities: string[];
    invariants: Array<{ id: string }>;
  };
  return { blueprint, contract: { requiredCapabilities: raw.requiredCapabilities, invariantIds: raw.invariants.map((item) => item.id) } };
}

describe("Gold authoring blueprint", () => {
  it("freezes 39 diverse task intentions while remaining ineligible for resume metrics", () => {
    const { blueprint, contract } = loadFixture();
    const report = validateGoldBlueprint(blueprint, contract);

    expect(blueprint.status).toBe("AUTHORING_CANDIDATE");
    expect(blueprint.eligibleForResumeMetrics).toBe(false);
    expect(report.taskCount).toBe(39);
    expect(Object.values(report.familyCounts)).toEqual(expect.arrayContaining([3]));
    expect(Object.values(report.familyCounts).every((count) => count === 3)).toBe(true);
    expect(report.positiveTaskCount).toBeGreaterThanOrEqual(18);
    expect(report.plannedFactDenominator).toBeGreaterThanOrEqual(108);
    expect(report.semanticSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a same-family variant that changes fewer than two axes", () => {
    const { blueprint, contract } = loadFixture();
    const mutated = structuredClone(blueprint);
    mutated.tasks[1]!.variationProfile = structuredClone(mutated.tasks[0]!.variationProfile);

    expect(() => validateGoldBlueprint(mutated, contract)).toThrow(/BLUEPRINT_VARIATION_WEAK/u);
  });

  it("rejects attempts to present the authoring blueprint as sealed evidence", () => {
    const raw = JSON.parse(readFileSync("spec/evaluation/gold-v1/authoring-blueprint.json", "utf8")) as Record<string, unknown>;
    raw["eligibleForResumeMetrics"] = true;

    expect(() => parseGoldBlueprint(raw)).toThrow("BLUEPRINT_CANNOT_AUTHORIZE_RESUME_METRICS");
  });

  it("rejects missing independent coverage even when task count remains 39", () => {
    const { blueprint, contract } = loadFixture();
    const mutated = structuredClone(blueprint);
    for (const task of mutated.tasks) task.capabilities = task.capabilities.filter((item) => item !== "provider_partial_failure");

    expect(() => validateGoldBlueprint(mutated, contract)).toThrow(/BLUEPRINT_FAMILY_CAPABILITY_MISSING|BLUEPRINT_CAPABILITY_UNCOVERED/u);
  });

  it("rejects a target archetype that is not backed by the current capability design", () => {
    const { blueprint, contract } = loadFixture();
    const mutated = structuredClone(blueprint);
    mutated.tasks[0]!.variationProfile.targetArchetype = "VERIFIED_COMPUTER_ACCESSORY";

    expect(() => validateGoldBlueprint(mutated, contract)).toThrow("BLUEPRINT_TARGET_ARCHETYPE_UNSUPPORTED");
  });
});
