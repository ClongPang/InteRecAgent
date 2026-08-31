import { randomUUID } from "node:crypto";

import {
  DomainError,
  validateWorkingSet,
  validateClarificationAnswer,
  type ConversationState,
} from "@interec/domain";
import pg from "pg";

import type {
  AcceptConversationTurnInput,
  AcceptedConversationTurn,
  AttemptDraft,
  ClaimedConversationTurn,
  CommitConversationTurnInput,
  ConversationEventRecord,
  ConversationMessageRecord,
  ConversationProjectionRecord,
  ConversationRecord,
  ConversationRepository,
  ConversationTurnRecord,
  ConversationTurnInput,
  ConversationTurnStatus,
  FinalCommitResult,
  OwnerClaims,
  RecordPlanReviewInput,
  RetryConversationTurnInput,
  ToolReservation,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  allocateMessageSeq,
  appendConversationEvent,
  asIso,
  canonicalPayloadHash,
  hydrateSnapshot,
  inputMessageIds,
  lockConversationForTurn,
  mapConversation,
  mapMessage,
  mapToolExecution,
  mapTurn,
  requiredText,
  setOwnerContext,
  withOwnerSnapshotTransaction,
  withOwnerTransaction,
} from "./postgres-conversation-storage.js";
export { canonicalPayloadHash } from "./postgres-conversation-storage.js";
import { telemetryTraceIdForTurn } from "./telemetry.js";
import {
  commitPostgresConversationTurn,
  recordTerminalTurn,
  validatePersistedPlan,
} from "./postgres-turn-commit.js";


const { Pool } = pg;
const ACTIVE_STATUSES = ["ACCEPTED", "CLAIMED", "RUNNING", "COMMITTING"] as const;





export class PostgresConversationRepository implements ConversationRepository {
  public readonly pool: pg.Pool;

  public constructor(connectionString: string, maxConnections = 10) {
    this.pool = new Pool({ connectionString, max: maxConnections });
  }

