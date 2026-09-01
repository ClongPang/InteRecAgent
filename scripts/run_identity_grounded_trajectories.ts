import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  emptyQuoteConversationState,
  findProductIdentityCandidates,
  type PublishedQuoteLeadSet,
  type QuoteAssistantOutcome,
  type QuoteConversationState,
} from "@interec/domain";
import {
  QuoteConversationTurnExecutor,
  QuotePlanReviewError,
  type QuoteTurnPlanProposal,
} from "../packages/agent/src/quote-turn-executor.js";
import { createLexicallyGroundedIdentityHypothesis } from "../packages/agent/src/identity-hypothesis.js";
import {
  providerResult,
  resolveFixtureTarget,
  type ProviderFixture,
} from "./identity-grounded-trajectory-fixtures.js";
import { trajectoryIdentitySnapshot } from "./identity-grounded-identity-fixture.js";

function identityCandidates(rawText: string) {
  return findProductIdentityCandidates(trajectoryIdentitySnapshot, [rawText])
    .map((candidate) => ({ ...candidate, registryVersion: trajectoryIdentitySnapshot.registryVersion }));
}

type Route = "talk" | "clarify" | "quote_followup" | "quote_lookup";

interface ExpectedState {
  targetModel?: string | null;
  pendingModel?: string | null;
  leadOutcome?: PublishedQuoteLeadSet["outcome"];
  displayCount?: number;
  excludedCount?: number;
  comparisonCount?: number;
  normalizationChanges?: string[];
  leadObservationCounts?: number[];
  identityStrength?: string;
  identityRegistryVersion?: number | null;
  identityEvidenceRefs?: string[];
}

interface SuccessfulTurn {
  id: string;
  user: string;
  proposal: QuoteTurnPlanProposal;
  providerFixture?: ProviderFixture;
  expected: {
    route: Route;
    operationKinds: string[];
    providerCalls: number;
    outcome: QuoteAssistantOutcome;
    state: ExpectedState;
    replyIncludes?: string[];
    disclosureCodes?: string[];
  };
}

interface RejectedPlan {
  id: string;
  user: string;
  proposal: QuoteTurnPlanProposal;
  baseFixture?: "RESULTS_ONE";
  expectedViolation: string;
  providerCalls: number;
}

interface FailedEffectPlan {
  id: string;
  baseFixture: "RESULTS_ONE";
  user: string;
  proposal: QuoteTurnPlanProposal;
  providerError: string;
  expected: {
    providerCalls: 1;
    outcome: "DEGRADED";
    preservedTargetModel: string;
    preservedLeadOutcome: PublishedQuoteLeadSet["outcome"];
    preservedDisplayCount: number;
  };
}

interface TrajectorySpec {
  schemaVersion: number;
  contractVersion: string;
  baseProductContract: string;
  routeVocabulary: Route[];
  forbiddenReplyFragments: string[];
  trajectories: Array<{ id: string; turns: SuccessfulTurn[] }>;
  effectFailures: FailedEffectPlan[];
  rejectedPlans: RejectedPlan[];
}

function bindDynamicValues(proposal: QuoteTurnPlanProposal, state: QuoteConversationState, rawText: string): QuoteTurnPlanProposal {
  const value = structuredClone(proposal);
  for (const operation of value.ops) {
    if (operation.kind === "SET_QUOTE_TARGET" && !operation.identityHypothesis) {
      operation.identityHypothesis = createLexicallyGroundedIdentityHypothesis(rawText, operation.sourceMessageOrdinal, operation.target);
    }
    if (operation.kind === "CONFIRM_QUOTE_TARGET" && operation.confirmationId === "$PENDING_CONFIRMATION_ID") {
      assert.ok(state.pendingTargetConfirmation, "trajectory requested a confirmation token without pending state");
      operation.confirmationId = state.pendingTargetConfirmation.confirmationId;
    }
  }
  return value;
}

