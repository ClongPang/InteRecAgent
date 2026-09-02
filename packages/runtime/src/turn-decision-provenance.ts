/**
 * Closed-vocabulary "why + state delta" channel for an agent turn.
 * Always captured, independent of the content gate. Free text cannot enter:
 * `assertDecisionProvenanceNonPii` rejects any string outside CODE_VALUE.
 *
 * Catalog identity (targetRef / modelKey / canonicalModel) is allowed after
 * `catalogIdentityCode` because those are registry tokens, not user utterances.
 */

export const DECISION_PROVENANCE_SCHEMA_VERSION = "interec-turn-decision-v5" as const;

const CODE_VALUE = /^[A-Za-z0-9_.:-]*$/;

/** Encode a registry token so it can live in the always-on decision channel. */
export function catalogIdentityCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const coded = value.normalize("NFKC").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.:-]/g, "");
  return coded.slice(0, 80) || null;
}

export type DecisionTargetLifecycle =
  | "ESTABLISHED"
  | "RETAINED"
  | "REPLACED"
  | "CLEARED"
  | "PENDING"
  | "UNCHANGED";

export interface DecisionStateSnapshot {
  hasTarget: boolean;
  hasPendingConfirmation: boolean;
  leadOutcome: string | null;
  identityOutcome: string | null;
  identityStrength: string | null;
  displayCount: number;
  targetRef: string | null;
  modelKey: string | null;
  canonicalModel: string | null;
  pendingModelKey: string | null;
}

export interface DecisionOperationRecord {
  kind: string;
  status: string;
  providerInvocation: "NONE" | "LIVE" | "ATTEMPT_REPLAY";
  providerCalled: boolean;
  reasonCode?: string;
  targetDisposition?: string;
}

export interface DecisionProviderRecord {
  operationKind: string;
  outcome: string;
  providerStatus: string;
  providerFailureCode: string | null;
  providerInvocation: "LIVE" | "ATTEMPT_REPLAY";
  quoteLeadCount: number;
}

export interface TurnDecisionProvenance {
  schemaVersion: typeof DECISION_PROVENANCE_SCHEMA_VERSION;
  executionStatus: string;
  attempt: number;
  revision: number;
  contractVersion: string;
  route: string | null;
  outcome: string;
  disclosureCodes: string[];
  operationKinds: string[];
  operations: DecisionOperationRecord[];
  provider: DecisionProviderRecord | null;
  reviewDecision: string;
  reviewViolationCodes: string[];
  targetLifecycle: DecisionTargetLifecycle;
  targetDisposition: string | null;
  before: DecisionStateSnapshot;
  after: DecisionStateSnapshot;
  modelInferences: number;
  toolCalls: number;
  repaired: boolean;
  usedFallback: boolean;
  fallbackReasonCode: string | null;
}

const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function assertNonPiiValue(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`DECISION_PROVENANCE_NON_FINITE_NUMBER:${path}`);
      return;
    case "string":
      if (!CODE_VALUE.test(value)) throw new Error(`DECISION_PROVENANCE_PII_DETECTED:${path}`);
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertNonPiiValue(item, `${path}[${index}]`));
        return;
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (!KEY_NAME.test(key)) throw new Error(`DECISION_PROVENANCE_INVALID_KEY:${path}.${key}`);
        assertNonPiiValue(nested, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new Error(`DECISION_PROVENANCE_UNSUPPORTED_VALUE:${path}`);
  }
}

export function assertDecisionProvenanceNonPii(record: TurnDecisionProvenance): TurnDecisionProvenance {
  if (record.schemaVersion !== DECISION_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`DECISION_PROVENANCE_SCHEMA_MISMATCH:${String(record.schemaVersion)}`);
  }
  assertNonPiiValue(record, "decision");
  return record;
}

export function decisionProvenanceMetadata(record: TurnDecisionProvenance): Record<string, string | number | boolean> {
  return {
    decisionSchemaVersion: record.schemaVersion,
    decisionRoute: record.route ?? "none",
    decisionOutcome: record.outcome,
    decisionReviewDecision: record.reviewDecision,
    decisionTargetLifecycle: record.targetLifecycle,
    decisionHasTarget: record.after.hasTarget,
    decisionOperationKinds: record.operationKinds.join(",") || "none",
    decisionLeadOutcome: record.after.leadOutcome ?? "none",
    ...(record.before.targetRef ? { decisionBeforeTargetRef: record.before.targetRef } : {}),
    ...(record.before.modelKey ? { decisionBeforeModelKey: record.before.modelKey } : {}),
    ...(record.after.targetRef ? { decisionAfterTargetRef: record.after.targetRef } : {}),
    ...(record.after.modelKey ? { decisionAfterModelKey: record.after.modelKey } : {}),
    ...(record.after.canonicalModel ? { decisionAfterCanonicalModel: record.after.canonicalModel } : {}),
    ...(record.after.pendingModelKey ? { decisionPendingModelKey: record.after.pendingModelKey } : {}),
    decisionRepaired: record.repaired,
    decisionUsedFallback: record.usedFallback,
    ...(record.provider ? { decisionProviderStatus: record.provider.providerStatus } : {}),
    ...(record.provider ? { decisionProviderInvocation: record.provider.providerInvocation } : {}),
    ...(record.provider?.providerFailureCode
      ? { decisionProviderFailureCode: record.provider.providerFailureCode }
      : {}),
    ...(record.fallbackReasonCode ? { decisionFallbackReasonCode: record.fallbackReasonCode } : {}),
    ...(record.reviewViolationCodes[0] ? { decisionReviewViolation: record.reviewViolationCodes[0] } : {}),
  };
}
