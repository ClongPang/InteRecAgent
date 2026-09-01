import { randomUUID } from "node:crypto";

import { QUOTE_LEAD_CONTRACT_VERSION } from "@interec/domain";
import type pg from "pg";

import type {
  AcceptConversationTurnInput,
  AcceptedConversationTurn,
  ConversationTurnInput,
  RetryConversationTurnInput,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  ACTIVE_TURN_STATUSES,
  allocateMessageSeq,
  appendConversationEvent,
  canonicalPayloadHash,
  inputMessageIds,
  mapTurn,
  requiredText,
  setOwnerContext,
} from "./postgres-conversation-storage.js";
import { telemetryTraceIdForTurn } from "./telemetry.js";
import { recordTerminalTurn } from "./turn-terminal-metrics.js";

interface TurnRequestMetadata {
  clientTurnId: string;
  deadlineSeconds: number;
  traceId: string;
}

function turnRequestMetadata(input: {
  conversationId: string;
  clientTurnId: string;
  deadlineSeconds?: number;
  telemetryTraceId?: string;
  telemetryRootObservationId?: string;
}): TurnRequestMetadata {
  const clientTurnId = requiredText(input.clientTurnId, "INVALID_CLIENT_TURN_ID");
  const deadlineSeconds = input.deadlineSeconds ?? 60;
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 600) {
    throw new ConversationRepositoryError("INVALID_TURN_DEADLINE", "Turn deadline must contain 1-600 seconds");
  }
  const traceId = input.telemetryTraceId ?? telemetryTraceIdForTurn(input.conversationId, clientTurnId);
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "0".repeat(32)) {
    throw new ConversationRepositoryError(
      "INVALID_TELEMETRY_TRACE_ID",
      "Telemetry trace ID must be a non-zero 32-character lowercase hexadecimal value",
    );
  }
  const rootObservationId = input.telemetryRootObservationId;
  if (rootObservationId !== undefined
    && (!/^[0-9a-f]{16}$/.test(rootObservationId) || rootObservationId === "0".repeat(16))) {
    throw new ConversationRepositoryError(
      "INVALID_TELEMETRY_ROOT_OBSERVATION_ID",
      "Telemetry root observation ID must be a non-zero 16-character lowercase hexadecimal value",
    );
  }
  return { clientTurnId, deadlineSeconds, traceId };
}