function assertExpectedState(state: QuoteConversationState, expected: ExpectedState, label: string): void {
  if ("targetModel" in expected) assert.equal(state.target?.canonicalModel ?? null, expected.targetModel, `${label}: target model`);
  if ("pendingModel" in expected) assert.equal(state.pendingTargetConfirmation?.proposal.proposedModel ?? null, expected.pendingModel, `${label}: pending model`);
  if (expected.leadOutcome !== undefined) assert.equal(state.leadSet?.outcome, expected.leadOutcome, `${label}: lead outcome`);
  if (expected.displayCount !== undefined) assert.equal(state.displayQuoteLeadRefs.length, expected.displayCount, `${label}: display count`);
  if (expected.excludedCount !== undefined) assert.equal(state.excludedQuoteLeadRefs.length, expected.excludedCount, `${label}: excluded count`);
  if (expected.comparisonCount !== undefined) assert.equal(state.comparisonQuoteLeadRefs.length, expected.comparisonCount, `${label}: comparison count`);
  if (expected.normalizationChanges !== undefined) assert.deepEqual(state.target?.normalizationChanges ?? [], expected.normalizationChanges, `${label}: normalization changes`);
  if (expected.leadObservationCounts !== undefined) {
    assert.deepEqual(state.leadSet?.leads.map((item) => item.observationCount) ?? [], expected.leadObservationCounts, `${label}: observation counts`);
  }
  if (expected.identityStrength !== undefined) assert.equal(state.target?.identity.strength, expected.identityStrength, `${label}: identity strength`);
  if ("identityRegistryVersion" in expected) assert.equal(state.target?.identity.registryVersion ?? null, expected.identityRegistryVersion, `${label}: identity registry version`);
  if (expected.identityEvidenceRefs !== undefined) assert.deepEqual(state.target?.identity.evidenceRefs ?? [], expected.identityEvidenceRefs, `${label}: identity evidence refs`);
}

function validateSpec(spec: TrajectorySpec): void {
  assert.equal(spec.schemaVersion, 1, "trajectory schemaVersion");
  assert.equal(spec.contractVersion, "identity-grounded-quote-v1", "trajectory contract version");
  assert.equal(spec.baseProductContract, "quote-leads-sg-v1", "trajectory base contract");
  assert.deepEqual([...spec.routeVocabulary].sort(), ["clarify", "quote_followup", "quote_lookup", "talk"], "route vocabulary");
  assert.ok(spec.trajectories.length >= 8, "at least eight executable trajectories are required");
  assert.ok(spec.rejectedPlans.length >= 5, "at least five rejected host plans are required");
  assert.ok(spec.effectFailures.length >= 1, "at least one failed-effect atomicity case is required");
  const ids = [...spec.trajectories.map((item) => item.id), ...spec.effectFailures.map((item) => item.id), ...spec.rejectedPlans.map((item) => item.id)];
  assert.equal(new Set(ids).size, ids.length, "trajectory and rejection ids must be unique");
  const routes = new Set(spec.trajectories.flatMap((item) => item.turns.map((turn) => turn.expected.route)));
  for (const route of spec.routeVocabulary) assert.ok(routes.has(route), `route is not executed: ${route}`);
  for (const trajectory of spec.trajectories) {
    assert.ok(trajectory.turns.length >= 2, `${trajectory.id}: multi-turn trajectory required`);
    for (const turn of trajectory.turns) {
      assert.deepEqual(turn.proposal.ops.map((operation) => operation.kind), turn.expected.operationKinds, `${trajectory.id}/${turn.id}: operation contract drift`);
      assert.ok(turn.expected.providerCalls === 0 || turn.expected.providerCalls === 1, `${trajectory.id}/${turn.id}: provider call budget`);
      assert.equal(Boolean(turn.providerFixture), turn.expected.providerCalls === 1, `${trajectory.id}/${turn.id}: fixture/call mismatch`);
    }
  }
}

