import { DomainError } from "./errors.js";
import { clarificationKey, normalizeClarificationIntent } from "./clarification.js";
import type { DialogueOperation, DialogueState, WorkingSet } from "./conversation-types.js";

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainError(code, `${code}: a non-empty value is required`);
  return normalized;
}

export function emptyDialogueState(): DialogueState {
  return {
    pendingClarification: null,
    clarificationHistory: [],
    pendingOps: [],
    focusOfferRef: null,
    comparisonOfferRefs: [],
    lastAssistantMessageId: null,
  };
}

export function normalizeDialogueState(value: unknown): DialogueState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_DIALOGUE_STATE", "Dialogue state must be an object");
  }
  const record = value as Record<string, unknown>;
  const pendingValue = record["pendingClarification"];
  let pendingClarification: DialogueState["pendingClarification"] = null;
  if (pendingValue !== null && pendingValue !== undefined) {
    if (!pendingValue || typeof pendingValue !== "object" || Array.isArray(pendingValue)) {
      throw new DomainError("INVALID_PENDING_CLARIFICATION", "Pending clarification must be an object");
    }
    const pending = pendingValue as Record<string, unknown>;
    const clarification = normalizeClarificationIntent(pending["clarification"] ?? pending["slotId"]);
    const askedByMessageId = requiredText(String(pending["askedByMessageId"] ?? ""), "INVALID_MESSAGE_ID");
    pendingClarification = {
      clarificationId: typeof pending["clarificationId"] === "string" && pending["clarificationId"].trim()
        ? pending["clarificationId"].trim()
        : `legacy:${askedByMessageId}:${clarificationKey(clarification)}`,
      clarification,
      askedByMessageId,
    };
  }
  return {
    pendingClarification,
    clarificationHistory: Array.isArray(record["clarificationHistory"])
      ? record["clarificationHistory"].flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const history = item as Record<string, unknown>;
        if (!(["ANSWERED", "SKIPPED", "ASSUMED"] as const).includes(history["outcome"] as "ANSWERED" | "SKIPPED" | "ASSUMED")) return [];
        return [{
          clarification: normalizeClarificationIntent(history["clarification"] ?? history["slotId"]),
          outcome: history["outcome"] as "ANSWERED" | "SKIPPED" | "ASSUMED",
          recordedAtGoalVersion: Number.isSafeInteger(history["recordedAtGoalVersion"]) ? Number(history["recordedAtGoalVersion"]) : null,
        }];
      })
      : [],
    pendingOps: Array.isArray(record["pendingOps"]) ? structuredClone(record["pendingOps"] as DialogueState["pendingOps"]) : [],
    focusOfferRef: typeof record["focusOfferRef"] === "string" ? record["focusOfferRef"] : null,
    comparisonOfferRefs: Array.isArray(record["comparisonOfferRefs"])
      ? record["comparisonOfferRefs"].filter((item): item is string => typeof item === "string")
      : [],
    lastAssistantMessageId: typeof record["lastAssistantMessageId"] === "string" ? record["lastAssistantMessageId"] : null,
  };
}

export function applyDialogueOperations(base: DialogueState, operations: DialogueOperation[]): DialogueState {
  let state = structuredClone(base);
  for (const operation of operations) {
    switch (operation.kind) {
      case "DIALOGUE_REQUEST_CLARIFICATION":
        state = {
          ...state,
          pendingClarification: {
            clarificationId: requiredText(operation.clarificationId, "INVALID_CLARIFICATION_ID"),
            clarification: normalizeClarificationIntent(operation.clarification),
            askedByMessageId: requiredText(operation.askedByMessageId, "INVALID_MESSAGE_ID"),
          },
        };
        break;
      case "DIALOGUE_CLEAR_CLARIFICATION": {
        const clarification = normalizeClarificationIntent(operation.clarification);
        state = state.pendingClarification
          && clarificationKey(state.pendingClarification.clarification) === clarificationKey(clarification)
          ? { ...state, pendingClarification: null }
          : state;
        break;
      }
      case "DIALOGUE_RECORD_CLARIFICATION_OUTCOME": {
        const clarification = normalizeClarificationIntent(operation.clarification);
        const key = clarificationKey(clarification);
        state = {
          ...state,
          pendingClarification: state.pendingClarification && clarificationKey(state.pendingClarification.clarification) === key
            ? null
            : state.pendingClarification,
          clarificationHistory: [
            ...state.clarificationHistory.filter((item) => clarificationKey(item.clarification) !== key),
            { clarification, outcome: operation.outcome, recordedAtGoalVersion: operation.goalVersion },
          ],
        };
        break;
      }
      case "DIALOGUE_SET_PENDING_OPERATIONS": {
        const ids = operation.pendingOps.map((item) => item.operation.opId);
        if (new Set(ids).size !== ids.length) {
          throw new DomainError("DUPLICATE_PENDING_OPERATION", `Pending operation IDs must be unique: ${ids.join(",")}`);
        }
        state = { ...state, pendingOps: structuredClone(operation.pendingOps) };
        break;
      }
      case "DIALOGUE_SYNC_WORKING_SET":
        state = {
          ...state,
          focusOfferRef: operation.focusOfferRef,
          comparisonOfferRefs: [...operation.comparisonOfferRefs],
        };
        break;
      case "DIALOGUE_RECORD_ASSISTANT_MESSAGE":
        state = { ...state, lastAssistantMessageId: requiredText(operation.messageId, "INVALID_MESSAGE_ID") };
        break;
    }
  }
  return state;
}

export function synchronizeDialogueState(base: DialogueState, workingSet: WorkingSet): DialogueState {
  return applyDialogueOperations(base, [{
    kind: "DIALOGUE_SYNC_WORKING_SET",
    focusOfferRef: workingSet.focusOfferRef,
    comparisonOfferRefs: workingSet.comparisonOfferRefs,
  }]);
}
