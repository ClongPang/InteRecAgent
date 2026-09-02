import { appliedProviderObservation, type QuoteProviderInvocation } from "@retail-price/domain";

import { telemetryErrorCode } from "./telemetry-safety.js";
import {
  assertDecisionProvenanceNonPii,
  catalogIdentityCode,
  DECISION_PROVENANCE_SCHEMA_VERSION,
  type DecisionOperationRecord,
  type DecisionProviderRecord,
  type DecisionStateSnapshot,
  type DecisionTargetLifecycle,
  type TurnDecisionProvenance,
} from "./turn-decision-provenance.js";

export interface QuoteDecisionStateView {
  version: number;
  contractVersion: string;
  target: {
    targetRef: string;
    modelKey?: string;
    canonicalModel?: string;
    identity: { outcome: string; strength: string };
  } | null;
  pendingTargetConfirmation: { proposal?: { proposedModel?: string } } | null;
  leadSet: { outcome: string } | null;
  displayQuoteLeadRefs: readonly string[];
}

export interface QuoteDecisionPlanOp {
  kind: string;
  targetDisposition?: string;
  reasonCode?: string;
}

export interface QuoteDecisionReceipt {
  kind: string;
  status: string;
  providerInvocation?: QuoteProviderInvocation;
  providerCalled: boolean;
  publicResult: Record<string, unknown>;
}

export interface QuoteDecisionReview {
  decision: string;
  violations?: ReadonlyArray<{ code: string }>;
}

export interface QuoteTurnDecisionInput {
  executionStatus: "COMPLETED" | "FAILED";
  before: QuoteDecisionStateView;
  after: QuoteDecisionStateView;
  route: string | null;
  outcome: string;
  disclosureCodes: readonly string[];
  receipts: readonly QuoteDecisionReceipt[];
  planOps: readonly QuoteDecisionPlanOp[];
  review: QuoteDecisionReview | null;
  modelInferences: number;
  toolCalls: number;
  usedFallback: boolean;
  fallbackReasonCode: string | null;
  attempt: number;
}

const PROVIDER_OPERATION_KINDS = new Set(["LOOKUP_QUOTES", "REFRESH_QUOTES"]);
function pendingModelKey(pending: QuoteDecisionStateView["pendingTargetConfirmation"]): string | null {
  return catalogIdentityCode(pending?.proposal?.proposedModel);
}

export function snapshotQuoteDecisionState(state: QuoteDecisionStateView): DecisionStateSnapshot {
  return {
    hasTarget: Boolean(state.target),
    hasPendingConfirmation: Boolean(state.pendingTargetConfirmation),
    leadOutcome: state.leadSet?.outcome ?? null,
    identityOutcome: state.target?.identity.outcome ?? null,
    identityStrength: state.target?.identity.strength ?? null,
    displayCount: state.displayQuoteLeadRefs.length,
    targetRef: catalogIdentityCode(state.target?.targetRef),
    modelKey: catalogIdentityCode(state.target?.modelKey),
    canonicalModel: catalogIdentityCode(state.target?.canonicalModel),
    pendingModelKey: pendingModelKey(state.pendingTargetConfirmation),
  };
}

export function deriveTargetLifecycle(
  before: QuoteDecisionStateView,
  after: QuoteDecisionStateView,
  targetDisposition: string | null = null,
): DecisionTargetLifecycle {
  const beforeRef = before.target?.targetRef ?? null;
  const afterRef = after.target?.targetRef ?? null;
  if (beforeRef && afterRef && beforeRef !== afterRef) return "REPLACED";
  if (!beforeRef && afterRef) return "ESTABLISHED";
  if (beforeRef && !afterRef) return "CLEARED";
  if (!beforeRef && !afterRef && after.pendingTargetConfirmation) return "PENDING";
  if (beforeRef && afterRef && targetDisposition === "RETAIN") return "RETAINED";
  return "UNCHANGED";
}

function receiptInvocation(receipt: QuoteDecisionReceipt): QuoteProviderInvocation {
  if (receipt.providerInvocation) return receipt.providerInvocation;
  const fromResult = receipt.publicResult["providerInvocation"];
  if (fromResult === "LIVE" || fromResult === "ATTEMPT_REPLAY" || fromResult === "NONE") return fromResult;
  return receipt.providerCalled ? "LIVE" : "NONE";
}

