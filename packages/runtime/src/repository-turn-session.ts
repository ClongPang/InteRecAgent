import {
  ConversationTurnExecutor,
  toolNameForOperation,
  type TurnExecutionController,
  type ShoppingDataPort,
} from "@interec/agent";
import { validateClarificationAnswer, type SearchNeed } from "@interec/domain";

import type {
  ClaimedConversationTurn,
  ConversationRepository,
  FinalCommitResult,
} from "./conversation-repository-types.js";
import { clarificationResolutionOutcome, goalRetentionChecks } from "./clarification-observability.js";
import { observeTurnExecutorStep, recordGuardrailDecision, runtimeMetrics } from "./telemetry.js";

export interface RepositoryTurnSessionOptions {
  searchNeed: SearchNeed;
  shoppingData: ShoppingDataPort;
  requiredFocusOfferRef?: string;
  planAuthority?: "PI_AGENT" | "STRUCTURED_INPUT";
}

export interface RepositoryTurnSession {
  controller: TurnExecutionController;
  getCommitResult(): FinalCommitResult | null;
}

function observedController(executor: ConversationTurnExecutor): TurnExecutionController {
  return {
    commitPlan: (plan, _signal) => observeTurnExecutorStep(
      "commit-turn-plan",
      { operationKinds: plan.ops.map((operation) => operation.kind), leftoverCount: plan.leftover.length },
      () => executor.commitPlan(plan),
      (committed) => ({ route: committed.route, operationCount: committed.plan.ops.length, maxModelInferences: committed.maxModelInferences }),
    ),
    executeOperation: (operation, signal) => {
      const toolName = toolNameForOperation(operation);
      return observeTurnExecutorStep(
        `turn-executor-${toolName.replaceAll("_", "-")}`,
        { kind: operation.kind },
        () => executor.executeOperation(operation, signal),
        (receipt) => ({
          status: receipt.status,
          claimCount: receipt.claimIds.length,
          questionCount: receipt.questionClarifications.length,
          uncertaintyType: receipt.uncertaintyType ?? null,
          disclosureCount: receipt.disclosureCodes.length,
        }),
        { operationKind: operation.kind, hostToolName: toolName },
      );
    },
    publishReply: (envelope, _signal) => observeTurnExecutorStep(
      "publish-reply",
      { outcome: envelope.outcome, blockTypes: envelope.blocks.map((block) => block.type) },
      () => executor.publishReply(envelope),
      (published) => ({ outcome: published.outcome, blockCount: published.blocks.length, addressedOperationCount: published.addressedOpIds.length }),
    ),
    fallbackReply: (errorCode, plan, receipts) => observeTurnExecutorStep(
      "publish-fallback-reply",
      { errorCode, hasPlan: Boolean(plan), receiptCount: receipts.length },
      () => executor.fallbackReply(errorCode, plan, receipts),
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
  const naturalMessageContents = claimed.inputMessages.every((message) => message.payload["type"] === "MESSAGE"
    || (message.payload["type"] === "ANSWER_CLARIFICATION" && (message.payload["answer"] as Record<string, unknown> | undefined)?.["type"] === "TEXT"))
    ? claimed.inputMessages.map((message) => message.payload["type"] === "MESSAGE"
      ? String(message.payload["content"] ?? "")
      : String((message.payload["answer"] as Record<string, unknown> | undefined)?.["text"] ?? ""))
    : null;
  const answerInput = claimed.inputMessages
    .map((message) => message.payload)
    .filter((payload) => payload["type"] === "ANSWER_CLARIFICATION")
    .at(-1);
  const clarificationAnswer = answerInput
    ? validateClarificationAnswer(
      claimed.snapshot.dialogue,
      String(answerInput["clarificationId"] ?? ""),
      answerInput["answer"] as never,
    )
    : undefined;
  const executor = new ConversationTurnExecutor({
    turnId: claimed.id,
    inputMessageIds: claimed.inputMessages.map((message) => message.id),
    ...(naturalMessageContents ? { inputMessageContents: naturalMessageContents } : {}),
    baseState: claimed.snapshot,
    searchNeed: options.searchNeed,
    ...(options.planAuthority ? { planAuthority: options.planAuthority } : {}),
    ...(options.requiredFocusOfferRef ? { requiredFocusOfferRef: options.requiredFocusOfferRef } : {}),
    ...(clarificationAnswer ? { clarificationAnswer } : {}),
    shoppingData: options.shoppingData,
    loadRevision: (revision) => repository.getRevision(claimed.conversationId, claimed.owner, revision),
    onPlanCommitted: async (plan) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, { plan });
      if (!staged) throw new Error("STALE_ATTEMPT_PLAN_STAGE_REJECTED");
    },
    onPlanReviewed: async (observation) => {
      const violationCodes = "violations" in observation.review
        ? observation.review.violations.map((violation) => violation.code)
        : [];
      for (const violationCode of violationCodes.length > 0 ? violationCodes : ["NONE"]) {
        runtimeMetrics.planReviewDecisions.add(1, {
          decision: observation.review.decision,
          violation_code: violationCode,
        });
      }
      recordGuardrailDecision("review-turn-plan", observation.review.decision === "APPROVED", {
        decision: observation.review.decision,
        policyVersion: observation.review.policyVersion,
        proposalNumber: observation.proposalNumber,
        violationCodes,
      });
      const recorded = await repository.recordPlanReview({
        ...fence,
        proposalNumber: observation.proposalNumber,
        proposal: observation.proposal,
        reviewedPlan: observation.reviewedPlan,
        review: observation.review,
        approvedPlan: observation.approvedPlan,
      });
      if (!recorded) throw new Error("STALE_ATTEMPT_PLAN_REVIEW_REJECTED");
    },
    onDraftChanged: async (draft) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, {
        plan: draft.plan,
        goal: draft.state.goalRevision,
        dialogue: draft.state.dialogue,
        workingSet: draft.state.workingSet,
        groundedClaims: draft.groundedClaims,
        evidenceKeys: draft.evidenceKeys,
      });
      if (!staged) throw new Error("STALE_ATTEMPT_DRAFT_STAGE_REJECTED");
    },
    onReplyValidated: async (reply) => {
      const uncertaintyType = "uncertaintyType" in reply.answerability
        ? reply.answerability.uncertaintyType
        : "NONE";
      runtimeMetrics.answerabilityDecisions.add(1, {
        mode: reply.answerability.mode,
        uncertainty_type: uncertaintyType,
      });
      if (reply.answerability.mode === "CLARIFY") {
        runtimeMetrics.clarificationDecisions.add(1, {
          uncertainty_type: reply.answerability.uncertaintyType,
          clarification_kind: reply.answerability.clarification.kind,
        });
      }
      if (reply.envelope.outcome === "CLARIFICATION" && reply.answerability.mode !== "CLARIFY") {
        runtimeMetrics.uncertaintyMisattributions.add(1, {
          source: uncertaintyType,
          rendered_as: "CLARIFICATION",
        });
      }
      if (clarificationAnswer) {
        const clarificationKind = clarificationAnswer.clarification.kind;
        const pendingKind = reply.state.dialogue.pendingClarification?.clarification.kind ?? null;
        const resolutionOutcome = clarificationResolutionOutcome(clarificationKind, pendingKind, Boolean(reply.fallbackReasonCode));
        runtimeMetrics.clarificationResolutions.add(1, {
          clarification_kind: clarificationKind,
          outcome: resolutionOutcome,
        });
        const retainedFields = goalRetentionChecks(
          claimed.snapshot.goalRevision?.goal ?? null,
          reply.state.goalRevision?.goal ?? null,
          clarificationKind,
        );
        const failedFields: string[] = [];
        for (const field of retainedFields) {
          if (!field.retained) failedFields.push(field.field);
          runtimeMetrics.goalFieldRetentionChecks.add(1, {
            field: field.field,
            clarification_kind: clarificationKind,
            outcome: field.retained ? "PASS" : "FAIL",
          });
        }
        recordGuardrailDecision("validate-goal-field-retention", failedFields.length === 0, {
          clarificationKind,
          checkedFields: retainedFields.map((field) => field.field),
          failedFields,
        });
      }
      recordGuardrailDecision("validate-reply-evidence", true, {
        outcome: reply.envelope.outcome,
        claimCount: reply.groundedClaims.claims.length,
        evidenceKeyCount: reply.evidenceKeys.length,
        fallback: Boolean(reply.fallbackReasonCode),
      });
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, {
        plan: reply.plan,
        goal: reply.state.goalRevision,
        dialogue: reply.state.dialogue,
        workingSet: reply.state.workingSet,
        envelope: reply.envelope,
        groundedClaims: reply.groundedClaims,
        evidenceKeys: reply.evidenceKeys,
        ...(reply.fallbackReasonCode ? { fallbackReasonCode: reply.fallbackReasonCode } : {}),
      });
      if (!staged) throw new Error("STALE_ATTEMPT_REPLY_STAGE_REJECTED");
      commitResult = await repository.commitTurn({
        ...fence,
        state: reply.state,
        plan: reply.plan,
        envelope: reply.envelope,
        groundedClaims: reply.groundedClaims,
        renderedText: reply.renderedText,
        allowedClarificationIds: new Set(reply.allowedClarificationIds),
        allowedDisclosureCodes: new Set(reply.allowedDisclosureCodes),
      });
      if (!commitResult) throw new Error("FINAL_COMMIT_REJECTED");
    },
  });
  return { controller: observedController(executor), getCommitResult: () => commitResult };
}
