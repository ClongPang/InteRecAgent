import { describe, expect, it } from "vitest";

import type { EvaluationAuthoringPlan, DevelopmentEvaluationCases } from "@interec/agent";
import {
  buildDevelopmentEvaluationDatasetItems,
  buildDevelopmentEvaluationTraceScorePlan,
  deterministicUuidV5,
  evaluateEvaluationExperimentTrial,
} from "../src/langfuse-evaluation.js";

const task = {
  taskId: "task-01",
  family: "clarify_resume",
  title: "multi-turn task",
  businessRisk: "losing constraints",
  variationProfile: {
    targetArchetype: "RULE_VALIDATED_HEADPHONES",
    marketPattern: "US_SG",
    budgetMode: "STRICT",
    languageStyle: "ZH",
    candidateOrder: "STABLE",
    environmentAction: "NONE",
  },
  turns: [
    { turnIndex: 1, intent: "clarify", mustObserve: ["no search"] },
    { turnIndex: 2, intent: "resume", mustObserve: ["same conversation"] },
  ],
  fixtureOutcome: "QUALIFIED_RECOMMENDATION",
  requiresQualifiedOutput: true,
  minRequiredResponseFields: 2,
  capabilities: ["clarification_resume"],
  invariants: ["INV-1"],
  criticalSlices: ["POSITIVE_OUTPUT"],
  independentReviewerBrief: ["review state continuity"],
} satisfies EvaluationAuthoringPlan["tasks"][number];

const plan = {
  schemaVersion: "interec-evaluation-authoring-plan-v1",
  planVersion: "gold-v1",
  status: "AUTHORING_CANDIDATE",
  eligibleForResumeMetrics: false,
  authoringRole: "test",
  independenceBoundary: "test",
  externalInvariantGates: [{ invariantId: "INV-1", gate: "gate" }],
  tasks: [task],
} satisfies EvaluationAuthoringPlan;

const cases = {
  schemaVersion: "interec-development-evaluation-cases-v1",
  evaluationScope: "DEVELOPMENT_EVALUATION",
  eligibleForResumeMetrics: false,
  planVersion: "gold-v1",
  planSemanticSha256: `sha256:${"a".repeat(64)}`,
  cases: [{
    taskId: "task-01",
    fixtureSeed: "HEADPHONES_XM5",
    environmentAction: "NONE",
    userTurns: ["first", "second"],
  }],
} satisfies DevelopmentEvaluationCases;