export async function acceptPostgresTurn(
  pool: pg.Pool,
  input: AcceptConversationTurnInput,
): Promise<AcceptedConversationTurn> {
  const metadata = turnRequestMetadata(input);
  const content = input.input.content.trim();
  if (content.length < 1 || content.length > 4000) {
    throw new ConversationRepositoryError("INVALID_MESSAGE_LENGTH", "Message must contain 1-4000 characters");
  }
  const requestHash = canonicalPayloadHash({ expectedRevision: input.expectedRevision ?? null, input: input.input });
  const client = await pool.connect();
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
    if (!conversation) {
      throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${input.conversationId}`);
    }
    if (conversation["status"] !== "OPEN") {
      throw new ConversationRepositoryError("CONVERSATION_NOT_OPEN", `Conversation is not open: ${input.conversationId}`);
    }
    if (conversation["contract_version"] !== QUOTE_LEAD_CONTRACT_VERSION) {
      throw new ConversationRepositoryError(
        "LEGACY_CONVERSATION_RETIRED",
        "The retired recommendation contract is read-only and cannot accept new turns",
      );
    }

    const existing = await client.query<Record<string, unknown>>(
      "SELECT * FROM interec_agent.turns WHERE conversation_id = $1 AND client_turn_id = $2",
      [input.conversationId, metadata.clientTurnId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0]["request_hash"] !== requestHash) {
        throw new ConversationRepositoryError(
          "IDEMPOTENCY_KEY_REUSED",
          `clientTurnId was reused with a different payload: ${metadata.clientTurnId}`,
        );
      }
      const ids = await inputMessageIds(client, String(existing.rows[0]["id"]));
      await client.query("COMMIT");
      return { ...mapTurn(existing.rows[0]), inputMessageIds: ids, idempotentReplay: true };
    }

    const currentRevision = Number(conversation["current_revision"]);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new ConversationRepositoryError(
        "REVISION_CONFLICT",
        `Expected revision ${input.expectedRevision}, current revision is ${currentRevision}`,
      );
    }
    const turnId = randomUUID();
    const activeTurnId = conversation["active_turn_id"] === null ? null : String(conversation["active_turn_id"]);
    if (activeTurnId) {
      const superseded = await client.query(
        `UPDATE interec_agent.turns
         SET status = 'SUPERSEDED', fence_token = fence_token + 1, lease_expires_at = NULL,
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND status = ANY($2::text[])`,
        [activeTurnId, [...ACTIVE_TURN_STATUSES]],
      );
      if (superseded.rowCount === 1) {
        supersededExisting = true;
        await client.query(
          `UPDATE interec_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp()
           WHERE turn_id = $1 AND status IN ('CLAIMED', 'RUNNING')`,
          [activeTurnId],
        );
        await appendConversationEvent(
          client,
          input.conversationId,
          activeTurnId,
          "turn.superseded",
          { supersededByTurnId: turnId },
        );
      }
    }

    const messageId = randomUUID();
    const messageSeq = await allocateMessageSeq(client, input.conversationId);
    await client.query(
      `INSERT INTO interec_agent.messages
         (id, conversation_id, seq, role, payload_json, client_turn_id, request_hash)
       VALUES ($1, $2, $3, 'USER', $4::jsonb, $5, $6)`,
      [messageId, input.conversationId, messageSeq, JSON.stringify(input.input), metadata.clientTurnId, requestHash],
    );
    const unconsumed = await client.query<{ id: string; payload_json: ConversationTurnInput }>(
      `SELECT id, payload_json FROM interec_agent.messages
       WHERE conversation_id = $1 AND role = 'USER' AND consumed_by_turn_id IS NULL
       ORDER BY seq`,
      [input.conversationId],
    );
    if (unconsumed.rows.length > 8) {
      throw new ConversationRepositoryError(
        "UNCONSUMED_MESSAGE_BATCH_LIMIT",
        "A Turn can contain at most eight consecutive USER messages",
      );
    }
    await client.query(
      `INSERT INTO interec_agent.turns
         (id, conversation_id, client_turn_id, request_hash, latest_input_message_id, base_revision, status, deadline_at, trace_id, trace_root_observation_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', clock_timestamp() + make_interval(secs => $7), $8, $9)`,
      [
        turnId,
        input.conversationId,
        metadata.clientTurnId,
        requestHash,
        messageId,
        currentRevision,
        metadata.deadlineSeconds,
        metadata.traceId,
        input.telemetryRootObservationId ?? null,
      ],
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
    await appendConversationEvent(
      client,
      input.conversationId,
      turnId,
      "turn.accepted",
      { messageSeq, baseRevision: currentRevision },
    );
    const created = await client.query<Record<string, unknown>>(
      "SELECT * FROM interec_agent.turns WHERE id = $1",
      [turnId],
    );
    await client.query("COMMIT");
    if (supersededExisting) recordTerminalTurn("SUPERSEDED");
    return {
      ...mapTurn(created.rows[0]!),
      inputMessageIds: unconsumed.rows.map((message) => message.id),
      idempotentReplay: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function retryPostgresTurn(
  pool: pg.Pool,
  input: RetryConversationTurnInput,
): Promise<AcceptedConversationTurn> {
  const metadata = turnRequestMetadata(input);
  const requestHash = canonicalPayloadHash({ type: "RETRY", retryOfTurnId: input.turnId });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setOwnerContext(client, input.owner);
    const owner = await client.query<Record<string, unknown>>(
      `SELECT * FROM interec_agent.conversations
       WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 FOR UPDATE`,
      [input.conversationId, input.owner.tenantId, input.owner.ownerId],
    );
    const conversation = owner.rows[0];
    if (!conversation) {
      throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${input.conversationId}`);
    }
    if (conversation["status"] !== "OPEN") {
      throw new ConversationRepositoryError("CONVERSATION_NOT_OPEN", `Conversation is not open: ${input.conversationId}`);
    }
    if (conversation["contract_version"] !== QUOTE_LEAD_CONTRACT_VERSION) {
      throw new ConversationRepositoryError(
        "LEGACY_CONVERSATION_RETIRED",
        "The retired recommendation contract is read-only and cannot be retried",
      );
    }
    const existing = await client.query<Record<string, unknown>>(
      "SELECT * FROM interec_agent.turns WHERE conversation_id = $1 AND client_turn_id = $2",
      [input.conversationId, metadata.clientTurnId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0]["request_hash"] !== requestHash) {
        throw new ConversationRepositoryError(
          "IDEMPOTENCY_KEY_REUSED",
          `clientTurnId was reused with another retry target: ${metadata.clientTurnId}`,
        );
      }
      const ids = await inputMessageIds(client, String(existing.rows[0]["id"]));
      await client.query("COMMIT");
      return { ...mapTurn(existing.rows[0]), inputMessageIds: ids, idempotentReplay: true };
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== Number(conversation["current_revision"])) {
      throw new ConversationRepositoryError(
        "REVISION_CONFLICT",
        `Expected revision ${input.expectedRevision}, current revision is ${conversation["current_revision"]}`,
      );
    }
    if (conversation["active_turn_id"] !== null) {
      throw new ConversationRepositoryError("CONVERSATION_TURN_ACTIVE", "A retry cannot start while another Turn is active");
    }
    const source = await client.query<Record<string, unknown>>(
      `SELECT * FROM interec_agent.turns
       WHERE id = $1 AND conversation_id = $2 AND status IN ('FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTER')`,
      [input.turnId, input.conversationId],
    );
    if (!source.rows[0]) {
      throw new ConversationRepositoryError("TURN_NOT_RETRYABLE", `Turn is not retryable: ${input.turnId}`);
    }
    const unconsumed = await client.query<{ id: string }>(
      `SELECT id FROM interec_agent.messages
       WHERE conversation_id = $1 AND role = 'USER' AND consumed_by_turn_id IS NULL
       ORDER BY seq`,
      [input.conversationId],
    );
    if (unconsumed.rows.length === 0) {
      throw new ConversationRepositoryError("RETRY_INPUT_ALREADY_CONSUMED", "No unconsumed USER batch remains for retry");
    }
    const turnId = randomUUID();
    const latestInputMessageId = unconsumed.rows.at(-1)!.id;
    await client.query(
      `INSERT INTO interec_agent.turns
         (id, conversation_id, client_turn_id, request_hash, latest_input_message_id, base_revision, status, deadline_at, trace_id, trace_root_observation_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', clock_timestamp() + make_interval(secs => $7), $8, $9)`,
      [
        turnId,
        input.conversationId,
        metadata.clientTurnId,
        requestHash,
        latestInputMessageId,
        conversation["current_revision"],
        metadata.deadlineSeconds,
        metadata.traceId,
        input.telemetryRootObservationId ?? null,
      ],
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
    await appendConversationEvent(
      client,
      input.conversationId,
      turnId,
      "turn.retry_accepted",
      { retryOfTurnId: input.turnId, baseRevision: Number(conversation["current_revision"]) },
    );
    const created = await client.query<Record<string, unknown>>(
      "SELECT * FROM interec_agent.turns WHERE id = $1",
      [turnId],
    );
    await client.query("COMMIT");
    return {
      ...mapTurn(created.rows[0]!),
      inputMessageIds: unconsumed.rows.map((message) => message.id),
      idempotentReplay: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
