import { QuoteConversationTurnExecutor, type IdentityCandidateView, type QuoteEffectExecutionPort } from "@interec/agent";
import type { ProductIdentitySnapshot, QuotePlanReview } from "@interec/domain";

import type { ClaimedConversationTurn, ConversationRepository, FinalCommitResult } from "./conversation-repository-types.js";

export interface QuoteRepositoryTurnSession {
  executor: QuoteConversationTurnExecutor;
  getCommitResult(): FinalCommitResult | null;
  getLastPlanReview(): QuotePlanReview | null;
}

function naturalInput(payload: Record<string, unknown>): string {
  if (payload["type"] !== "MESSAGE") throw new Error("QUOTE_MESSAGE_INPUT_REQUIRED");
  return String(payload["content"] ?? "");
}

export function createQuoteRepositoryTurnSession(
  repository: ConversationRepository,
  claimed: ClaimedConversationTurn,
  quoteEffects: QuoteEffectExecutionPort,
  identityCandidates: IdentityCandidateView[] = [],
  identitySnapshot?: ProductIdentitySnapshot,
): QuoteRepositoryTurnSession {
  let commitResult: FinalCommitResult | null = null;
  let lastPlanReview: QuotePlanReview | null = null;
  const fence = { turnId: claimed.id, attempt: claimed.attempt, fenceToken: claimed.fenceToken };
  const executor = new QuoteConversationTurnExecutor({
    turnId: claimed.id,
    inputMessageIds: claimed.inputMessages.map((message) => message.id),
    inputMessageContents: claimed.inputMessages.map((message) => naturalInput(message.payload)),
    baseState: claimed.snapshot.quote,
    publicationRevision: claimed.snapshot.revision + 1,
    quoteEffects,
    identityCandidates,
    ...(identitySnapshot ? { identitySnapshot } : {}),
    onPlanReviewed: async (observation) => {
      lastPlanReview = observation.review;
      const recorded = await repository.recordPlanReview({ ...fence, ...observation });
      if (!recorded) throw new Error("STALE_QUOTE_PLAN_REVIEW_REJECTED");
    },
    onPlanCommitted: async (quotePlan) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, { quotePlan });
      if (!staged) throw new Error("STALE_QUOTE_PLAN_STAGE_REJECTED");
    },
    onDraftChanged: async ({ plan, state }) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, {
        quotePlan: plan,
        quoteState: state,
      });
      if (!staged) throw new Error("STALE_QUOTE_DRAFT_STAGE_REJECTED");
    },
    onPublication: async ({ plan, state, reply }) => {
      const staged = await repository.stageAttemptDraft(fence.turnId, fence.attempt, fence.fenceToken, {
        quotePlan: plan,
        quoteState: state,
        quoteReply: reply,
      });
      if (!staged) throw new Error("STALE_QUOTE_REPLY_STAGE_REJECTED");
      commitResult = await repository.commitQuoteTurn({
        ...fence,
        conversationStatus: claimed.snapshot.status,
        state,
        plan,
        reply,
      });
      if (!commitResult) throw new Error("STALE_QUOTE_PUBLICATION_REJECTED");
    },
  });
  return { executor, getCommitResult: () => commitResult, getLastPlanReview: () => lastPlanReview };
}
