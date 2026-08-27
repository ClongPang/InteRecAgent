import { describe, expect, it } from "vitest";

import {
  evaluateGoldResults,
  parseGoldResults,
  REQUIRED_GOLD_TRAJECTORIES,
  type GoldConversationResult,
  type GoldTurnResult,
} from "../src/gold-evaluator.js";

const passingTurn: GoldTurnResult = {
  routeExpected: "talk",
  routeActual: "talk",
  schemaValid: true,
  hardConstraintStateValid: true,
  groundedClaimValid: true,
  outOfSetReferenceCount: 0,
  wrongProductPromotionCount: 0,
  zeroProviderExpected: true,
  providerCallCount: 0,
  expectedOperationCount: 2,
  recalledOperationCount: 2,
  referentCheckCount: 1,
  referentCorrectCount: 1,
  clarificationExpected: true,
  resumedWithinTwoTurns: true,
};

function passingCorpus(): GoldConversationResult[] {
  return Array.from({ length: 100 }, (_, index) => ({
    source: "REAL_MODEL_HUMAN_REVIEWED",
    conversationId: `conversation-${index}`,
    implementationVersion: "release-a",
    modelId: "model-a",
    trajectoryId: REQUIRED_GOLD_TRAJECTORIES[index % REQUIRED_GOLD_TRAJECTORIES.length]!,
    reviewerId: `reviewer-${index % 3}`,
    criticalPass: true,
    turns: Array.from({ length: index < 50 ? 3 : 2 }, () => ({ ...passingTurn })),
  }));
}

describe("real-model gold evaluator", () => {
  it("passes only when every release threshold is represented", () => {
    expect(evaluateGoldResults(passingCorpus())).toMatchObject({ passed: true, conversationCount: 100, threePlusTurnConversationCount: 50, failures: [] });
  });

  it("reports safety and quality failures without hiding them in an average", () => {
    const corpus = passingCorpus();
    corpus[0]!.turns[0] = { ...passingTurn, outOfSetReferenceCount: 1, providerCallCount: 1, groundedClaimValid: false };
    const report = evaluateGoldResults(corpus);
    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining(["metric:groundedClaimValidity", "out_of_set_references:1", "zero_provider_violations:1"]));
  });

  it("binds reviewed results to the expected implementation and model release", () => {
    const corpus = passingCorpus();
    corpus[0]!.modelId = "model-b";
    const report = evaluateGoldResults(corpus, { implementationVersion: "release-a", modelId: "model-a" });
    expect(report.failures).toEqual(expect.arrayContaining(["mixed_model_ids", "unexpected_model_id"]));
  });

  it("rejects fixture-like or duplicate records before scoring", () => {
    const raw = passingCorpus() as unknown as Array<Record<string, unknown>>;
    raw[0] = { ...raw[0], source: "OFFLINE_FIXTURE" };
    expect(() => parseGoldResults(raw)).toThrow("GOLD_SOURCE_NOT_REAL_MODEL");
    const duplicate = passingCorpus() as unknown as Array<Record<string, unknown>>;
    duplicate[1] = { ...duplicate[1], conversationId: duplicate[0]!["conversationId"] };
    expect(() => parseGoldResults(duplicate)).toThrow("GOLD_CONVERSATION_DUPLICATE");
  });
});