  public async createConversation(owner: OwnerClaims): Promise<ConversationRecord> {
    const tenantId = requiredText(owner.tenantId, "INVALID_TENANT_ID");
    const ownerId = requiredText(owner.ownerId, "INVALID_OWNER_ID");
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO interec_agent.conversations (id, tenant_id, owner_id, status)
         VALUES ($1, $2, $3, 'OPEN') RETURNING *`,
        [randomUUID(), tenantId, ownerId],
      );
      return mapConversation(result.rows[0]!);
    });
  }

  public async getConversation(id: string, owner: OwnerClaims): Promise<ConversationRecord | null> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.conversations
         WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
        [id, owner.tenantId, owner.ownerId],
      );
      return result.rows[0] ? mapConversation(result.rows[0]) : null;
    });
  }

  public async getProjection(conversationId: string, owner: OwnerClaims): Promise<ConversationProjectionRecord | null> {
    return withOwnerSnapshotTransaction(this.pool, owner, async (client) => {
      const conversationResult = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.conversations
         WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
        [conversationId, owner.tenantId, owner.ownerId],
      );
      const row = conversationResult.rows[0];
      if (!row) return null;
      const conversation = mapConversation(row);
      const state = await hydrateSnapshot(client, conversationId);
      if (!state) throw new ConversationRepositoryError("CONVERSATION_SNAPSHOT_MISSING", `Conversation snapshot missing: ${conversationId}`);
      const messages = await client.query<Record<string, unknown>>(
        `SELECT m.*, ae.envelope_json, cl.ledger_json
         FROM interec_agent.messages m
         LEFT JOIN interec_agent.assistant_envelopes ae ON ae.response_id = m.assistant_response_id
         LEFT JOIN interec_agent.claim_ledgers cl ON cl.response_id = m.assistant_response_id
         WHERE m.conversation_id = $1 AND m.seq > $2
         ORDER BY m.seq LIMIT 200`,
        [conversationId, Math.max(0, conversation.messageCursor - 200)],
      );
      const activeTurn = conversation.activeTurnId
        ? await client.query<Record<string, unknown>>("SELECT * FROM interec_agent.turns WHERE id = $1", [conversation.activeTurnId])
        : null;
      const latestTurn = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.turns
         WHERE conversation_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [conversationId],
      );
      return {
        conversation,
        state,
        messages: messages.rows.map(mapMessage),
        activeTurn: activeTurn?.rows[0] ? mapTurn(activeTurn.rows[0]) : null,
        latestTurn: latestTurn.rows[0] ? mapTurn(latestTurn.rows[0]) : null,
      };
    });
  }

  public async acceptTurn(input: AcceptConversationTurnInput): Promise<AcceptedConversationTurn> {
    const clientTurnId = requiredText(input.clientTurnId, "INVALID_CLIENT_TURN_ID");
    if (input.input.type === "MESSAGE") {
      const content = input.input.content.trim();
      if (content.length < 1 || content.length > 4000) throw new ConversationRepositoryError("INVALID_MESSAGE_LENGTH", "Message must contain 1-4000 characters");
      if (input.input.focusOfferRef !== undefined) {
        const focusOfferRef = input.input.focusOfferRef.trim();
        if (focusOfferRef.length < 1 || focusOfferRef.length > 128) throw new ConversationRepositoryError("INVALID_FOCUS_OFFER_REF", "Focus offer reference must contain 1-128 characters");
      }
    }
    const requestHash = canonicalPayloadHash({ expectedRevision: input.expectedRevision ?? null, input: input.input });
    const traceId = input.telemetryTraceId ?? telemetryTraceIdForTurn(input.conversationId, clientTurnId);
    if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "0".repeat(32)) {
      throw new ConversationRepositoryError("INVALID_TELEMETRY_TRACE_ID", "Telemetry trace ID must be a non-zero 32-character lowercase hexadecimal value");
    }
    if (input.telemetryRootObservationId !== undefined
      && (!/^[0-9a-f]{16}$/.test(input.telemetryRootObservationId) || input.telemetryRootObservationId === "0".repeat(16))) {
      throw new ConversationRepositoryError("INVALID_TELEMETRY_ROOT_OBSERVATION_ID", "Telemetry root observation ID must be a non-zero 16-character lowercase hexadecimal value");
    }
    const deadlineSeconds = input.deadlineSeconds ?? 60;
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 600) {
      throw new ConversationRepositoryError("INVALID_TURN_DEADLINE", "Turn deadline must contain 1-600 seconds");
    }
    const client = await this.pool.connect();
    let supersededExisting = false;
    try {
      await client.query("BEGIN");
      await setOwnerContext(client, input.owner);
      const owner = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.conversations
         WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 FOR UPDATE`,
        [input.conversationId, input.owner.tenantId, input.owner.ownerId],
      );
      const conversation = owner.rows[0];
      if (!conversation) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${input.conversationId}`);
      if (conversation["status"] !== "OPEN") throw new ConversationRepositoryError("CONVERSATION_NOT_OPEN", `Conversation is not open: ${input.conversationId}`);

      const existing = await client.query<Record<string, unknown>>(
        "SELECT * FROM interec_agent.turns WHERE conversation_id = $1 AND client_turn_id = $2",
        [input.conversationId, clientTurnId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0]["request_hash"] !== requestHash) {
          throw new ConversationRepositoryError("IDEMPOTENCY_KEY_REUSED", `clientTurnId was reused with a different payload: ${clientTurnId}`);
        }
        const ids = await inputMessageIds(client, String(existing.rows[0]["id"]));
        await client.query("COMMIT");
        return { ...mapTurn(existing.rows[0]), inputMessageIds: ids, idempotentReplay: true };
      }

      const currentRevision = Number(conversation["current_revision"]);
      if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
        throw new ConversationRepositoryError("REVISION_CONFLICT", `Expected revision ${input.expectedRevision}, current revision is ${currentRevision}`);
      }
      if (input.input.type === "ANSWER_CLARIFICATION") {
        const snapshot = await hydrateSnapshot(client, input.conversationId, currentRevision);
        if (!snapshot) throw new ConversationRepositoryError("CONVERSATION_SNAPSHOT_NOT_FOUND", `Snapshot ${currentRevision} was not found`);
        try {
          validateClarificationAnswer(snapshot.dialogue, input.input.clarificationId, input.input.answer);
        } catch (error) {
          if (error instanceof DomainError) throw new ConversationRepositoryError(error.code, error.message);
          throw error;
        }
      }

      const turnId = randomUUID();
      const activeTurnId = conversation["active_turn_id"] === null ? null : String(conversation["active_turn_id"]);
      if (activeTurnId) {
        const superseded = await client.query(
          `UPDATE interec_agent.turns
           SET status = 'SUPERSEDED', fence_token = fence_token + 1, lease_expires_at = NULL,
               completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = $1 AND status = ANY($2::text[])`,
          [activeTurnId, [...ACTIVE_STATUSES]],
        );
        if (superseded.rowCount === 1) {
          supersededExisting = true;
          await client.query(
            `UPDATE interec_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp()
             WHERE turn_id = $1 AND status IN ('CLAIMED', 'RUNNING')`,
            [activeTurnId],
          );
          await appendConversationEvent(client, input.conversationId, activeTurnId, "turn.superseded", { supersededByTurnId: turnId });
        }
      }

      const messageId = randomUUID();
      const messageSeq = await allocateMessageSeq(client, input.conversationId);
      await client.query(
        `INSERT INTO interec_agent.messages
           (id, conversation_id, seq, role, payload_json, client_turn_id, request_hash)
         VALUES ($1, $2, $3, 'USER', $4::jsonb, $5, $6)`,
        [messageId, input.conversationId, messageSeq, JSON.stringify(input.input), clientTurnId, requestHash],
      );
      const unconsumed = await client.query<{ id: string; payload_json: ConversationTurnInput }>(
        `SELECT id, payload_json FROM interec_agent.messages
         WHERE conversation_id = $1 AND role = 'USER' AND consumed_by_turn_id IS NULL
         ORDER BY seq`,
        [input.conversationId],
      );
      if (unconsumed.rows.length > 8) {
        throw new ConversationRepositoryError("UNCONSUMED_MESSAGE_BATCH_LIMIT", "A Turn can contain at most eight consecutive USER messages");
      }
      const unconsumedInputs = unconsumed.rows.map((message) => message.payload_json);
      if (unconsumedInputs.every((value) => value.type !== "MESSAGE" && !(value.type === "ANSWER_CLARIFICATION" && value.answer.type === "TEXT"))) {
        const operationCount = unconsumedInputs.reduce((count, value) => count + (value.type === "PATCH_GOAL" ? value.operations.length : 1), 0);
        if (operationCount > 12) throw new ConversationRepositoryError("TURN_OPERATION_BUDGET_EXCEEDED", `Typed batch contains ${operationCount} operations`);
      }
      await client.query(
        `INSERT INTO interec_agent.turns
           (id, conversation_id, client_turn_id, request_hash, latest_input_message_id, base_revision, status, deadline_at, trace_id, trace_root_observation_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', clock_timestamp() + make_interval(secs => $7), $8, $9)`,
        [turnId, input.conversationId, clientTurnId, requestHash, messageId, currentRevision, deadlineSeconds, traceId, input.telemetryRootObservationId ?? null],
      );
      for (const [ordinal, message] of unconsumed.rows.entries()) {
        await client.query(
          "INSERT INTO interec_agent.turn_input_messages (turn_id, message_id, ordinal) VALUES ($1, $2, $3)",
          [turnId, message.id, ordinal],
        );
      }
      await client.query(
        "UPDATE interec_agent.conversations SET active_turn_id = $2, updated_at = clock_timestamp() WHERE id = $1",
        [input.conversationId, turnId],
      );
      await appendConversationEvent(client, input.conversationId, turnId, "turn.accepted", { messageSeq, baseRevision: currentRevision });
      const created = await client.query<Record<string, unknown>>("SELECT * FROM interec_agent.turns WHERE id = $1", [turnId]);
      await client.query("COMMIT");
      if (supersededExisting) recordTerminalTurn("SUPERSEDED");
      return { ...mapTurn(created.rows[0]!), inputMessageIds: unconsumed.rows.map((message) => message.id), idempotentReplay: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryTurn(input: RetryConversationTurnInput): Promise<AcceptedConversationTurn> {
    const clientTurnId = requiredText(input.clientTurnId, "INVALID_CLIENT_TURN_ID");
    const deadlineSeconds = input.deadlineSeconds ?? 60;
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 600) {
      throw new ConversationRepositoryError("INVALID_TURN_DEADLINE", "Turn deadline must contain 1-600 seconds");
    }
    const requestHash = canonicalPayloadHash({ type: "RETRY", retryOfTurnId: input.turnId });
    const traceId = input.telemetryTraceId ?? telemetryTraceIdForTurn(input.conversationId, clientTurnId);
    if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "0".repeat(32)) {
      throw new ConversationRepositoryError("INVALID_TELEMETRY_TRACE_ID", "Telemetry trace ID must be a non-zero 32-character lowercase hexadecimal value");
    }
    if (input.telemetryRootObservationId !== undefined
      && (!/^[0-9a-f]{16}$/.test(input.telemetryRootObservationId) || input.telemetryRootObservationId === "0".repeat(16))) {
      throw new ConversationRepositoryError("INVALID_TELEMETRY_ROOT_OBSERVATION_ID", "Telemetry root observation ID must be a non-zero 16-character lowercase hexadecimal value");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setOwnerContext(client, input.owner);
      const owner = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.conversations
         WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 FOR UPDATE`,
        [input.conversationId, input.owner.tenantId, input.owner.ownerId],
      );
      const conversation = owner.rows[0];
      if (!conversation) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${input.conversationId}`);
      if (conversation["status"] !== "OPEN") throw new ConversationRepositoryError("CONVERSATION_NOT_OPEN", `Conversation is not open: ${input.conversationId}`);
      const existing = await client.query<Record<string, unknown>>(
        "SELECT * FROM interec_agent.turns WHERE conversation_id = $1 AND client_turn_id = $2",
        [input.conversationId, clientTurnId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0]["request_hash"] !== requestHash) {
          throw new ConversationRepositoryError("IDEMPOTENCY_KEY_REUSED", `clientTurnId was reused with another retry target: ${clientTurnId}`);
        }
        const ids = await inputMessageIds(client, String(existing.rows[0]["id"]));
        await client.query("COMMIT");
        return { ...mapTurn(existing.rows[0]), inputMessageIds: ids, idempotentReplay: true };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(conversation["current_revision"])) {
        throw new ConversationRepositoryError("REVISION_CONFLICT", `Expected revision ${input.expectedRevision}, current revision is ${conversation["current_revision"]}`);
      }
      if (conversation["active_turn_id"] !== null) {
        throw new ConversationRepositoryError("CONVERSATION_TURN_ACTIVE", "A retry cannot start while another Turn is active");
      }
      const source = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.turns
         WHERE id = $1 AND conversation_id = $2 AND status IN ('FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTER')`,
        [input.turnId, input.conversationId],
      );
      if (!source.rows[0]) throw new ConversationRepositoryError("TURN_NOT_RETRYABLE", `Turn is not retryable: ${input.turnId}`);
      const unconsumed = await client.query<{ id: string }>(
        `SELECT id FROM interec_agent.messages
         WHERE conversation_id = $1 AND role = 'USER' AND consumed_by_turn_id IS NULL
         ORDER BY seq`,
        [input.conversationId],
      );
      if (unconsumed.rows.length === 0) throw new ConversationRepositoryError("RETRY_INPUT_ALREADY_CONSUMED", "No unconsumed USER batch remains for retry");
      const turnId = randomUUID();
      const latestInputMessageId = unconsumed.rows.at(-1)!.id;
      await client.query(
        `INSERT INTO interec_agent.turns
           (id, conversation_id, client_turn_id, request_hash, latest_input_message_id, base_revision, status, deadline_at, trace_id, trace_root_observation_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', clock_timestamp() + make_interval(secs => $7), $8, $9)`,
        [turnId, input.conversationId, clientTurnId, requestHash, latestInputMessageId, conversation["current_revision"], deadlineSeconds, traceId, input.telemetryRootObservationId ?? null],
      );
      for (const [ordinal, message] of unconsumed.rows.entries()) {
        await client.query(
          "INSERT INTO interec_agent.turn_input_messages (turn_id, message_id, ordinal) VALUES ($1, $2, $3)",
          [turnId, message.id, ordinal],
        );
      }
      await client.query(
        "UPDATE interec_agent.conversations SET active_turn_id = $2, updated_at = clock_timestamp() WHERE id = $1",
        [input.conversationId, turnId],
      );
      await appendConversationEvent(client, input.conversationId, turnId, "turn.retry_accepted", { retryOfTurnId: input.turnId, baseRevision: Number(conversation["current_revision"]) });
      const created = await client.query<Record<string, unknown>>("SELECT * FROM interec_agent.turns WHERE id = $1", [turnId]);
      await client.query("COMMIT");
      return { ...mapTurn(created.rows[0]!), inputMessageIds: unconsumed.rows.map((message) => message.id), idempotentReplay: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimTurn(workerId: string, leaseSeconds: number, turnId?: string): Promise<ClaimedConversationTurn | null> {
    requiredText(workerId, "INVALID_WORKER_ID");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new ConversationRepositoryError("INVALID_LEASE", "Lease must contain 1-300 seconds");
    if (!turnId) await this.expireDueTurns();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query<{ id: string }>(
        `SELECT c.id
         FROM interec_agent.conversations c
         WHERE c.status = 'OPEN'
           AND ($1::uuid IS NULL OR c.active_turn_id = $1::uuid)
           AND EXISTS (
             SELECT 1 FROM interec_agent.turns t
             WHERE t.conversation_id = c.id
               AND t.id = c.active_turn_id
               AND t.attempt < 3
               AND t.deadline_at > clock_timestamp()
               AND (t.status = 'ACCEPTED' OR (t.status IN ('CLAIMED', 'RUNNING') AND t.lease_expires_at < clock_timestamp()))
           )
         ORDER BY c.created_at
         FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
        [turnId ?? null],
      );
      if (!conversation.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const candidate = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.turns
         WHERE conversation_id = $1 AND id = (SELECT active_turn_id FROM interec_agent.conversations WHERE id = $1)
         FOR UPDATE`,
        [conversation.rows[0].id],
      );
      const row = candidate.rows[0];
      if (!row) throw new ConversationRepositoryError("ACTIVE_TURN_MISSING", `Active turn is missing for conversation ${conversation.rows[0].id}`);
      const priorAttempt = Number(row["attempt"]);
      const claimed = await client.query<Record<string, unknown>>(
        `UPDATE interec_agent.turns
         SET status = 'CLAIMED', attempt = attempt + 1, fence_token = fence_token + 1,
             worker_id = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3),
             updated_at = clock_timestamp()
         WHERE id = $1 AND attempt < 3 AND deadline_at > clock_timestamp()
           AND (status = 'ACCEPTED' OR (status IN ('CLAIMED', 'RUNNING') AND lease_expires_at < clock_timestamp()))
         RETURNING *`,
        [row["id"], workerId, leaseSeconds],
      );
      const turn = claimed.rows[0];
      if (!turn) {
        await client.query("COMMIT");
        return null;
      }
      if (priorAttempt > 0) {
        await client.query(
          `UPDATE interec_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp()
           WHERE turn_id = $1 AND attempt = $2 AND status IN ('CLAIMED', 'RUNNING')`,
          [row["id"], priorAttempt],
        );
      }
      await client.query(
        `INSERT INTO interec_agent.turn_attempts (turn_id, attempt, fence_token, base_revision, status, trace_id)
         VALUES ($1, $2, $3::bigint, $4, 'CLAIMED', $5)`,
        [turn["id"], turn["attempt"], turn["fence_token"], turn["base_revision"], turn["trace_id"]],
      );
      await appendConversationEvent(client, String(turn["conversation_id"]), String(turn["id"]), "turn.claimed", { attempt: Number(turn["attempt"]) });
      const messages = await client.query<Record<string, unknown>>(
        `SELECT m.* FROM interec_agent.turn_input_messages tim
         JOIN interec_agent.messages m ON m.id = tim.message_id
         WHERE tim.turn_id = $1 ORDER BY tim.ordinal`,
        [turn["id"]],
      );
      const owner = await client.query<{ tenant_id: string; owner_id: string }>(
        "SELECT tenant_id, owner_id FROM interec_agent.conversations WHERE id = $1",
        [turn["conversation_id"]],
      );
      const snapshot = await hydrateSnapshot(client, String(turn["conversation_id"]));
      if (!snapshot) throw new ConversationRepositoryError("CONVERSATION_REVISION_MISSING", `Conversation revision is missing: ${turn["conversation_id"]}`);
      await client.query("COMMIT");
      return {
        ...mapTurn(turn),
        owner: { tenantId: owner.rows[0]!.tenant_id, ownerId: owner.rows[0]!.owner_id },
        inputMessages: messages.rows.map(mapMessage),
        snapshot,
        telemetryTraceId: String(turn["trace_id"]),
        ...(turn["trace_root_observation_id"] ? { telemetryRootObservationId: String(turn["trace_root_observation_id"]) } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordAttemptTelemetryLink(
    turnId: string,
    attempt: number,
    fenceToken: string,
    traceId: string,
    rootObservationId: string,
  ): Promise<boolean> {
    if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "0".repeat(32)) return false;
    if (!/^[0-9a-f]{16}$/.test(rootObservationId) || rootObservationId === "0".repeat(16)) return false;
    const result = await this.pool.query(
      `UPDATE interec_agent.turn_attempts
       SET root_observation_id = $5, updated_at = clock_timestamp()
       WHERE turn_id = $1 AND attempt = $2 AND fence_token = $3::bigint
         AND trace_id = $4 AND status IN ('CLAIMED', 'RUNNING')`,
      [turnId, attempt, fenceToken, traceId, rootObservationId],
    );
    return result.rowCount === 1;
  }

  public async markTurnRunning(turnId: string, attempt: number, fenceToken: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await lockConversationForTurn(client, turnId);
      if (!conversation) {
        await client.query("COMMIT");
        return false;
      }
      const result = await client.query(
        `UPDATE interec_agent.turns
         SET status = 'RUNNING', updated_at = clock_timestamp()
         WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status = 'CLAIMED'
           AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()`,
        [turnId, attempt, fenceToken],
      );
      if (result.rowCount === 1) {
        await client.query(
          "UPDATE interec_agent.turn_attempts SET status = 'RUNNING', updated_at = clock_timestamp() WHERE turn_id = $1 AND attempt = $2 AND fence_token = $3::bigint",
          [turnId, attempt, fenceToken],
        );
        await appendConversationEvent(client, String(conversation["id"]), turnId, "turn.started", { attempt });
      }
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async heartbeatTurn(turnId: string, attempt: number, fenceToken: string, leaseSeconds: number): Promise<boolean> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) return false;
    const result = await this.pool.query(
      `UPDATE interec_agent.turns
       SET lease_expires_at = clock_timestamp() + make_interval(secs => $4), updated_at = clock_timestamp()
       WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status = 'RUNNING'
         AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()`,
      [turnId, attempt, fenceToken, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  public async stageAttemptDraft(turnId: string, attempt: number, fenceToken: string, draft: AttemptDraft): Promise<boolean> {
    if (draft.plan) validatePersistedPlan(draft.plan, draft.envelope);
    if (draft.workingSet) validateWorkingSet(draft.workingSet);
    const patch: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(draft, "plan")) patch["plan"] = draft.plan ?? null;
    if (Object.prototype.hasOwnProperty.call(draft, "goal")) patch["goal"] = draft.goal ?? null;
    if (Object.prototype.hasOwnProperty.call(draft, "dialogue")) patch["dialogue"] = draft.dialogue ?? null;
    if (Object.prototype.hasOwnProperty.call(draft, "workingSet")) patch["workingSet"] = draft.workingSet ?? null;
    if (Object.prototype.hasOwnProperty.call(draft, "envelope")) patch["envelope"] = draft.envelope ?? null;
    if (Object.prototype.hasOwnProperty.call(draft, "groundedClaims")) patch["groundedClaims"] = draft.groundedClaims ?? null;
    if (Object.prototype.hasOwnProperty.call(draft, "fallbackReasonCode")) patch["fallbackReasonCode"] = draft.fallbackReasonCode ?? null;
    const result = await this.pool.query(
      `UPDATE interec_agent.turn_attempts ta
       SET plan_json = COALESCE($4::jsonb, plan_json),
           draft_goal_json = COALESCE($5::jsonb, draft_goal_json),
           draft_dialogue_json = COALESCE($6::jsonb, draft_dialogue_json),
           draft_working_set_json = COALESCE($7::jsonb, draft_working_set_json),
           draft_envelope_json = COALESCE($8::jsonb, draft_envelope_json),
           draft_claim_ledger_json = COALESCE($9::jsonb, draft_claim_ledger_json),
           draft_json = draft_json || $11::jsonb,
           evidence_keys = CASE WHEN $10::text[] IS NULL THEN evidence_keys ELSE $10::text[] END,
           updated_at = clock_timestamp()
       FROM interec_agent.turns t
       WHERE ta.turn_id = t.id AND ta.turn_id = $1 AND ta.attempt = $2 AND ta.fence_token = $3::bigint
         AND ta.status = 'RUNNING' AND t.status = 'RUNNING'
         AND t.attempt = $2 AND t.fence_token = $3::bigint
         AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()`,
      [
        turnId,
        attempt,
        fenceToken,
        draft.plan ? JSON.stringify(draft.plan) : null,
        draft.goal ? JSON.stringify(draft.goal) : null,
        draft.dialogue ? JSON.stringify(draft.dialogue) : null,
        draft.workingSet ? JSON.stringify(draft.workingSet) : null,
        draft.envelope ? JSON.stringify(draft.envelope) : null,
        draft.groundedClaims ? JSON.stringify(draft.groundedClaims) : null,
        draft.evidenceKeys ?? null,
        JSON.stringify(patch),
      ],
    );
    return result.rowCount === 1;
  }

  public async recordPlanReview(input: RecordPlanReviewInput): Promise<boolean> {
    if (!Number.isSafeInteger(input.proposalNumber) || input.proposalNumber < 1 || input.proposalNumber > 3) {
      throw new ConversationRepositoryError("INVALID_PLAN_PROPOSAL_NUMBER", "Plan proposal number must be between 1 and 3");
    }
    const result = await this.pool.query(
      `INSERT INTO interec_agent.turn_plan_reviews (
         id, turn_id, attempt, proposal_number, decision, policy_version,
         proposal_json, reviewed_plan_json, violations_json, approved_plan_json
       )
       SELECT $4::uuid, t.id, $2, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb
       FROM interec_agent.turns t
       JOIN interec_agent.turn_attempts ta ON ta.turn_id = t.id AND ta.attempt = $2
       WHERE t.id = $1 AND t.attempt = $2 AND t.fence_token = $3::bigint
         AND t.status = 'RUNNING' AND ta.status = 'RUNNING' AND ta.fence_token = $3::bigint
         AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()
       ON CONFLICT (turn_id, attempt, proposal_number) DO NOTHING`,
      [
        input.turnId,
        input.attempt,
        input.fenceToken,
        randomUUID(),
        input.proposalNumber,
        input.review.decision,
        input.review.policyVersion,
        JSON.stringify(input.proposal),
        JSON.stringify(input.reviewedPlan),
        JSON.stringify("violations" in input.review ? input.review.violations : []),
        input.approvedPlan ? JSON.stringify(input.approvedPlan) : null,
      ],
    );
    return result.rowCount === 1;
  }

  public async reserveToolExecution(
    turnId: string,
    attempt: number,
    fenceToken: string,
    stepKey: string,
    request: Record<string, unknown>,
  ): Promise<ToolReservation | null> {
    const normalizedStepKey = requiredText(stepKey, "INVALID_STEP_KEY");
    const requestHash = canonicalPayloadHash(request);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const turn = await client.query<Record<string, unknown>>(
        `SELECT * FROM interec_agent.turns
         WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status = 'RUNNING'
           AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()
         FOR UPDATE`,
        [turnId, attempt, fenceToken],
      );
      if (!turn.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const existing = await client.query<Record<string, unknown>>(
        "SELECT * FROM interec_agent.tool_executions WHERE turn_id = $1 AND step_key = $2 FOR UPDATE",
        [turnId, normalizedStepKey],
      );
      const row = existing.rows[0];
      if (row) {
        if (row["request_hash"] !== requestHash) {
          throw new ConversationRepositoryError("TOOL_STEP_REQUEST_CONFLICT", `Stable tool step was reused with a different request: ${normalizedStepKey}`);
        }
        if (row["status"] === "SUCCEEDED") {
          await client.query("COMMIT");
          return { action: "REUSE", execution: mapToolExecution(row) };
        }
        if (Number(row["attempt"]) === attempt && (row["status"] === "PENDING" || row["status"] === "RUNNING")) {
          await client.query("COMMIT");
          return { action: "WAIT", execution: mapToolExecution(row) };
        }
        const recovered = await client.query<Record<string, unknown>>(
          `UPDATE interec_agent.tool_executions
           SET attempt = $3, status = 'RUNNING', result_json = NULL, error_code = NULL,
               started_at = clock_timestamp(), completed_at = NULL
           WHERE turn_id = $1 AND step_key = $2 RETURNING *`,
          [turnId, normalizedStepKey, attempt],
        );
        await client.query("COMMIT");
        return { action: "CALL", execution: mapToolExecution(recovered.rows[0]!) };
      }
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO interec_agent.tool_executions
           (id, turn_id, attempt, step_key, request_hash, status, request_json, started_at)
         VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6::jsonb, clock_timestamp()) RETURNING *`,
        [randomUUID(), turnId, attempt, normalizedStepKey, requestHash, JSON.stringify(request)],
      );
      await client.query("COMMIT");
      return { action: "CALL", execution: mapToolExecution(inserted.rows[0]!) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeToolExecution(
    turnId: string,
    attempt: number,
    fenceToken: string,
    stepKey: string,
    requestHash: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const completed = await this.pool.query(
      `UPDATE interec_agent.tool_executions te
       SET status = 'SUCCEEDED', result_json = $6::jsonb, error_code = NULL, completed_at = clock_timestamp()
       FROM interec_agent.turns t
       WHERE te.turn_id = t.id AND te.turn_id = $1 AND te.attempt = $2 AND te.step_key = $4 AND te.request_hash = $5
         AND te.status = 'RUNNING' AND t.attempt = $2 AND t.fence_token = $3::bigint AND t.status = 'RUNNING'
         AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()`,
      [turnId, attempt, fenceToken, requiredText(stepKey, "INVALID_STEP_KEY"), requestHash, JSON.stringify(result)],
    );
    return completed.rowCount === 1;
  }

  public async failToolExecution(
    turnId: string,
    attempt: number,
    fenceToken: string,
    stepKey: string,
    requestHash: string,
    errorCode: string,
  ): Promise<boolean> {
    const failed = await this.pool.query(
      `UPDATE interec_agent.tool_executions te
       SET status = 'FAILED', error_code = $6, completed_at = clock_timestamp()
       FROM interec_agent.turns t
       WHERE te.turn_id = t.id AND te.turn_id = $1 AND te.attempt = $2 AND te.step_key = $4 AND te.request_hash = $5
         AND te.status = 'RUNNING' AND t.attempt = $2 AND t.fence_token = $3::bigint AND t.status = 'RUNNING'
         AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()`,
      [turnId, attempt, fenceToken, requiredText(stepKey, "INVALID_STEP_KEY"), requestHash, requiredText(errorCode, "INVALID_ERROR_CODE")],
    );
    return failed.rowCount === 1;
  }

  public async commitTurn(input: CommitConversationTurnInput): Promise<FinalCommitResult | null> {
    return commitPostgresConversationTurn(this.pool, input);
  }

  public async failTurn(turnId: string, attempt: number, fenceToken: string, errorCode: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await lockConversationForTurn(client, turnId);
      if (!conversation) {
        await client.query("COMMIT");
        return false;
      }
      const result = await client.query<{ status: ConversationTurnStatus }>(
        `UPDATE interec_agent.turns
         SET status = CASE WHEN deadline_at <= clock_timestamp() THEN 'TIMED_OUT' ELSE 'FAILED' END,
             error_code = $4, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status IN ('CLAIMED', 'RUNNING')
           AND lease_expires_at > clock_timestamp()
         RETURNING status`,
        [turnId, attempt, fenceToken, requiredText(errorCode, "INVALID_ERROR_CODE")],
      );
      const terminalStatus = result.rows[0]?.status;
      if (terminalStatus) {
        await client.query("UPDATE interec_agent.turn_attempts SET status = 'FAILED', updated_at = clock_timestamp() WHERE turn_id = $1 AND attempt = $2", [turnId, attempt]);
        await client.query("UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE id = $1 AND active_turn_id = $2", [conversation["id"], turnId]);
        await appendConversationEvent(client, String(conversation["id"]), turnId, terminalStatus === "TIMED_OUT" ? "turn.timed_out" : "turn.failed", { errorCode });
      }
      await client.query("COMMIT");
      if (terminalStatus) recordTerminalTurn(terminalStatus);
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async cancelTurn(turnId: string, owner: OwnerClaims): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setOwnerContext(client, owner);
      const conversation = await client.query<Record<string, unknown>>(
        `SELECT c.* FROM interec_agent.conversations c
         JOIN interec_agent.turns t ON t.conversation_id = c.id
         WHERE t.id = $1 AND c.tenant_id = $2 AND c.owner_id = $3 FOR UPDATE OF c`,
        [turnId, owner.tenantId, owner.ownerId],
      );
      if (!conversation.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      const result = await client.query(
        `UPDATE interec_agent.turns
         SET status = 'CANCELLED', fence_token = fence_token + 1, lease_expires_at = NULL,
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND status = ANY($2::text[])`,
        [turnId, [...ACTIVE_STATUSES]],
      );
      if (result.rowCount === 1) {
        await client.query("UPDATE interec_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp() WHERE turn_id = $1 AND status IN ('CLAIMED', 'RUNNING')", [turnId]);
        await client.query("UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE id = $1 AND active_turn_id = $2", [conversation.rows[0]["id"], turnId]);
        await appendConversationEvent(client, String(conversation.rows[0]["id"]), turnId, "turn.cancelled", {});
      }
      await client.query("COMMIT");
      if (result.rowCount === 1) recordTerminalTurn("CANCELLED");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireDueTurns(): Promise<number> {
    let expired = 0;
    for (;;) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const conversation = await client.query<{ id: string; active_turn_id: string }>(
          `SELECT c.id, c.active_turn_id
           FROM interec_agent.conversations c
           JOIN interec_agent.turns t ON t.id = c.active_turn_id
           WHERE t.status = ANY($1::text[])
             AND (t.deadline_at <= clock_timestamp() OR (t.attempt >= 3 AND t.lease_expires_at < clock_timestamp()))
           ORDER BY t.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
          [[...ACTIVE_STATUSES]],
        );
        if (!conversation.rows[0]) {
          await client.query("COMMIT");
          return expired;
        }
        const turn = await client.query<Record<string, unknown>>(
          "SELECT *, deadline_at <= clock_timestamp() AS deadline_expired FROM interec_agent.turns WHERE id = $1 FOR UPDATE",
          [conversation.rows[0].active_turn_id],
        );
        const row = turn.rows[0]!;
        const status = row["deadline_expired"] === true ? "TIMED_OUT" : "DEAD_LETTER";
        const errorCode = status === "TIMED_OUT" ? "TURN_DEADLINE_EXCEEDED" : "MAX_ATTEMPTS_EXHAUSTED";
        await client.query(
          `UPDATE interec_agent.turns SET status = $2, error_code = $3, fence_token = fence_token + 1,
             lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
          [row["id"], status, errorCode],
        );
        await client.query("UPDATE interec_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp() WHERE turn_id = $1 AND status IN ('CLAIMED', 'RUNNING')", [row["id"]]);
        await client.query("UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE id = $1", [conversation.rows[0].id]);
        await appendConversationEvent(client, conversation.rows[0].id, String(row["id"]), status === "TIMED_OUT" ? "turn.timed_out" : "turn.dead_letter", { errorCode });
        await client.query("COMMIT");
        recordTerminalTurn(status);
        expired += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  public async getSnapshot(conversationId: string, owner: OwnerClaims): Promise<ConversationState | null> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const exists = await client.query(
        "SELECT 1 FROM interec_agent.conversations WHERE id = $1 AND tenant_id = $2 AND owner_id = $3",
        [conversationId, owner.tenantId, owner.ownerId],
      );
      return exists.rowCount === 1 ? hydrateSnapshot(client, conversationId) : null;
    });
  }

  public async getTurn(turnId: string, owner: OwnerClaims): Promise<ConversationTurnRecord | null> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT t.* FROM interec_agent.turns t
         JOIN interec_agent.conversations c ON c.id = t.conversation_id
         WHERE t.id = $1 AND c.tenant_id = $2 AND c.owner_id = $3`,
        [turnId, owner.tenantId, owner.ownerId],
      );
      return result.rows[0] ? mapTurn(result.rows[0]) : null;
    });
  }

  public async getLatestTurn(conversationId: string, owner: OwnerClaims): Promise<ConversationTurnRecord | null> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT t.* FROM interec_agent.turns t
         JOIN interec_agent.conversations c ON c.id = t.conversation_id
         WHERE t.conversation_id = $1 AND c.tenant_id = $2 AND c.owner_id = $3
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT 1`,
        [conversationId, owner.tenantId, owner.ownerId],
      );
      return result.rows[0] ? mapTurn(result.rows[0]) : null;
    });
  }

  public async getRevision(conversationId: string, owner: OwnerClaims, revision: number): Promise<ConversationState | null> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const exists = await client.query(
        "SELECT 1 FROM interec_agent.conversations WHERE id = $1 AND tenant_id = $2 AND owner_id = $3",
        [conversationId, owner.tenantId, owner.ownerId],
      );
      return exists.rowCount === 1 ? hydrateSnapshot(client, conversationId, revision) : null;
    });
  }

  public async listMessages(conversationId: string, owner: OwnerClaims, afterSeq: number): Promise<ConversationMessageRecord[]> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT m.*, ae.envelope_json, cl.ledger_json
         FROM interec_agent.messages m
         JOIN interec_agent.conversations c ON c.id = m.conversation_id
         LEFT JOIN interec_agent.assistant_envelopes ae ON ae.response_id = m.assistant_response_id
         LEFT JOIN interec_agent.claim_ledgers cl ON cl.response_id = m.assistant_response_id
         WHERE m.conversation_id = $1 AND c.tenant_id = $2 AND c.owner_id = $3 AND m.seq > $4
         ORDER BY m.seq LIMIT 200`,
        [conversationId, owner.tenantId, owner.ownerId, afterSeq],
      );
      return result.rows.map(mapMessage);
    });
  }

  public async listEvents(conversationId: string, owner: OwnerClaims, afterSeq: number): Promise<ConversationEventRecord[]> {
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT e.* FROM interec_agent.turn_events e
         JOIN interec_agent.conversations c ON c.id = e.conversation_id
         WHERE e.conversation_id = $1 AND c.tenant_id = $2 AND c.owner_id = $3 AND e.seq > $4
         ORDER BY e.seq LIMIT 200`,
        [conversationId, owner.tenantId, owner.ownerId, afterSeq],
      );
      return result.rows.map((row) => ({
        id: String(row["id"]),
        conversationId: String(row["conversation_id"]),
        turnId: row["turn_id"] === null ? null : String(row["turn_id"]),
        seq: Number(row["seq"]),
        eventType: String(row["event_type"]),
        publicPayload: row["public_payload"] as Record<string, unknown>,
        createdAt: asIso(row["created_at"]),
      }));
    });
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
