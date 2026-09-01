import { createHash } from "node:crypto";

import {
  bindQuoteTargetSource,
  projectPublishedQuoteLeadSet,
  resolveQuoteLeadReferents,
  resolveQuoteTarget,
  reviewQuoteTurnPlan,
  validatePublishedQuoteLeadSet,
  validateQuoteAssistantPublication,
  validateQuoteConversationState,
  type PublishedQuoteLeadSet,
  type QuoteAssistantPublication,
  type QuoteConversationState,
  type QuotePlanReview,
  type QuoteTarget,
  type QuoteTurnOperation,
  type QuoteTurnPlan,
} from "@interec/domain";

import {
  renderQuoteAssistantPublication,
  type QuoteOperationReceiptView,
} from "./quote-reply-renderer.js";

export type ProposedQuoteTurnOperation =
  | (Omit<Extract<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>, "source"> & {
      sourceMessageOrdinal: number;
      sourceSpan?: { start: number; end: number };
    })
  | Exclude<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>;

export interface QuoteTurnPlanProposal {
  userIntentSummary: string;
  ops: ProposedQuoteTurnOperation[];
}

export type QuoteOperationReceipt = QuoteOperationReceiptView;

export interface QuoteLookupDataPort {
  lookup(target: QuoteTarget, operationId: string, signal?: AbortSignal): Promise<PublishedQuoteLeadSet>;
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
  quoteData: QuoteLookupDataPort;
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

function confirmationId(rawText: string, model: string): string {
  return `qtc_${createHash("sha256").update(`${rawText}\u0000${model}`).digest("hex").slice(0, 24)}`;
}

function sourceText(operation: Extract<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>, messages: ReadonlyArray<{ messageId: string; content: string }>): string {
  const message = messages.find((item) => item.messageId === operation.source.messageId)?.content;
  if (message === undefined) throw new Error("QUOTE_TARGET_SOURCE_NOT_FOUND");
  return operation.source.span ? message.slice(operation.source.span.start, operation.source.span.end) : message;
}

function clearLeadState(state: QuoteConversationState): QuoteConversationState {
  return {
    ...state,
    leadSet: null,
    displayQuoteLeadRefs: [],
    excludedQuoteLeadRefs: [],
    comparisonQuoteLeadRefs: [],
    focusQuoteLeadRef: null,
  };
}

function bindPlan(proposal: QuoteTurnPlanProposal, messageIds: readonly string[]): QuoteTurnPlan {
  return {
    userIntentSummary: proposal.userIntentSummary.normalize("NFKC").trim(),
    ops: proposal.ops.map((operation): QuoteTurnOperation => {
      if (operation.kind !== "SET_QUOTE_TARGET") return structuredClone(operation);
      const { sourceMessageOrdinal, sourceSpan, ...rest } = operation;
      return {
        ...structuredClone(rest),
        source: bindQuoteTargetSource({ sourceMessageOrdinal, ...(sourceSpan ? { sourceSpan } : {}) }, messageIds),
      } as QuoteTurnOperation;
    }),
  };
}

export class QuoteConversationTurnExecutor {
  private proposalCount = 0;
  private state: QuoteConversationState;
  private readonly currentMessages: Array<{ messageId: string; content: string }>;

  public constructor(private readonly options: QuoteTurnExecutorOptions) {
    if (options.inputMessageIds.length !== options.inputMessageContents.length || options.inputMessageIds.length === 0) {
      throw new Error("QUOTE_INPUT_MESSAGE_MISMATCH");
    }
    if (options.publicationRevision !== options.baseState.version + 1) throw new Error("QUOTE_PUBLICATION_REVISION_NOT_MONOTONE");
    this.state = validateQuoteConversationState(options.baseState);
    this.currentMessages = options.inputMessageIds.map((messageId, index) => ({ messageId, content: options.inputMessageContents[index]! }));
  }

  public async execute(proposal: QuoteTurnPlanProposal, signal?: AbortSignal): Promise<QuoteTurnExecutionResult> {
    this.proposalCount += 1;
    if (this.proposalCount > 2) throw new Error("QUOTE_PLAN_PROPOSAL_BUDGET_EXCEEDED");
    const plan = bindPlan(proposal, this.options.inputMessageIds);
    const review = reviewQuoteTurnPlan({ plan, state: this.state, currentUserMessages: this.currentMessages });
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
    for (const operation of plan.ops) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("TURN_ABORTED");
      receipts.push(await this.executeOperation(operation, signal));
    }
    this.state = validateQuoteConversationState({ ...this.state, version: this.options.publicationRevision });
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

