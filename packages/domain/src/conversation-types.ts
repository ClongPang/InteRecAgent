import type { QuoteConversationState } from "./quote-conversation-types.js";

export type ConversationStatus = "OPEN" | "CLOSED" | "BLOCKED";

export interface OperationSource {
  messageId: string;
  span?: { start: number; end: number };
}

/** The sole active conversation snapshot after the quote-lead cutover. */
export interface ConversationState {
  revision: number;
  status: ConversationStatus;
  quote: QuoteConversationState;
}
