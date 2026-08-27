import type { TurnPlan, WorkingSet } from "./conversation-types.js";

export type CandidateFeedbackKind =
  | "IMPRESSION"
  | "FOCUS"
  | "COMPARE"
  | "REJECT"
  | "RESTORE"
  | "ACCEPT"
  | "OUTBOUND_CLICK"
  | "CRITIQUE";

export interface CandidateFeedbackDraft {
  kind: CandidateFeedbackKind;
  operationId: string;
  offerRefs: string[];
  payload: Record<string, unknown>;
}

function offerRefsFromReferents(referents: readonly unknown[]): string[] {
  return [...new Set(referents.flatMap((referent) => {
    if (!referent || typeof referent !== "object") return [];
    const record = referent as Record<string, unknown>;
    return record["kind"] === "OFFER_REF" && typeof record["offerRef"] === "string" ? [record["offerRef"]] : [];
  }))];
}

/** Derives append-only behavioral evidence from the already validated durable plan. */
export function candidateFeedbackForTurn(plan: TurnPlan, workingSet: WorkingSet | null): CandidateFeedbackDraft[] {
  const events: CandidateFeedbackDraft[] = [];
  for (const operation of plan.ops) {
    if (operation.kind === "RESEARCH_OFFERS" && workingSet) {
      events.push({ kind: "IMPRESSION", operationId: operation.opId, offerRefs: [...workingSet.displayOfferRefs], payload: { reasonCode: operation.reasonCode } });
    } else if (operation.kind === "SET_FOCUS") {
      const offerRefs = operation.referent ? offerRefsFromReferents([operation.referent]) : [];
      events.push({ kind: "FOCUS", operationId: operation.opId, offerRefs, payload: { cleared: operation.referent === null } });
    } else if (operation.kind === "SET_COMPARISON") {
      events.push({ kind: "COMPARE", operationId: operation.opId, offerRefs: offerRefsFromReferents(operation.referents), payload: {} });
    } else if (operation.kind === "REJECT_OFFERS") {
      events.push({ kind: "REJECT", operationId: operation.opId, offerRefs: offerRefsFromReferents(operation.referents), payload: { reasonCode: operation.reasonCode } });
    } else if (operation.kind === "RESTORE_OFFERS") {
      events.push({ kind: "RESTORE", operationId: operation.opId, offerRefs: offerRefsFromReferents(operation.referents), payload: {} });
    } else if (operation.kind === "GOAL_UPSERT_PREFERENCE") {
      events.push({
        kind: "CRITIQUE",
        operationId: operation.opId,
        offerRefs: [],
        payload: { preference: structuredClone(operation.preference) },
      });
    }
  }
  return events;
}
