import {
  applyQuoteEffectResult,
  decideQuoteCommand,
  projectPublishedQuoteLeadSet,
  QUOTE_PLAN_POLICY_VERSION,
  reviewQuoteTurnPlan,
  validateProductIdentitySnapshot,
  validateQuoteAssistantPublication,
  validateQuoteConversationState,
  type PublishedQuoteLeadSet,
  type ProductIdentitySnapshot,
  type QuoteAssistantPublication,
  type QuoteConversationState,
  type QuoteEffect,
  type QuoteEffectResult,
  type QuoteOperationReceipt as DomainQuoteOperationReceipt,
  type QuotePlanReview,
  type QuoteTurnOperation,
  type QuoteTurnPlan,
} from "@interec/domain";

import {
  reviewIdentityHypothesis,
  validateIdentityCandidates,
  type IdentityCandidateView,
} from "./identity-hypothesis.js";
import {
  bindQuotePlan,
  type QuoteTurnPlanProposal,
} from "./quote-plan-binding.js";
import {
  renderQuoteAssistantPublication,
} from "./quote-reply-renderer.js";

export type QuoteOperationReceipt = DomainQuoteOperationReceipt;

export interface QuoteEffectExecutionPort {
  execute(effect: QuoteEffect, signal?: AbortSignal): Promise<QuoteEffectResult>;
}

export interface QuoteTurnExecutorCallbacks {
  onPlanReviewed?(observation: {
    proposalNumber: number;
    proposal: QuoteTurnPlanProposal;
    reviewedPlan: QuoteTurnPlan;
    review: QuotePlanReview;
    approvedPlan: QuoteTurnPlan | null;
  }): Promise<void>;
  onPlanCommitted?(plan: QuoteTurnPlan): Promise<void>;
  onDraftChanged?(draft: { plan: QuoteTurnPlan; state: QuoteConversationState }): Promise<void>;
  onPublication?(publication: {
    plan: QuoteTurnPlan;
    state: QuoteConversationState;
    reply: QuoteAssistantPublication;
  }): Promise<void>;
}

export interface QuoteTurnExecutorOptions extends QuoteTurnExecutorCallbacks {
  turnId: string;
  inputMessageIds: string[];
  inputMessageContents: string[];
  baseState: QuoteConversationState;
  publicationRevision: number;
  quoteEffects: QuoteEffectExecutionPort;
  identityCandidates?: IdentityCandidateView[];
  identitySnapshot?: ProductIdentitySnapshot;
}

export interface QuoteTurnExecutionResult {
  plan: QuoteTurnPlan;
  review: Extract<QuotePlanReview, { decision: "APPROVED" }>;
  state: QuoteConversationState;
  receipts: QuoteOperationReceipt[];
  reply: QuoteAssistantPublication;
}

export class QuotePlanReviewError extends Error {
  public constructor(public readonly review: Extract<QuotePlanReview, { decision: "REPAIR_REQUIRED" }>) {
    super(review.violations[0]?.code ?? review.decision);
    this.name = "QuotePlanReviewError";
  }
}

export class QuoteConversationTurnExecutor {
  private proposalCount = 0;
  private state: QuoteConversationState;
  private readonly currentMessages: Array<{ messageId: string; content: string }>;
  private readonly identityCandidates: IdentityCandidateView[];
  private readonly identitySnapshot: ProductIdentitySnapshot | null;

  public constructor(private readonly options: QuoteTurnExecutorOptions) {
    if (options.inputMessageIds.length !== options.inputMessageContents.length || options.inputMessageIds.length === 0) {
      throw new Error("QUOTE_INPUT_MESSAGE_MISMATCH");
    }
    if (options.publicationRevision !== options.baseState.version + 1) throw new Error("QUOTE_PUBLICATION_REVISION_NOT_MONOTONE");
    this.state = validateQuoteConversationState(options.baseState);
    this.currentMessages = options.inputMessageIds.map((messageId, index) => ({ messageId, content: options.inputMessageContents[index]! }));
    this.identityCandidates = validateIdentityCandidates(options.identityCandidates ?? []);
    this.identitySnapshot = options.identitySnapshot ? validateProductIdentitySnapshot(options.identitySnapshot) : null;
  }

