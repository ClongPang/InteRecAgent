import type {
  ConversationMessageRecord,
  ConversationRecordV3,
  ConversationRepository,
  ConversationTurnRecord,
  OwnerClaims,
} from "@interec/runtime";
import type { ConversationState } from "@interec/domain";

export interface ConversationProjection {
  conversation: Pick<ConversationRecordV3, "id" | "status" | "currentRevision" | "createdAt" | "updatedAt">;
  activeTurn: Pick<ConversationTurnRecord, "id" | "status" | "attempt" | "deadlineAt" | "errorCode" | "createdAt"> | null;
  latestTurn: Pick<ConversationTurnRecord, "id" | "status" | "attempt" | "deadlineAt" | "errorCode" | "createdAt" | "completedAt"> | null;
  state: ConversationState;
  messages: ConversationMessageRecord[];
  latestAssistantMessage: ConversationMessageRecord | null;
  eventCursor: number;
}

export async function loadConversationProjection(
  repository: ConversationRepository,
  conversationId: string,
  owner: OwnerClaims,
): Promise<ConversationProjection | null> {
  const snapshot = await repository.getProjection(conversationId, owner);
  if (!snapshot) return null;
  const { conversation, state, messages, activeTurn, latestTurn } = snapshot;
  return {
    conversation: {
      id: conversation.id,
      status: conversation.status,
      currentRevision: conversation.currentRevision,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    activeTurn: activeTurn ? {
      id: activeTurn.id,
      status: activeTurn.status,
      attempt: activeTurn.attempt,
      deadlineAt: activeTurn.deadlineAt,
      errorCode: activeTurn.errorCode,
      createdAt: activeTurn.createdAt,
    } : null,
    latestTurn: latestTurn ? {
      id: latestTurn.id,
      status: latestTurn.status,
      attempt: latestTurn.attempt,
      deadlineAt: latestTurn.deadlineAt,
      errorCode: latestTurn.errorCode,
      createdAt: latestTurn.createdAt,
      completedAt: latestTurn.completedAt,
    } : null,
    state,
    messages,
    latestAssistantMessage: [...messages].reverse().find((message) => message.role === "ASSISTANT") ?? null,
    eventCursor: conversation.eventCursor,
  };
}