  private async executeOperation(operation: QuoteTurnOperation, signal?: AbortSignal): Promise<QuoteOperationReceipt> {
    if (operation.kind === "SET_QUOTE_TARGET") {
      const rawText = sourceText(operation, this.currentMessages);
      const resolution = resolveQuoteTarget({ rawText, ...operation.target });
      this.state = clearLeadState(this.state);
      if (resolution.status === "RESOLVED") {
        this.state = { ...this.state, target: resolution.target, pendingTargetConfirmation: null };
        return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: false, publicResult: { targetRef: resolution.target.targetRef, canonicalModel: resolution.target.canonicalModel, confirmationRequired: false } };
      }
      this.state = {
        ...this.state,
        target: null,
        pendingTargetConfirmation: {
          confirmationId: confirmationId(rawText, operation.target.proposedModel),
          proposal: { rawText, ...structuredClone(operation.target) },
          reasonCodes: [...resolution.reasonCodes],
          askedByMessageId: operation.source.messageId,
        },
      };
      return { opId: operation.opId, kind: operation.kind, status: "BLOCKED", providerCalled: false, publicResult: { confirmationRequired: true, proposedModel: operation.target.proposedModel } };
    }
    if (operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION") {
      return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: false, publicResult: { modelRequired: true } };
    }
    if (operation.kind === "DECLINE_UNSUPPORTED_QUOTE_TARGET") {
      return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: false, publicResult: { declinedReasonCode: operation.reasonCode } };
    }
    if (operation.kind === "CONFIRM_QUOTE_TARGET") {
      const pending = this.state.pendingTargetConfirmation;
      if (!pending || pending.confirmationId !== operation.confirmationId) throw new Error("QUOTE_CONFIRMATION_NOT_PENDING");
      const resolution = resolveQuoteTarget({ ...pending.proposal, explicitlyConfirmed: true });
      if (resolution.status !== "RESOLVED") throw new Error(`QUOTE_CONFIRMATION_INVALID:${resolution.reasonCodes.join(",")}`);
      this.state = { ...clearLeadState(this.state), target: resolution.target, pendingTargetConfirmation: null };
      return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: false, publicResult: { targetRef: resolution.target.targetRef, canonicalModel: resolution.target.canonicalModel } };
    }
    if (operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES") {
      if (!this.state.target || this.state.pendingTargetConfirmation) throw new Error("QUOTE_TARGET_REQUIRED");
      const leadSet = validatePublishedQuoteLeadSet(await this.options.quoteData.lookup(this.state.target, operation.opId, signal));
      if (leadSet.targetRef !== this.state.target.targetRef) throw new Error("QUOTE_LOOKUP_TARGET_MISMATCH");
      const returnedRefs = new Set(leadSet.leads.map((lead) => lead.quoteLeadRef));
      const excludedQuoteLeadRefs = operation.kind === "REFRESH_QUOTES"
        ? this.state.excludedQuoteLeadRefs.filter((ref) => returnedRefs.has(ref))
        : [];
      const displayQuoteLeadRefs = leadSet.leads
        .map((lead) => lead.quoteLeadRef)
        .filter((ref) => !excludedQuoteLeadRefs.includes(ref));
      this.state = {
        ...this.state,
        leadSet,
        displayQuoteLeadRefs,
        excludedQuoteLeadRefs,
        comparisonQuoteLeadRefs: operation.kind === "REFRESH_QUOTES"
          ? this.state.comparisonQuoteLeadRefs.filter((ref) => displayQuoteLeadRefs.includes(ref))
          : [],
        focusQuoteLeadRef: operation.kind === "REFRESH_QUOTES" && this.state.focusQuoteLeadRef
          && displayQuoteLeadRefs.includes(this.state.focusQuoteLeadRef)
          ? this.state.focusQuoteLeadRef
          : null,
      };
      return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: true, publicResult: { outcome: leadSet.outcome, providerStatus: leadSet.providerStatus, quoteLeadCount: leadSet.leads.length, observedAt: leadSet.observedAt } };
    }
    if (operation.kind === "INSPECT_QUOTE_STATUS") {
      return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: false, publicResult: { hasTarget: Boolean(this.state.target), hasPublishedObservation: Boolean(this.state.leadSet), providerStatus: this.state.leadSet?.providerStatus ?? null } };
    }
    const referents = operation.kind === "SET_QUOTE_FOCUS"
      ? operation.referent ? [operation.referent] : []
      : operation.referents;
    const binding = resolveQuoteLeadReferents(this.state, referents);
    if (referents.length > 0 && binding.status !== "RESOLVED") throw new Error("QUOTE_REFERENT_NOT_FOUND");
    const refs = binding.quoteLeadRefs;
    if (operation.kind === "EXCLUDE_QUOTE_LEADS") {
      const excluded = [...new Set([...this.state.excludedQuoteLeadRefs, ...refs])];
      this.state = {
        ...this.state,
        excludedQuoteLeadRefs: excluded,
        displayQuoteLeadRefs: this.state.displayQuoteLeadRefs.filter((ref) => !excluded.includes(ref)),
        comparisonQuoteLeadRefs: this.state.comparisonQuoteLeadRefs.filter((ref) => !excluded.includes(ref)),
        focusQuoteLeadRef: this.state.focusQuoteLeadRef && excluded.includes(this.state.focusQuoteLeadRef) ? null : this.state.focusQuoteLeadRef,
      };
    } else if (operation.kind === "RESTORE_QUOTE_LEADS") {
      const restored = new Set(refs);
      const excluded = this.state.excludedQuoteLeadRefs.filter((ref) => !restored.has(ref));
      const leadOrder = this.state.leadSet?.leads.map((lead) => lead.quoteLeadRef) ?? [];
      this.state = { ...this.state, excludedQuoteLeadRefs: excluded, displayQuoteLeadRefs: leadOrder.filter((ref) => !excluded.includes(ref)) };
    } else if (operation.kind === "SET_QUOTE_COMPARISON") {
      this.state = { ...this.state, comparisonQuoteLeadRefs: refs };
    } else if (operation.kind === "SET_QUOTE_FOCUS") {
      this.state = { ...this.state, focusQuoteLeadRef: refs[0] ?? null };
    }
    return { opId: operation.opId, kind: operation.kind, status: "APPLIED", providerCalled: false, publicResult: { quoteLeadRefs: refs } };
  }
}

/** Convenience adapter for callers that still hold the complete internal lead set. */
export function publishableQuoteLeadSet(leadSet: Parameters<typeof projectPublishedQuoteLeadSet>[0]): PublishedQuoteLeadSet {
  return projectPublishedQuoteLeadSet(leadSet);
}