async function runFailedEffects(spec: TrajectorySpec): Promise<void> {
  for (const failure of spec.effectFailures) {
    const target = resolveFixtureTarget();
    const leadSet = providerResult(target, failure.baseFixture, 1);
    const baseState: QuoteConversationState = {
      ...emptyQuoteConversationState(1),
      target,
      leadSet,
      displayQuoteLeadRefs: leadSet.leads.map((item) => item.quoteLeadRef),
    };
    let providerCalls = 0;
    const drafts: QuoteConversationState[] = [];
    const executor = new QuoteConversationTurnExecutor({
      turnId: `failed-effect-${failure.id}`,
      inputMessageIds: [`message-${failure.id}`],
      inputMessageContents: [failure.user],
      baseState,
      identitySnapshot: trajectoryIdentitySnapshot,
      identityCandidates: identityCandidates(failure.user),
      publicationRevision: baseState.version + 1,
      quoteEffects: {
        execute: async () => {
          providerCalls += 1;
          throw new Error(failure.providerError);
        },
      },
      onDraftChanged: async ({ state }) => {
        drafts.push(state);
      },
    });
    await assert.rejects(executor.execute(bindDynamicValues(failure.proposal, baseState, failure.user)), new RegExp(failure.providerError, "u"));
    assert.equal(drafts.length, 0, `${failure.id}: failed effect published a partial draft`);
    const fallback = await executor.fallback(failure.providerError);
    assert.equal(providerCalls, failure.expected.providerCalls, `${failure.id}: provider calls`);
    assert.equal(fallback.reply.outcome, failure.expected.outcome, `${failure.id}: outcome`);
    assert.equal(fallback.state.version, baseState.version + 1, `${failure.id}: version`);
    assert.equal(fallback.state.target?.canonicalModel, failure.expected.preservedTargetModel, `${failure.id}: preserved target`);
    assert.equal(fallback.state.leadSet?.outcome, failure.expected.preservedLeadOutcome, `${failure.id}: preserved lead outcome`);
    assert.equal(fallback.state.displayQuoteLeadRefs.length, failure.expected.preservedDisplayCount, `${failure.id}: preserved display`);
    assert.deepEqual({ ...fallback.state, version: baseState.version }, baseState, `${failure.id}: complete pre-effect state`);
    assert.equal(drafts.length, 1, `${failure.id}: only fallback may publish a draft`);
  }
}