describe("Langfuse evaluation projection", () => {
  it("creates stable project-global item ids and preserves the multi-turn task", () => {
    const first = buildDevelopmentEvaluationDatasetItems(plan, cases, {
      casesSha256: `sha256:${"b".repeat(64)}`,
      fixtureVersion: "fixture-v1",
      fixtureSha256: `sha256:${"c".repeat(64)}`,
    });
    const second = buildDevelopmentEvaluationDatasetItems(plan, cases, {
      casesSha256: `sha256:${"b".repeat(64)}`,
      fixtureVersion: "fixture-v1",
      fixtureSha256: `sha256:${"c".repeat(64)}`,
    });
    expect(first).toEqual(second);
    expect(first[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[0]?.input.userTurns).toEqual(["first", "second"]);
    expect(first[0]?.expectedOutput.turns).toHaveLength(2);
    expect(first[0]?.metadata.eligibleForResumeMetrics).toBe(false);
    expect(deterministicUuidV5("same")).toBe(deterministicUuidV5("same"));
  });

  it("binds trial-level scores only to the final turn trace", () => {
    const trace1 = "1".repeat(32);
    const trace2 = "2".repeat(32);
    const run = {
      evaluationScope: "DEVELOPMENT_EVALUATION",
      eligibleForResumeMetrics: false,
      planSemanticSha256: `sha256:${"a".repeat(64)}`,
      fixtureSha256: `sha256:${"b".repeat(64)}`,
      implementationSha256: `sha256:${"c".repeat(64)}`,
      trials: [{
        trialId: "task-01-run-1",
        taskId: "task-01",
        runIndex: 1,
        turnEvidence: [{ trace_id: trace1 }, { trace_id: trace2 }],
      }],
    };
    const score = {
      evaluationScope: "DEVELOPMENT_EVALUATION",
      eligibleForResumeMetrics: false,
      planSemanticSha256: run.planSemanticSha256,
      fixtureSha256: run.fixtureSha256,
      implementationSha256: run.implementationSha256,
      evaluatorSha256: `sha256:${"d".repeat(64)}`,
      trials: [{
        trialId: "task-01-run-1",
        taskId: "task-01",
        passed: true,
        checks: {
          protocolClean: true,
          expectedOutcome: true,
          stateEffectsConsistent: true,
          behaviorInvariants: true,
        },
      }],
    };
    const plan = buildDevelopmentEvaluationTraceScorePlan(score, run);
    expect(plan).toHaveLength(5);
    expect(plan.every((entry) => entry.traceId === trace2)).toBe(true);
    expect(plan.find((entry) => entry.name === "development_eval_behavior_invariants")?.value).toBe(1);
    expect(plan[0]?.metadata["sourceTraceIds"]).toEqual([trace1, trace2]);
  });

  it("fails closed when evaluation traces are unavailable", () => {
    expect(() => buildDevelopmentEvaluationTraceScorePlan({
      evaluationScope: "DEVELOPMENT_EVALUATION",
      eligibleForResumeMetrics: false,
      planSemanticSha256: "same",
      fixtureSha256: "same",
      implementationSha256: "same",
      evaluatorSha256: `sha256:${"d".repeat(64)}`,
      trials: [{ trialId: "trial", taskId: "task", passed: true, checks: {} }],
    }, {
      evaluationScope: "DEVELOPMENT_EVALUATION",
      eligibleForResumeMetrics: false,
      planSemanticSha256: "same",
      fixtureSha256: "same",
      implementationSha256: "same",
      trials: [{ trialId: "trial", taskId: "task", runIndex: 1, turnEvidence: [] }],
    })).toThrow("LANGFUSE_SCORE_TRACE_MISSING");
  });

  it("evaluates a freshly executed experiment trial and requires complete trace links", () => {
    const expectedOutput = {
      fixtureOutcome: "QUALIFIED_RECOMMENDATION",
      requiresQualifiedOutput: true,
      minRequiredResponseFields: 2,
    };
    const trial = {
      status: "COMPLETED",
      turnEvidence: [{
        status: "COMPLETED",
        trace_id: "1".repeat(32),
        outcome: "RECOMMENDATION",
        draft_json: {},
        ledger_json: { claims: [{ claimId: "c1" }, { claimId: "c2" }] },
        envelope_json: { blocks: [] },
        search: [],
      }],
      finalState: {
        goalRevision: { version: 2 },
        workingSet: {
          boundGoalVersion: 2,
          pool: [{ offerRef: "offer-1" }],
          displayOfferRefs: ["offer-1"],
          mentionedOfferRefs: [],
          comparisonOfferRefs: [],
          rejectedOfferRefs: [],
        },
      },
    };
    const result = evaluateEvaluationExperimentTrial(trial, expectedOutput);
    expect(result.passed).toBe(true);
    expect(result.checks.traceComplete).toBe(true);
    expect(result.checks.behaviorInvariants).toBe(true);
    expect(result.observed.sourceTraceIds).toEqual(["1".repeat(32)]);

    const missingTrace = evaluateEvaluationExperimentTrial({
      ...trial,
      turnEvidence: [{ ...trial.turnEvidence[0], trace_id: null }],
    }, expectedOutput);
    expect(missingTrace.passed).toBe(false);
    expect(missingTrace.checks.traceComplete).toBe(false);
  });
});
