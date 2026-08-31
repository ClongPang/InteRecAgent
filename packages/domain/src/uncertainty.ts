import { clarificationKey, type ClarificationIntent } from "./clarification.js";
import type { InspectableField, TurnPlan } from "./conversation-types.js";

export const UNCERTAINTY_TYPES = [
  "INTENT_AMBIGUITY",
  "MISSING_USER_INFORMATION",
  "MISSING_EVIDENCE",
  "SYSTEM_FAILURE",
] as const;

export type UncertaintyType = typeof UNCERTAINTY_TYPES[number];
export type ClarificationUncertaintyType = Extract<
  UncertaintyType,
  "INTENT_AMBIGUITY" | "MISSING_USER_INFORMATION"
>;

/** A clarification is legal only when the unresolved information can actually
 * be supplied by the user. Evidence and runtime failures use Answerability
 * instead of this protocol. */
export interface ClarificationUncertainty {
  type: ClarificationUncertaintyType;
  userResolvable: true;
}

export interface AnswerabilityReceipt {
  opId: string;
  status: "APPLIED" | "BLOCKED" | "FAILED";
  claimIds: string[];
  questionClarifications: ClarificationIntent[];
  disclosureCodes: string[];
  uncertaintyType?: ClarificationUncertaintyType;
  publicResult: Record<string, unknown>;
}

export type AnswerabilityDecision =
  | { mode: "ANSWER"; claimIds: string[] }
  | {
    mode: "DISCLOSE_UNKNOWN";
    uncertaintyType: "MISSING_EVIDENCE";
    factKinds: InspectableField[];
    claimIds: string[];
    disclosureCodes: string[];
  }
  | { mode: "RETRIEVE"; uncertaintyType: "MISSING_EVIDENCE"; capability: string }
  | {
    mode: "CLARIFY";
    uncertaintyType: ClarificationUncertaintyType;
    operationId: string;
    clarification: ClarificationIntent;
  }
  | { mode: "DEGRADE"; uncertaintyType: "SYSTEM_FAILURE"; failureOwner: "SYSTEM"; errorCode: string };

export interface AnswerabilityInput {
  plan: TurnPlan;
  receipts: readonly AnswerabilityReceipt[];
  systemFailureCode?: string;
}

const inspectableFields = new Set<InspectableField>([
  "PRICE",
  "MERCHANT",
  "MARKET",
  "STOCK",
  "MODEL",
  "CONDITION",
  "RANKING_REASON",
  "WARRANTY",
]);

function unknownFields(receipts: readonly AnswerabilityReceipt[]): InspectableField[] {
  const fields = receipts.flatMap((receipt) => {
    const value = receipt.publicResult["unknownFields"];
    return Array.isArray(value) ? value : [];
  });
  return [...new Set(fields.filter((field): field is InspectableField =>
    typeof field === "string" && inspectableFields.has(field as InspectableField)))];
}

function systemFailureCode(receipt: AnswerabilityReceipt): string {
  const errorCode = receipt.publicResult["errorCode"];
  return typeof errorCode === "string" && errorCode.trim()
    ? errorCode.trim()
    : "OPERATION_EXECUTION_FAILED";
}

export function disclosureIndicatesMissingEvidence(code: string): boolean {
  return code === "PARTIAL_PROVIDER_COVERAGE"
    || /(?:UNKNOWN|UNAVAILABLE|UNVERIFIED|INCOMPLETE)/u.test(code);
}

export function disclosureIndicatesIncompleteSearchCoverage(code: string): boolean {
  return code === "PROVIDER_UNAVAILABLE"
    || code === "PARTIAL_PROVIDER_COVERAGE"
    || code === "UNVERIFIED_RESULTS_NOT_RECOMMENDED"
    || code === "SEARCH_COVERAGE_UNKNOWN"
    || code.startsWith("SEARCH_COVERAGE_INCOMPLETE:");
}

/**
 * Decides what can be published after execution. It deliberately consumes the
 * approved plan and receipts rather than model prose or the original utterance.
 */
export function evaluateAnswerability(input: AnswerabilityInput): AnswerabilityDecision {
  if (input.systemFailureCode) {
    return {
      mode: "DEGRADE",
      uncertaintyType: "SYSTEM_FAILURE",
      failureOwner: "SYSTEM",
      errorCode: input.systemFailureCode,
    };
  }

  const failed = input.receipts.find((receipt) => receipt.status === "FAILED");
  if (failed) {
    return {
      mode: "DEGRADE",
      uncertaintyType: "SYSTEM_FAILURE",
      failureOwner: "SYSTEM",
      errorCode: systemFailureCode(failed),
    };
  }

  const clarificationOperation = input.plan.ops.find((operation) => operation.kind === "REQUEST_CLARIFICATION");
  if (clarificationOperation?.kind === "REQUEST_CLARIFICATION") {
    const receipt = input.receipts.find((item) => item.opId === clarificationOperation.opId);
    const receiptContainsQuestion = receipt?.questionClarifications.some((clarification) =>
      clarificationKey(clarification) === clarificationKey(clarificationOperation.clarification));
    if (!receipt || receipt.status !== "APPLIED" || !receiptContainsQuestion
      || receipt.uncertaintyType !== clarificationOperation.uncertainty.type) {
      return {
        mode: "DEGRADE",
        uncertaintyType: "SYSTEM_FAILURE",
        failureOwner: "SYSTEM",
        errorCode: "CLARIFICATION_RECEIPT_MISSING",
      };
    }
    return {
      mode: "CLARIFY",
      uncertaintyType: clarificationOperation.uncertainty.type,
      operationId: clarificationOperation.opId,
      clarification: clarificationOperation.clarification,
    };
  }

  const blocked = input.receipts.find((receipt) => receipt.status === "BLOCKED");
  if (blocked) {
    const clarification = blocked.questionClarifications[0];
    const reasonCode = blocked.publicResult["blockedReasonCode"];
    if (clarification && blocked.uncertaintyType === "INTENT_AMBIGUITY"
      && (reasonCode === "CANDIDATE_REFERENT_AMBIGUOUS" || reasonCode === "CANDIDATE_REFERENT_NOT_FOUND")) {
      return {
        mode: "CLARIFY",
        uncertaintyType: "INTENT_AMBIGUITY",
        operationId: blocked.opId,
        clarification,
      };
    }
    return {
      mode: "DEGRADE",
      uncertaintyType: "SYSTEM_FAILURE",
      failureOwner: "SYSTEM",
      errorCode: typeof reasonCode === "string" ? reasonCode : "BLOCKED_OPERATION_NOT_USER_RESOLVABLE",
    };
  }

  const claimIds = [...new Set(input.receipts.flatMap((receipt) => receipt.claimIds))];
  const missing = unknownFields(input.receipts);
  const disclosureCodes = [...new Set(input.receipts.flatMap((receipt) => receipt.disclosureCodes))];
  if (missing.length > 0 || disclosureCodes.some(disclosureIndicatesMissingEvidence)) {
    return {
      mode: "DISCLOSE_UNKNOWN",
      uncertaintyType: "MISSING_EVIDENCE",
      factKinds: missing,
      claimIds,
      disclosureCodes,
    };
  }
  return { mode: "ANSWER", claimIds };
}
