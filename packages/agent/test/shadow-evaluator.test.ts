import { describe, expect, it } from "vitest";

import {
  evaluateShadowResults,
  parseShadowPolicy,
  parseShadowResults,
  type ShadowConversationResult,
  type ShadowPolicy,
} from "../src/shadow-evaluator.js";

const routes = ["talk", "clarify", "refilter", "sort", "search"];
const policy: ShadowPolicy = { minimumRouteCounts: Object.fromEntries(routes.map((route) => [route, 10])) };

function passingCorpus(): ShadowConversationResult[] {
  return Array.from({ length: 300 }, (_, conversationIndex) => ({
    source: "REAL_SHADOW",
    conversationId: `shadow-${conversationIndex}`,
    implementationVersion: "release-a",
    modelId: "model-a",
    turns: Array.from({ length: conversationIndex < 200 ? 4 : 2 }, (_, turnIndex) => ({
      route: routes[(conversationIndex + turnIndex) % routes.length]!,
      reviewerIds: conversationIndex < 100 && turnIndex === 0 ? ["reviewer-a", "reviewer-b"] : [],
    })),
  }));
}

describe("real Shadow evaluator", () => {
  it("enforces volume, longitudinal, review, version and approved route quotas", () => {
    expect(evaluateShadowResults(passingCorpus(), policy)).toMatchObject({
      passed: true,
      turnCount: 1000,
      threePlusTurnConversationCount: 200,
      doubleReviewedTurnCount: 100,
      failures: [],
    });
  });

  it("reports route and version drift", () => {
    const corpus = passingCorpus();
    corpus[0]!.implementationVersion = "release-b";
    corpus[0]!.modelId = "model-b";
    const report = evaluateShadowResults(
      corpus,
      { minimumRouteCounts: { ...policy.minimumRouteCounts, clarify: 1000 } },
      { implementationVersion: "release-a", modelId: "model-a" },
    );
    expect(report.failures).toEqual(expect.arrayContaining([
      "mixed_implementation_versions",
      "mixed_model_ids",
      "unexpected_implementation_version",
      "unexpected_model_id",
      expect.stringMatching(/^route_quota:clarify:/),
    ]));
  });

  it("requires explicit route quotas and rejects non-real samples", () => {
    expect(() => parseShadowPolicy({ minimumRouteCounts: { talk: 1 } })).toThrow("SHADOW_POLICY_ROUTE_INVALID:clarify");
    const raw = passingCorpus() as unknown as Array<Record<string, unknown>>;
    raw[0] = { ...raw[0], source: "SYNTHETIC" };
    expect(() => parseShadowResults(raw)).toThrow("SHADOW_SOURCE_NOT_REAL");
  });
});