  public async execute(proposal: QuoteTurnPlanProposal, signal?: AbortSignal): Promise<QuoteTurnExecutionResult> {
    this.proposalCount += 1;
    if (this.proposalCount > 2) throw new Error("QUOTE_PLAN_PROPOSAL_BUDGET_EXCEEDED");
    const providerOperationRequested = proposal.ops.some((operation) => operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES");
    const identityViolations = proposal.ops.flatMap((operation) => operation.kind === "SET_QUOTE_TARGET"
      ? reviewIdentityHypothesis(
          operation,
          this.options.inputMessageContents,
          this.identityCandidates,
          providerOperationRequested,
        )
      : []);
    const plan = bindQuotePlan(
      proposal,
      this.options.inputMessageIds,
      this.options.inputMessageContents,
      identityViolations.length === 0 ? this.identitySnapshot : null,
    );
    const review: QuotePlanReview = identityViolations.length > 0
      ? { decision: "REPAIR_REQUIRED", policyVersion: QUOTE_PLAN_POLICY_VERSION, violations: identityViolations }
      : reviewQuoteTurnPlan({ plan, state: this.state, currentUserMessages: this.currentMessages });
    await this.options.onPlanReviewed?.({
      proposalNumber: this.proposalCount,
      proposal: structuredClone(proposal),
      reviewedPlan: plan,
      review,
      approvedPlan: review.decision === "APPROVED" ? plan : null,
    });
    if (review.decision !== "APPROVED") throw new QuotePlanReviewError(review);
    await this.options.onPlanCommitted?.(plan);
    const receipts: QuoteOperationReceipt[] = [];
    let workingState = this.state;
    for (const operation of plan.ops) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("TURN_ABORTED");
      const execution = await this.executeOperation(workingState, operation, signal);
      workingState = execution.state;
      receipts.push(execution.receipt);
    }
    this.state = validateQuoteConversationState({ ...workingState, version: this.options.publicationRevision });
    await this.options.onDraftChanged?.({ plan, state: this.state });
    const reply = validateQuoteAssistantPublication(
      renderQuoteAssistantPublication(plan, this.state, receipts),
      plan,
      this.state,
    );
    await this.options.onPublication?.({ plan, state: this.state, reply });
    return { plan, review, state: structuredClone(this.state), receipts, reply };
  }

  public async fallback(errorCode: string): Promise<{ state: QuoteConversationState; reply: QuoteAssistantPublication }> {
    const plan: QuoteTurnPlan = { userIntentSummary: `system fallback: ${errorCode.slice(0, 80)}`, ops: [] };
    this.state = validateQuoteConversationState({ ...this.state, version: this.options.publicationRevision });
    const reply: QuoteAssistantPublication = {
      outcome: "DEGRADED",
      addressedOpIds: [],
      disclosureCodes: [],
      text: "本轮未能可靠理解或执行请求，现有报价观测没有被改写。请提供准确型号或换一种说法重试。",
    };
    validateQuoteAssistantPublication(reply, plan, this.state);
    await this.options.onPlanCommitted?.(plan);
    await this.options.onDraftChanged?.({ plan, state: this.state });
    await this.options.onPublication?.({ plan, state: this.state, reply });
    return { state: structuredClone(this.state), reply };
  }

  private async executeOperation(
    state: QuoteConversationState,
    operation: QuoteTurnOperation,
    signal?: AbortSignal,
  ): Promise<{ state: QuoteConversationState; receipt: QuoteOperationReceipt }> {
    const decision = decideQuoteCommand({ state, operation, currentUserMessages: this.currentMessages });
    if (decision.decision === "APPLIED") return { state: decision.nextState, receipt: decision.receipt };
    const effect = decision.effects[0];
    try {
      const application = applyQuoteEffectResult(
        decision.nextState,
        effect,
        await this.options.quoteEffects.execute(effect, signal),
      );
      if (application.status !== "APPLIED") throw new Error(application.errorCode);
      return { state: application.nextState, receipt: application.receipt };
    } catch (error) {
      applyQuoteEffectResult(decision.nextState, effect, {
        status: "FAILED",
        errorCode: error instanceof Error ? error.message : "QUOTE_EFFECT_FAILED",
        retryable: null,
      });
      throw error;
    }
  }
}

export type { ProposedQuoteTurnOperation, QuoteTurnPlanProposal } from "./quote-plan-binding.js";

/** Convenience adapter for callers that still hold the complete internal lead set. */
export function publishableQuoteLeadSet(leadSet: Parameters<typeof projectPublishedQuoteLeadSet>[0]): PublishedQuoteLeadSet {
  return projectPublishedQuoteLeadSet(leadSet);
}
