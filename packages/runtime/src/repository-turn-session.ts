import {
  ConversationTurnDraftHost,
  type TurnWorldPort,
} from "@interec/agent";
import type { ResearchNeed } from "@interec/domain";

import type {
  ClaimedConversationTurn,
  ConversationRepository,
  FinalCommitResult,
} from "./conversation-repository-types.js";

export interface RepositoryTurnSessionOptions {
  researchNeed: ResearchNeed;
  world: TurnWorldPort;
  requiredFocusOfferRef?: string;
}

export interface RepositoryTurnSession {
  host: ConversationTurnDraftHost;
  getCommitResult(): FinalCommitResult | null;
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
  return { host, getCommitResult: () => commitResult };
}
