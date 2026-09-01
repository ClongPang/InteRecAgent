import type { ConversationState } from "@interec/domain";
import pg from "pg";

import type {
  AcceptConversationTurnInput,
  AcceptedConversationTurn,
  AttemptDraft,
  ClaimedConversationTurn,
  CommitQuoteConversationTurnInput,
  ConversationEventRecord,
  ConversationMessageRecord,
  ConversationProjectionRecord,
  ConversationRecord,
  ConversationRepository,
  ConversationTurnRecord,
  FinalCommitResult,
  OwnerClaims,
  RecordPlanReviewInput,
  RetryConversationTurnInput,
  ToolReservation,
} from "./conversation-repository-types.js";
import {
  createPostgresConversation,
  getLatestPostgresTurn,
  getPostgresConversation,
  getPostgresConversationProjection,
  getPostgresRevision,
  getPostgresSnapshot,
  getPostgresTurn,
  listPostgresEvents,
  listPostgresMessages,
} from "./postgres-conversation-store.js";
import {
  recordPostgresAttemptTelemetryLink,
  recordPostgresPlanReview,
  stagePostgresAttemptDraft,
} from "./postgres-turn-attempt-store.js";
import {
  cancelPostgresTurn,
  claimPostgresTurn,
  expireDuePostgresTurns,
  failPostgresTurn,
  heartbeatPostgresTurn,
  markPostgresTurnRunning,
} from "./postgres-turn-lifecycle.js";
import { commitPostgresQuoteConversationTurn } from "./postgres-quote-turn-commit.js";
import { acceptPostgresTurn, retryPostgresTurn } from "./postgres-turn-submission.js";
import {
  completePostgresToolExecution,
  failPostgresToolExecution,
  reservePostgresToolExecution,
} from "./postgres-tool-execution-store.js";

export { canonicalPayloadHash } from "./postgres-conversation-storage.js";

const { Pool } = pg;

/**
 * Stable public repository facade. SQL responsibilities live in focused stores;
 * callers keep one transactional port and do not depend on persistence internals.
 */
export class PostgresConversationRepository implements ConversationRepository {
  public readonly pool: pg.Pool;

  public constructor(connectionString: string, maxConnections = 10) {
    this.pool = new Pool({ connectionString, max: maxConnections });
  }

  public createConversation(owner: OwnerClaims): Promise<ConversationRecord> {
    return createPostgresConversation(this.pool, owner);
  }

  public getConversation(id: string, owner: OwnerClaims): Promise<ConversationRecord | null> {
    return getPostgresConversation(this.pool, id, owner);
  }

  public getProjection(
    conversationId: string,
    owner: OwnerClaims,
  ): Promise<ConversationProjectionRecord | null> {
    return getPostgresConversationProjection(this.pool, conversationId, owner);
  }

  public acceptTurn(input: AcceptConversationTurnInput): Promise<AcceptedConversationTurn> {
    return acceptPostgresTurn(this.pool, input);
  }

  public retryTurn(input: RetryConversationTurnInput): Promise<AcceptedConversationTurn> {
    return retryPostgresTurn(this.pool, input);
  }

  public claimTurn(
    workerId: string,
    leaseSeconds: number,
    turnId?: string,
  ): Promise<ClaimedConversationTurn | null> {
    return claimPostgresTurn(this.pool, workerId, leaseSeconds, turnId);
  }

  public recordAttemptTelemetryLink(
    turnId: string,
    attempt: number,
    fenceToken: string,
    traceId: string,
    rootObservationId: string,
  ): Promise<boolean> {
    return recordPostgresAttemptTelemetryLink(
      this.pool,
      turnId,
      attempt,
      fenceToken,
      traceId,
      rootObservationId,
    );
  }

  public markTurnRunning(turnId: string, attempt: number, fenceToken: string): Promise<boolean> {
    return markPostgresTurnRunning(this.pool, turnId, attempt, fenceToken);
  }

  public heartbeatTurn(
    turnId: string,
    attempt: number,
    fenceToken: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    return heartbeatPostgresTurn(this.pool, turnId, attempt, fenceToken, leaseSeconds);
  }

  public stageAttemptDraft(
    turnId: string,
    attempt: number,
    fenceToken: string,
    draft: AttemptDraft,
  ): Promise<boolean> {
    return stagePostgresAttemptDraft(this.pool, turnId, attempt, fenceToken, draft);
  }

  public recordPlanReview(input: RecordPlanReviewInput): Promise<boolean> {
    return recordPostgresPlanReview(this.pool, input);
  }

  public reserveToolExecution(
    turnId: string,
    attempt: number,
    fenceToken: string,
    stepKey: string,
    request: Record<string, unknown>,
  ): Promise<ToolReservation | null> {
    return reservePostgresToolExecution(this.pool, turnId, attempt, fenceToken, stepKey, request);
  }

  public completeToolExecution(
    turnId: string,
    attempt: number,
    fenceToken: string,
    stepKey: string,
    requestHash: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    return completePostgresToolExecution(
      this.pool,
      turnId,
      attempt,
      fenceToken,
      stepKey,
      requestHash,
      result,
    );
  }

  public failToolExecution(
    turnId: string,
    attempt: number,
    fenceToken: string,
    stepKey: string,
    requestHash: string,
    errorCode: string,
  ): Promise<boolean> {
    return failPostgresToolExecution(
      this.pool,
      turnId,
      attempt,
      fenceToken,
      stepKey,
      requestHash,
      errorCode,
    );
  }

  public commitQuoteTurn(input: CommitQuoteConversationTurnInput): Promise<FinalCommitResult | null> {
    return commitPostgresQuoteConversationTurn(this.pool, input);
  }

  public failTurn(turnId: string, attempt: number, fenceToken: string, errorCode: string): Promise<boolean> {
    return failPostgresTurn(this.pool, turnId, attempt, fenceToken, errorCode);
  }

  public cancelTurn(turnId: string, owner: OwnerClaims): Promise<boolean> {
    return cancelPostgresTurn(this.pool, turnId, owner);
  }

  public expireDueTurns(): Promise<number> {
    return expireDuePostgresTurns(this.pool);
  }

  public getSnapshot(conversationId: string, owner: OwnerClaims): Promise<ConversationState | null> {
    return getPostgresSnapshot(this.pool, conversationId, owner);
  }

  public getTurn(turnId: string, owner: OwnerClaims): Promise<ConversationTurnRecord | null> {
    return getPostgresTurn(this.pool, turnId, owner);
  }

  public getLatestTurn(conversationId: string, owner: OwnerClaims): Promise<ConversationTurnRecord | null> {
    return getLatestPostgresTurn(this.pool, conversationId, owner);
  }

  public getRevision(
    conversationId: string,
    owner: OwnerClaims,
    revision: number,
  ): Promise<ConversationState | null> {
    return getPostgresRevision(this.pool, conversationId, owner, revision);
  }

  public listMessages(
    conversationId: string,
    owner: OwnerClaims,
    afterSeq: number,
  ): Promise<ConversationMessageRecord[]> {
    return listPostgresMessages(this.pool, conversationId, owner, afterSeq);
  }

  public listEvents(
    conversationId: string,
    owner: OwnerClaims,
    afterSeq: number,
  ): Promise<ConversationEventRecord[]> {
    return listPostgresEvents(this.pool, conversationId, owner, afterSeq);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