async function runSuccessfulTrajectories(spec: TrajectorySpec): Promise<{ turns: number; providerCalls: number }> {
  let executedTurns = 0;
  let totalProviderCalls = 0;
  for (const trajectory of spec.trajectories) {
    let state = emptyQuoteConversationState();
    for (const [turnIndex, turn] of trajectory.turns.entries()) {
      const label = `${trajectory.id}/${turn.id}`;
      let providerCalls = 0;
      const priorVersion = state.version;
      const proposal = bindDynamicValues(turn.proposal, state, turn.user);
      const executor = new QuoteConversationTurnExecutor({
        turnId: `trajectory-${trajectory.id}-${turn.id}`,
        inputMessageIds: [`message-${trajectory.id}-${turnIndex}`],
        inputMessageContents: [turn.user],
        baseState: state,
        identitySnapshot: trajectoryIdentitySnapshot,
        identityCandidates: identityCandidates(turn.user),
        publicationRevision: state.version + 1,
        quoteEffects: {
          execute: async (effect) => {
            providerCalls += 1;
            assert.ok(turn.providerFixture, `${label}: unexpected provider call`);
            return { status: "SUCCEEDED", leadSet: providerResult(effect.target, turn.providerFixture, providerCalls) };
          },
        },
      });
      const result = await executor.execute(proposal);
      assert.equal(result.review.route, turn.expected.route, `${label}: route`);
      assert.equal(result.review.providerCallsAllowed, turn.expected.providerCalls, `${label}: authorized provider calls`);
      assert.deepEqual(result.plan.ops.map((operation) => operation.kind), turn.expected.operationKinds, `${label}: operations`);
      assert.equal(providerCalls, turn.expected.providerCalls, `${label}: provider calls`);
      assert.equal(result.receipts.filter((receipt) => receipt.providerCalled).length, turn.expected.providerCalls, `${label}: provider receipts`);
      assert.equal(result.reply.outcome, turn.expected.outcome, `${label}: outcome`);
      assert.deepEqual(result.reply.addressedOpIds, result.plan.ops.map((operation) => operation.opId), `${label}: addressed operation ids`);
      assert.equal(result.state.version, priorVersion + 1, `${label}: monotone state version`);
      assertExpectedState(result.state, turn.expected.state, label);
      for (const fragment of turn.expected.replyIncludes ?? []) {
        assert.ok(result.reply.text.includes(fragment), `${label}: reply missing ${fragment}; actual=${result.reply.text}`);
      }
      for (const forbidden of spec.forbiddenReplyFragments) {
        assert.ok(!result.reply.text.toLocaleLowerCase("en-US").includes(forbidden.toLocaleLowerCase("en-US")), `${label}: forbidden claim ${forbidden}`);
      }
      assert.ok(!/https?:\/\//iu.test(result.reply.text), `${label}: reply must not inline provider URLs`);
      if (turn.expected.disclosureCodes) assert.deepEqual(result.reply.disclosureCodes, turn.expected.disclosureCodes, `${label}: disclosures`);
      state = result.state;
      executedTurns += 1;
      totalProviderCalls += providerCalls;
    }
  }
  return { turns: executedTurns, providerCalls: totalProviderCalls };
}

async function runRejectedPlans(spec: TrajectorySpec): Promise<void> {
  for (const rejected of spec.rejectedPlans) {
    let providerCalls = 0;
    let draftChanged = false;
    let baseState = emptyQuoteConversationState();
    if (rejected.baseFixture) {
      const target = resolveFixtureTarget();
      const leadSet = providerResult(target, rejected.baseFixture, 1);
      baseState = {
        ...emptyQuoteConversationState(1),
        target,
        leadSet,
        displayQuoteLeadRefs: leadSet.leads.map((item) => item.quoteLeadRef),
      };
    }
    const executor = new QuoteConversationTurnExecutor({
      turnId: `rejected-${rejected.id}`,
      inputMessageIds: [`message-${rejected.id}`],
      inputMessageContents: [rejected.user],
      baseState,
      identitySnapshot: trajectoryIdentitySnapshot,
      identityCandidates: identityCandidates(rejected.user),
      publicationRevision: baseState.version + 1,
      quoteEffects: {
        execute: async (effect) => {
          providerCalls += 1;
          return { status: "SUCCEEDED", leadSet: providerResult(effect.target, "RESULTS_ONE", providerCalls) };
        },
      },
      onDraftChanged: async () => {
        draftChanged = true;
      },
    });
    let caught: unknown;
    try {
      await executor.execute(bindDynamicValues(rejected.proposal, baseState, rejected.user));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof QuotePlanReviewError, `${rejected.id}: host must reject the plan before execution`);
    assert.equal(caught.review.violations[0]?.code, rejected.expectedViolation, `${rejected.id}: violation`);
    assert.equal(providerCalls, rejected.providerCalls, `${rejected.id}: provider calls`);
    assert.equal(draftChanged, false, `${rejected.id}: rejected plan must not publish a draft`);
    assert.equal(baseState.version, rejected.baseFixture ? 1 : 0, `${rejected.id}: base state must remain unchanged`);
  }
}

const specUrl = new URL("../spec/identity-grounded-agent-trajectories.json", import.meta.url);
const spec = JSON.parse(await readFile(specUrl, "utf8")) as TrajectorySpec;
validateSpec(spec);
const successful = await runSuccessfulTrajectories(spec);
await runFailedEffects(spec);
await runRejectedPlans(spec);

console.log(
  `identity-grounded trajectories: ${spec.trajectories.length} multi-turn trajectories, ${successful.turns} turns, ${spec.effectFailures.length} failed effect, ${spec.rejectedPlans.length} rejected plans, ${successful.providerCalls} controlled successful provider calls`,
);
