import { validateQuoteConversationState, type QuoteConversationState } from "@interec/domain";

import { validateIdentityCandidates, type IdentityCandidateView } from "./identity-hypothesis.js";

export interface ContextMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface QuoteConversationContextInput {
  state: QuoteConversationState;
  currentUserMessages: string[];
  recentAdjacentPair?: ContextMessage[];
  now: string;
  modelId: string;
  providerCallBudget: 0 | 1;
  identityCandidates?: IdentityCandidateView[];
  maxInputTokens?: number;
}

export interface QuoteConversationContextProjection {
  contractVersion: "quote-leads-sg-v1";
  currentUserMessages: Array<{ ordinal: number; content: string; truncated: boolean }>;
  recentAdjacentPair: Array<{ role: ContextMessage["role"]; content: string; truncated: boolean }>;
  identityCandidates: IdentityCandidateView[];
  quoteState: {
    version: number;
    target: QuoteConversationState["target"];
    pendingTargetConfirmation: null | {
      confirmationId: string;
      proposedModel: string;
      reasonCodes: string[];
    };
    leadSet: null | {
      quoteLeadSetRef: string;
      outcome: string;
      providerStatus: string;
      observedAt: string;
      leads: Array<{
        quoteLeadRef: string;
        representativeTitle: string;
        canonicalModel: string;
        condition: string;
        merchantLabel: string;
      }>;
    };
    displayQuoteLeadRefs: string[];
    excludedQuoteLeadRefs: string[];
    comparisonQuoteLeadRefs: string[];
    focusQuoteLeadRef: string | null;
  };
  runtime: {
    serviceMarket: "SG";
    providerCallBudget: 0 | 1;
    now: string;
    modelId: string;
    estimatedInputTokens: number;
  };
}

function bounded(value: string, maxLength: number): { content: string; truncated: boolean } {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length <= maxLength) return { content: normalized, truncated: false };
  return { content: `${normalized.slice(0, maxLength - 1)}…`, truncated: true };
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function projectQuoteConversationContext(input: QuoteConversationContextInput): QuoteConversationContextProjection {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("INVALID_QUOTE_CONTEXT_TIME");
  if (input.currentUserMessages.length < 1 || input.currentUserMessages.length > 8) throw new Error("INVALID_QUOTE_MESSAGE_BATCH");
  const state = validateQuoteConversationState(input.state);
  const identityCandidates = validateIdentityCandidates(input.identityCandidates ?? []).slice(0, 20);
  const projection: QuoteConversationContextProjection = {
    contractVersion: state.contractVersion,
    currentUserMessages: input.currentUserMessages.map((content, ordinal) => ({ ordinal, ...bounded(content, 2_500) })),
    recentAdjacentPair: (input.recentAdjacentPair ?? []).slice(-2).map((message) => ({ role: message.role, ...bounded(message.content, 1_500) })),
    identityCandidates,
    quoteState: {
      version: state.version,
      target: state.target,
      pendingTargetConfirmation: state.pendingTargetConfirmation ? {
        confirmationId: state.pendingTargetConfirmation.confirmationId,
        proposedModel: state.pendingTargetConfirmation.proposal.proposedModel,
        reasonCodes: [...state.pendingTargetConfirmation.reasonCodes],
      } : null,
      leadSet: state.leadSet ? {
        quoteLeadSetRef: state.leadSet.quoteLeadSetRef,
        outcome: state.leadSet.outcome,
        providerStatus: state.leadSet.providerStatus,
        observedAt: state.leadSet.observedAt,
        leads: state.leadSet.leads.slice(0, 20).map((lead) => ({
          quoteLeadRef: lead.quoteLeadRef,
          representativeTitle: lead.representativeTitle,
          canonicalModel: lead.canonicalModel,
          condition: lead.condition,
          merchantLabel: lead.merchantLabel,
        })),
      } : null,
      displayQuoteLeadRefs: [...state.displayQuoteLeadRefs],
      excludedQuoteLeadRefs: [...state.excludedQuoteLeadRefs],
      comparisonQuoteLeadRefs: [...state.comparisonQuoteLeadRefs],
      focusQuoteLeadRef: state.focusQuoteLeadRef,
    },
    runtime: {
      serviceMarket: "SG",
      providerCallBudget: input.providerCallBudget,
      now: new Date(input.now).toISOString(),
      modelId: input.modelId,
      estimatedInputTokens: 0,
    },
  };
  const maxTokens = input.maxInputTokens ?? 6_000;
  let tokens = estimatedTokens(projection);
  while (tokens > maxTokens && projection.quoteState.leadSet && projection.quoteState.leadSet.leads.length > 1) {
    projection.quoteState.leadSet.leads.pop();
    tokens = estimatedTokens(projection);
  }
  if (tokens > maxTokens) {
    projection.recentAdjacentPair = [];
    tokens = estimatedTokens(projection);
  }
  if (tokens > maxTokens) throw new Error("QUOTE_CONTEXT_BUDGET_EXCEEDED");
  projection.runtime.estimatedInputTokens = tokens;
  return projection;
}
