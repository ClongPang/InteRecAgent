import { normalizeDialogueState, type ClarificationIntent, type ConversationState, type PendingOperation, type TurnOperation } from "@interec/domain";

export interface ContextMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ConversationContextInput {
  state: ConversationState;
  currentUserMessages: string[];
  uiFocusOfferRef?: string;
  recentAdjacentPair?: ContextMessage[];
  /** Evaluation-only ablation input. Production callers should leave this unset. */
  fullTranscript?: ContextMessage[];
  capabilities: string[];
  now: string;
  modelId: string;
  providerCallBudget: number;
  maxInputTokens?: number;
}

export interface ConversationContextProjection {
  conversation: { revision: number; status: ConversationState["status"] };
  currentUserMessages: Array<{ ordinal: number; content: string; truncated: boolean }>;
  recentAdjacentPair: Array<{ role: ContextMessage["role"]; content: string; truncated: boolean }>;
  fullTranscript?: Array<{ role: ContextMessage["role"]; content: string }>;
  goal: Record<string, unknown> | null;
  dialogue: {
    pendingClarification: { clarificationId: string; clarification: ClarificationIntent } | null;
    pendingOps: Array<{ conditionCode: string; operation: Record<string, unknown> }>;
    focusOfferRef: string | null;
    comparisonOfferRefs: string[];
  };
  uiContext: { focusOfferRef: string | null };
  workingSet: null | {
    version: number;
    boundGoalVersion: number;
    candidates: Array<Record<string, unknown>>;
    displayOfferRefs: string[];
    mentionedOfferRefs: string[];
    comparisonOfferRefs: string[];
    rejectedOfferRefs: string[];
    focusOfferRef: string | null;
  };
  runtime: {
    capabilities: string[];
    now: string;
    modelId: string;
    providerCallBudget: number;
    estimatedInputTokens: number;
  };
}

function bounded(value: string, maxLength: number): { content: string; truncated: boolean } {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length <= maxLength) return { content: normalized, truncated: false };
  return { content: `${normalized.slice(0, Math.max(0, maxLength - 1))}…`, truncated: true };
}

function publicOperation(operation: TurnOperation): Record<string, unknown> {
  const { opId, kind } = operation;
  const value = structuredClone(operation) as unknown as Record<string, unknown>;
  delete value["source"];
  return { opId, kind, ...value };
}

function publicPending(pending: PendingOperation): { conditionCode: string; operation: Record<string, unknown> } {
  return { conditionCode: pending.conditionCode, operation: publicOperation(pending.operation) };
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function projectConversationContext(input: ConversationContextInput): ConversationContextProjection {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("INVALID_CONTEXT_TIME");
  if (!Number.isSafeInteger(input.providerCallBudget) || input.providerCallBudget < 0 || input.providerCallBudget > 4) {
    throw new Error("INVALID_PROVIDER_CALL_BUDGET");
  }
  if (input.currentUserMessages.length < 1 || input.currentUserMessages.length > 8) throw new Error("INVALID_CURRENT_MESSAGE_BATCH");
  if (input.fullTranscript && input.fullTranscript.length > 200) throw new Error("FULL_TRANSCRIPT_MESSAGE_LIMIT_EXCEEDED");
  const maxTokens = input.maxInputTokens ?? 8_000;
  const goal = input.state.goalRevision?.goal;
  const dialogue = normalizeDialogueState(input.state.dialogue);
  const projection: ConversationContextProjection = {
    conversation: { revision: input.state.revision, status: input.state.status },
    currentUserMessages: input.currentUserMessages.map((message, ordinal) => ({ ordinal, ...bounded(message, 2_500) })),
    recentAdjacentPair: (input.recentAdjacentPair ?? []).slice(-2).map((message) => ({ role: message.role, ...bounded(message.content, 2_000) })),
    ...(input.fullTranscript ? {
      fullTranscript: input.fullTranscript.map((message) => ({
        role: message.role,
        content: message.content.normalize("NFKC").trim(),
      })),
    } : {}),
    goal: goal ? {
      target: goal.target,
      budget: goal.budget,
      retrievalMarkets: goal.retrievalMarkets,
      deliveryDestination: goal.deliveryDestination,
      stockPreference: goal.stockPreference,
      hardConstraints: goal.hardConstraints.map(({ source: _source, ...constraint }) => constraint),
      preferences: goal.preferences.map(({ source: _source, ...preference }) => preference),
      exclusions: goal.exclusions,
      unresolved: goal.unresolved.map(({ askedByMessageId: _messageId, ...gap }) => gap),
      version: input.state.goalRevision!.version,
    } : null,
    dialogue: {
      pendingClarification: dialogue.pendingClarification?.clarification.kind === "TURN_REPHRASE"
        ? null
        : dialogue.pendingClarification
        ? {
          clarificationId: dialogue.pendingClarification.clarificationId,
          clarification: dialogue.pendingClarification.clarification,
        }
        : null,
      pendingOps: dialogue.pendingOps.map(publicPending),
      focusOfferRef: dialogue.focusOfferRef,
      comparisonOfferRefs: [...dialogue.comparisonOfferRefs],
    },
    uiContext: { focusOfferRef: input.uiFocusOfferRef?.trim() || null },
    workingSet: input.state.workingSet ? {
      version: input.state.workingSet.version,
      boundGoalVersion: input.state.workingSet.boundGoalVersion,
      candidates: input.state.workingSet.pool.slice(0, 20).map((candidate) => ({
        offerRef: candidate.offerRef,
        title: candidate.title,
        canonicalModel: candidate.canonicalModel,
        categoryId: candidate.categoryId,
        itemRole: candidate.itemRole,
        condition: candidate.condition,
        retrievalMarket: candidate.retrievalMarket,
        merchant: candidate.merchant,
        cnyAmount: candidate.cnyAmount,
        stock: candidate.stock,
        claimIds: candidate.claimIds,
        marketEvidenceLevel: candidate.marketEvidenceLevel,
        rankingReasonCodes: candidate.rankingReasonCodes,
      })),
      displayOfferRefs: [...input.state.workingSet.displayOfferRefs],
      mentionedOfferRefs: [...input.state.workingSet.mentionedOfferRefs],
      comparisonOfferRefs: [...input.state.workingSet.comparisonOfferRefs],
      rejectedOfferRefs: [...input.state.workingSet.rejectedOfferRefs],
      focusOfferRef: input.state.workingSet.focusOfferRef,
    } : null,
    runtime: {
      capabilities: [...new Set(input.capabilities)].sort(),
      now: input.now,
      modelId: input.modelId,
      providerCallBudget: input.providerCallBudget,
      estimatedInputTokens: 0,
    },
  };
  let tokens = estimateTokens(projection);
  while (tokens > maxTokens && projection.workingSet && projection.workingSet.candidates.length > 1) {
    projection.workingSet.candidates.pop();
    tokens = estimateTokens(projection);
  }
  if (tokens > maxTokens) {
    projection.recentAdjacentPair = [];
    tokens = estimateTokens(projection);
  }
  if (tokens > maxTokens) throw new Error("CONVERSATION_CONTEXT_BUDGET_EXCEEDED");
  projection.runtime.estimatedInputTokens = tokens;
  tokens = estimateTokens(projection);
  if (tokens > maxTokens) throw new Error("CONVERSATION_CONTEXT_BUDGET_EXCEEDED");
  projection.runtime.estimatedInputTokens = tokens;
  return projection;
}