function providerRecord(receipts: readonly QuoteDecisionReceipt[]): DecisionProviderRecord | null {
  const receipt = receipts.find((candidate) => (
    PROVIDER_OPERATION_KINDS.has(candidate.kind) && appliedProviderObservation(receiptInvocation(candidate))
  ));
  if (!receipt) return null;
  const result = receipt.publicResult;
  const invocation = receiptInvocation(receipt);
  if (invocation === "NONE") return null;
  return {
    operationKind: receipt.kind,
    outcome: typeof result["outcome"] === "string" ? result["outcome"] : "UNKNOWN",
    providerStatus: typeof result["providerStatus"] === "string" ? result["providerStatus"] : "UNKNOWN",
    providerFailureCode: typeof result["providerFailureCode"] === "string"
      ? result["providerFailureCode"]
      : null,
    providerInvocation: invocation,
    quoteLeadCount: typeof result["quoteLeadCount"] === "number" ? result["quoteLeadCount"] : 0,
  };
}

function operations(input: QuoteTurnDecisionInput): DecisionOperationRecord[] {
  if (input.receipts.length > 0) {
    return input.receipts.map((receipt) => {
      const planOp = input.planOps.find((operation) => operation.kind === receipt.kind);
      const reasonCode = typeof receipt.publicResult["declinedReasonCode"] === "string"
        ? receipt.publicResult["declinedReasonCode"]
        : planOp?.reasonCode;
      const targetDisposition = planOp?.targetDisposition;
      const invocation = receiptInvocation(receipt);
      return {
        kind: receipt.kind,
        status: receipt.status,
        providerInvocation: invocation,
        providerCalled: invocation === "LIVE",
        ...(reasonCode ? { reasonCode } : {}),
        ...(targetDisposition ? { targetDisposition } : {}),
      };
    });
  }
  return input.planOps.map((operation) => ({
    kind: operation.kind,
    status: "BLOCKED",
    providerInvocation: "NONE" as const,
    providerCalled: false,
    ...(operation.reasonCode ? { reasonCode: operation.reasonCode } : {}),
    ...(operation.targetDisposition ? { targetDisposition: operation.targetDisposition } : {}),
  }));
}
export function assembleQuoteTurnDecision(input: {
  executionStatus: "COMPLETED" | "FAILED";
  before: QuoteDecisionStateView;
  after?: QuoteDecisionStateView | null;
  route?: string | null;
  outcome?: string;
  disclosureCodes?: readonly string[];
  receipts?: readonly QuoteDecisionReceipt[];
  planOps?: readonly QuoteDecisionPlanOp[];
  review?: QuoteDecisionReview | null;
  modelInferences?: number;
  toolCalls?: number;
  usedFallback?: boolean;
  fallbackReasonCode?: string | null;
  attempt: number;
}): TurnDecisionProvenance {
  return buildQuoteTurnDecisionProvenance({
    executionStatus: input.executionStatus,
    before: input.before,
    after: input.after ?? input.before,
    route: input.route ?? null,
    outcome: input.outcome ?? "NONE",
    disclosureCodes: input.disclosureCodes ?? [],
    receipts: input.receipts ?? [],
    planOps: input.planOps ?? [],
    review: input.review ?? null,
    modelInferences: input.modelInferences ?? 0,
    toolCalls: input.toolCalls ?? 0,
    usedFallback: input.usedFallback ?? false,
    fallbackReasonCode: input.fallbackReasonCode ?? null,
    attempt: input.attempt,
  });
}
export function buildQuoteTurnDecisionProvenance(input: QuoteTurnDecisionInput): TurnDecisionProvenance {
  const ops = operations(input);
  const decline = [...input.planOps].reverse().find((operation) => operation.kind === "DECLINE_UNSUPPORTED_QUOTE_TARGET");
  const disposition = decline?.targetDisposition ?? (decline ? "SUPERSEDE" : null);
  return assertDecisionProvenanceNonPii({
    schemaVersion: DECISION_PROVENANCE_SCHEMA_VERSION,
    executionStatus: input.executionStatus,
    attempt: input.attempt,
    revision: input.after.version,
    contractVersion: input.after.contractVersion,
    route: input.route,
    outcome: input.outcome,
    disclosureCodes: [...input.disclosureCodes],
    operationKinds: ops.map((operation) => operation.kind),
    operations: ops,
    provider: providerRecord(input.receipts),
    reviewDecision: input.review?.decision ?? "NONE",
    reviewViolationCodes: (input.review?.violations ?? []).map((violation) => violation.code).slice(0, 8),
    targetDisposition: disposition,
    targetLifecycle: deriveTargetLifecycle(input.before, input.after, disposition),
    before: snapshotQuoteDecisionState(input.before),
    after: snapshotQuoteDecisionState(input.after),
    modelInferences: input.modelInferences,
    toolCalls: input.toolCalls,
    repaired: input.modelInferences > 1,
    usedFallback: input.usedFallback,
    fallbackReasonCode: input.fallbackReasonCode
      ? telemetryErrorCode(new Error(input.fallbackReasonCode), "QUOTE_TURN_FALLBACK")
      : null,
  });
}
