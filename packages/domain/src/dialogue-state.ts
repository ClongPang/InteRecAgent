import { DomainError } from "./errors.js";
import type { DialogueOperation, DialogueState, WorkingSet } from "./conversation-types.js";

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainError(code, `${code}: a non-empty value is required`);
  return normalized;
}

export function emptyDialogueState(): DialogueState {
  return {
    pendingClarification: null,
    pendingOps: [],
    focusOfferRef: null,
    comparisonOfferRefs: [],
    lastAssistantMessageId: null,
  };
}

export function clarificationWording(slotId: string): string {
  const normalized = requiredText(slotId, "INVALID_CLARIFICATION_SLOT").toLocaleLowerCase("en-US");
  if (normalized === "budget") return "预算大概是多少？";
  if (normalized === "retrieval_market" || normalized === "market") return "想比较哪些购买市场？目前支持美国和新加坡。";
  if (normalized === "target_model" || normalized === "model") return "有指定的具体型号吗？";
  if (normalized === "condition") return "只考虑全新商品，还是也接受翻新或二手？";
  if (normalized === "delivery_destination") return "商品最终需要送到哪个国家或地区？";
  if (normalized.startsWith("referent:")) return "你指的是当前候选中的哪一个？";
  if (normalized === "turn_rephrase") return "请换一种说法告诉我你想继续调整、比较或了解什么。";
  return "请再补充一个关键选购条件。";
}

export function applyDialogueOperations(base: DialogueState, operations: DialogueOperation[]): DialogueState {
  let state = structuredClone(base);
  for (const operation of operations) {
    switch (operation.kind) {
      case "DIALOGUE_REQUEST_CLARIFICATION":
        state = {
          ...state,
          pendingClarification: {
            slotId: requiredText(operation.slotId, "INVALID_CLARIFICATION_SLOT"),
            askedByMessageId: requiredText(operation.askedByMessageId, "INVALID_MESSAGE_ID"),
          },
        };
        break;
      case "DIALOGUE_CLEAR_CLARIFICATION": {
        const slotId = requiredText(operation.slotId, "INVALID_CLARIFICATION_SLOT");
        state = state.pendingClarification?.slotId === slotId ? { ...state, pendingClarification: null } : state;
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
