import { clarificationOption, clarificationResponseSpec, type ClarificationIntent } from "./clarification.js";
import type { DialogueState } from "./conversation-types.js";
import { DomainError } from "./errors.js";

export type ClarificationAnswer =
  | { type: "OPTION"; optionId: string }
  | { type: "TEXT"; text: string }
  | { type: "SKIP" };

export interface ValidatedClarificationAnswer {
  clarificationId: string;
  clarification: ClarificationIntent;
  answer: ClarificationAnswer;
  answerText: string | null;
  goalValue?: unknown;
}

export function validateClarificationAnswer(
  dialogue: DialogueState,
  clarificationId: string,
  answer: ClarificationAnswer,
): ValidatedClarificationAnswer {
  const pending = dialogue.pendingClarification;
  if (!pending) throw new DomainError("NO_PENDING_CLARIFICATION", "There is no active clarification to answer");
  const id = clarificationId.trim();
  if (!id || id !== pending.clarificationId) {
    throw new DomainError("STALE_CLARIFICATION_ID", "The clarification has already changed or expired");
  }
  const response = clarificationResponseSpec(pending.clarification);
  if (answer.type === "SKIP") {
    if (!response.allowSkip) throw new DomainError("CLARIFICATION_SKIP_NOT_ALLOWED", `Clarification ${pending.clarification.kind} cannot be skipped`);
    return { clarificationId: id, clarification: pending.clarification, answer: { type: "SKIP" }, answerText: null };
  }
  if (answer.type === "TEXT") {
    const text = answer.text.normalize("NFKC").trim();
    if (!response.allowFreeText) throw new DomainError("CLARIFICATION_TEXT_NOT_ALLOWED", `Clarification ${pending.clarification.kind} requires an option`);
    if (text.length < 1 || text.length > 4000) throw new DomainError("INVALID_CLARIFICATION_TEXT", "Clarification text must contain 1-4000 characters");
    return { clarificationId: id, clarification: pending.clarification, answer: { type: "TEXT", text }, answerText: text };
  }
  const option = clarificationOption(pending.clarification, answer.optionId);
  return {
    clarificationId: id,
    clarification: pending.clarification,
    answer: { type: "OPTION", optionId: option.id },
    answerText: option.answerText,
    ...(option.goalValue !== undefined ? { goalValue: option.goalValue } : {}),
  };
}
