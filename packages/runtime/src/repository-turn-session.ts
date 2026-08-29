import {
  ConversationTurnDraftHost,
  toolNameForOperation,
  type TurnHostOperations,
  type TurnWorldPort,
} from "@interec/agent";
import type { ResearchNeed } from "@interec/domain";

import type {
  ClaimedConversationTurn,
  ConversationRepository,
  FinalCommitResult,
} from "./conversation-repository-types.js";
import { observeHostStep, recordGuardrailDecision } from "./telemetry.js";

export interface RepositoryTurnSessionOptions {
  researchNeed: ResearchNeed;
  world: TurnWorldPort;
  requiredFocusOfferRef?: string;
}

export interface RepositoryTurnSession {
  host: TurnHostOperations;
  getCommitResult(): FinalCommitResult | null;
}

function observedHost(host: ConversationTurnDraftHost): TurnHostOperations {
  return {
    commitPlan: (plan, signal) => observeHostStep(
      "commit-turn-plan",
      { operationKinds: plan.ops.map((operation) => operation.kind), leftoverCount: plan.leftover.length },
      () => host.commitPlan(plan),
      (committed) => ({ route: committed.route, operationCount: committed.plan.ops.length, maxModelInferences: committed.maxModelInferences }),
    ),
    executeOperation: (operation, signal) => {
      const toolName = toolNameForOperation(operation);
      return observeHostStep(
        `host-${toolName.replaceAll("_", "-")}`,
        { kind: operation.kind },
        () => host.executeOperation(operation, signal),
        (receipt) => ({
          status: receipt.status,
          claimCount: receipt.claimIds.length,
          questionCount: receipt.questionSlotIds.length,
          disclosureCount: receipt.disclosureCodes.length,
        }),
        { operationKind: operation.kind, hostToolName: toolName },
      );
    },
    publishReply: (envelope, signal) => observeHostStep(
      "publish-reply",
      { outcome: envelope.outcome, blockTypes: envelope.blocks.map((block) => block.type) },
      () => host.publishReply(envelope),
      (published) => ({ outcome: published.outcome, blockCount: published.blocks.length, addressedOperationCount: published.addressedOpIds.length }),
    ),
    fallbackReply: (errorCode, plan, receipts) => observeHostStep(
      "publish-fallback-reply",
      { errorCode, hasPlan: Boolean(plan), receiptCount: receipts.length },
      () => host.fallbackReply(errorCode, plan, receipts),
      (published) => ({ outcome: published.outcome, blockCount: published.blocks.length }),
      { errorCode },
    ),
  };
}

export function createRepositoryTurnSession(
  repository: ConversationRepository,
  claimed: ClaimedConversationTurn,
  options: RepositoryTurnSessionOptions,
): RepositoryTurnSession {
  let commitResult: FinalCommitResult | null = null;
  const fence = { turnId: claimed.id, attempt: claimed.attempt, fenceToken: claimed.fenceToken };
  const naturalMessageContents = claimed.inputMessages.every((message) => message.payload["type"] === "MESSAGE")
    ? claimed.inputMessages.map((message) => String(message.payload["content"] ?? ""))
    : null;
  const host = new ConversationTurnDraftHost({
    turnId: claimed.id,
    inputMessageIds: claimed.inputMessages.map((message) => message.id),
    ...(naturalMessageContents ? { inputMessageContents: naturalMessageContents } : {}),
    baseState: claimed.snapshot,
    researchNeed: options.researchNeed,
    ...(options.requiredFocusOfferRef ? { requiredFocusOfferRef: options.requiredFocusOfferRef } : {}),
    world: options.world,
    loadRevision: (revision) => repository.getRevision(claimed.conversationId, claimed.owner, revision),
    onPlanCommitted: async (plan) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, { plan });
      if (!staged) throw new Error("STALE_ATTEMPT_PLAN_STAGE_REJECTED");
    },
    onDraftChanged: async (draft) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, {
        plan: draft.plan,
        goal: draft.state.goalRevision,
        dialogue: draft.state.dialogue,
        workingSet: draft.state.workingSet,
        claimLedger: draft.claimLedger,
        evidenceKeys: draft.evidenceKeys,
      });
      if (!staged) throw new Error("STALE_ATTEMPT_DRAFT_STAGE_REJECTED");
    },
    onReplyValidated: async (reply) => {
      recordGuardrailDecision("validate-reply-evidence", true, {
        outcome: reply.envelope.outcome,
        claimCount: reply.claimLedger.claims.length,
        evidenceKeyCount: reply.evidenceKeys.length,
        fallback: Boolean(reply.fallbackReasonCode),
      });
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, {
        plan: reply.plan,
        goal: reply.state.goalRevision,
        dialogue: reply.state.dialogue,
        workingSet: reply.state.workingSet,
        envelope: reply.envelope,
        claimLedger: reply.claimLedger,
        evidenceKeys: reply.evidenceKeys,
        ...(reply.fallbackReasonCode ? { fallbackReasonCode: reply.fallbackReasonCode } : {}),
      });
      if (!staged) throw new Error("STALE_ATTEMPT_REPLY_STAGE_REJECTED");
      commitResult = await repository.commitTurn({
        ...fence,
        state: reply.state,
        plan: reply.plan,
        envelope: reply.envelope,
        claimLedger: reply.claimLedger,
        renderedText: reply.renderedText,
        allowedQuestionSlotIds: new Set(reply.allowedQuestionSlotIds),
        allowedDisclosureCodes: new Set(reply.allowedDisclosureCodes),
      });
      if (!commitResult) throw new Error("FINAL_COMMIT_REJECTED");
    },
  });
  return { host: observedHost(host), getCommitResult: () => commitResult };
}
