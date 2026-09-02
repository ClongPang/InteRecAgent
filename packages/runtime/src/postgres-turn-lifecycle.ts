import { QUOTE_LEAD_CONTRACT_VERSION, type ConversationContractVersion } from "@retail-price/domain";
import type pg from "pg";

import type {
  ClaimedConversationTurn,
  ConversationTurnStatus,
  OwnerClaims,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  ACTIVE_TURN_STATUSES,
  appendConversationEvent,
  hydrateSnapshot,
  lockConversationForTurn,
  mapMessage,
  mapTurn,
  requiredText,
  setOwnerContext,
} from "./postgres-conversation-storage.js";
import { recordTerminalTurn } from "./turn-terminal-metrics.js";

export async function claimPostgresTurn(
  pool: pg.Pool,
  workerId: string,
  leaseSeconds: number,
  turnId?: string,
): Promise<ClaimedConversationTurn | null> {
  requiredText(workerId, "INVALID_WORKER_ID");
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
    throw new ConversationRepositoryError("INVALID_LEASE", "Lease must contain 1-300 seconds");
  }
  if (!turnId) await expireDuePostgresTurns(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await client.query<{ id: string }>(
      `SELECT c.id
       FROM retail_price_agent.conversations c
       WHERE c.status = 'OPEN'
         AND c.contract_version = $2
         AND ($1::uuid IS NULL OR c.active_turn_id = $1::uuid)
         AND EXISTS (
           SELECT 1 FROM retail_price_agent.turns t
           WHERE t.conversation_id = c.id
             AND t.id = c.active_turn_id
             AND t.attempt < 3
             AND t.deadline_at > clock_timestamp()
             AND (t.status = 'ACCEPTED' OR (t.status IN ('CLAIMED', 'RUNNING') AND t.lease_expires_at < clock_timestamp()))
         )
       ORDER BY c.created_at
       FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
      [turnId ?? null, QUOTE_LEAD_CONTRACT_VERSION],
    );
    if (!conversation.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const candidate = await client.query<Record<string, unknown>>(
      `SELECT * FROM retail_price_agent.turns
       WHERE conversation_id = $1 AND id = (SELECT active_turn_id FROM retail_price_agent.conversations WHERE id = $1)
       FOR UPDATE`,
      [conversation.rows[0].id],
    );
    const row = candidate.rows[0];
    if (!row) {
      throw new ConversationRepositoryError(
        "ACTIVE_TURN_MISSING",
        `Active turn is missing for conversation ${conversation.rows[0].id}`,
      );
    }
    const priorAttempt = Number(row["attempt"]);
    const claimed = await client.query<Record<string, unknown>>(
      `UPDATE retail_price_agent.turns
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
        `UPDATE retail_price_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp()
         WHERE turn_id = $1 AND attempt = $2 AND status IN ('CLAIMED', 'RUNNING')`,
        [row["id"], priorAttempt],
      );
    }
    await client.query(
      `INSERT INTO retail_price_agent.turn_attempts (turn_id, attempt, fence_token, base_revision, status)
       VALUES ($1, $2, $3::bigint, $4, 'CLAIMED')`,
      [turn["id"], turn["attempt"], turn["fence_token"], turn["base_revision"]],
    );
    await appendConversationEvent(
      client,
      String(turn["conversation_id"]),
      String(turn["id"]),
      "turn.claimed",
      { attempt: Number(turn["attempt"]) },
    );
    const messages = await client.query<Record<string, unknown>>(
      `SELECT m.* FROM retail_price_agent.turn_input_messages tim
       JOIN retail_price_agent.messages m ON m.id = tim.message_id
       WHERE tim.turn_id = $1 ORDER BY tim.ordinal`,
      [turn["id"]],
    );
    const owner = await client.query<{
      tenant_id: string;
      owner_id: string;
      contract_version: ConversationContractVersion;
    }>(
      "SELECT tenant_id, owner_id, contract_version FROM retail_price_agent.conversations WHERE id = $1",
      [turn["conversation_id"]],
    );
    const snapshot = await hydrateSnapshot(client, String(turn["conversation_id"]));
    if (!snapshot) {
      throw new ConversationRepositoryError(
        "CONVERSATION_REVISION_MISSING",
        `Conversation revision is missing: ${turn["conversation_id"]}`,
      );
    }
    await client.query("COMMIT");
    return {
      ...mapTurn(turn),
      owner: { tenantId: owner.rows[0]!.tenant_id, ownerId: owner.rows[0]!.owner_id },
      contractVersion: owner.rows[0]!.contract_version,
      inputMessages: messages.rows.map(mapMessage),
      snapshot,
      ...(turn["trace_id"] && turn["trace_id_source"] === "OBSERVED_ENQUEUE_ROOT"
        ? { telemetryEnqueueTraceId: String(turn["trace_id"]) }
        : {}),
      ...(turn["trace_root_observation_id"]
        ? { telemetryEnqueueObservationId: String(turn["trace_root_observation_id"]) }
        : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markPostgresTurnRunning(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await lockConversationForTurn(client, turnId);
    if (!conversation) {
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query(
      `UPDATE retail_price_agent.turns
       SET status = 'RUNNING', updated_at = clock_timestamp()
       WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status = 'CLAIMED'
         AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()`,
      [turnId, attempt, fenceToken],
    );
    if (result.rowCount === 1) {
      await client.query(
        "UPDATE retail_price_agent.turn_attempts SET status = 'RUNNING', updated_at = clock_timestamp() WHERE turn_id = $1 AND attempt = $2 AND fence_token = $3::bigint",
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

export async function heartbeatPostgresTurn(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  leaseSeconds: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) return false;
  const result = await pool.query(
    `UPDATE retail_price_agent.turns
     SET lease_expires_at = clock_timestamp() + make_interval(secs => $4), updated_at = clock_timestamp()
     WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status = 'RUNNING'
       AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()`,
    [turnId, attempt, fenceToken, leaseSeconds],
  );
  return result.rowCount === 1;
}

export async function failPostgresTurn(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  errorCode: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await lockConversationForTurn(client, turnId);
    if (!conversation) {
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query<{ status: ConversationTurnStatus }>(
      `UPDATE retail_price_agent.turns
       SET status = CASE WHEN deadline_at <= clock_timestamp() THEN 'TIMED_OUT' ELSE 'FAILED' END,
           error_code = $4, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1 AND attempt = $2 AND fence_token = $3::bigint AND status IN ('CLAIMED', 'RUNNING')
         AND lease_expires_at > clock_timestamp()
       RETURNING status`,
      [turnId, attempt, fenceToken, requiredText(errorCode, "INVALID_ERROR_CODE")],
    );
    const terminalStatus = result.rows[0]?.status;
    if (terminalStatus) {
      await client.query(
        "UPDATE retail_price_agent.turn_attempts SET status = 'FAILED', updated_at = clock_timestamp() WHERE turn_id = $1 AND attempt = $2",
        [turnId, attempt],
      );
      await client.query(
        "UPDATE retail_price_agent.conversations SET active_turn_id = NULL WHERE id = $1 AND active_turn_id = $2",
        [conversation["id"], turnId],
      );
      await appendConversationEvent(
        client,
        String(conversation["id"]),
        turnId,
        terminalStatus === "TIMED_OUT" ? "turn.timed_out" : "turn.failed",
        { errorCode },
      );
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

export async function cancelPostgresTurn(
  pool: pg.Pool,
  turnId: string,
  owner: OwnerClaims,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setOwnerContext(client, owner);
    const conversation = await client.query<Record<string, unknown>>(
      `SELECT c.* FROM retail_price_agent.conversations c
       JOIN retail_price_agent.turns t ON t.conversation_id = c.id
       WHERE t.id = $1 AND c.tenant_id = $2 AND c.owner_id = $3 FOR UPDATE OF c`,
      [turnId, owner.tenantId, owner.ownerId],
    );
    if (!conversation.rows[0]) {
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query(
      `UPDATE retail_price_agent.turns
       SET status = 'CANCELLED', fence_token = fence_token + 1, lease_expires_at = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1 AND status = ANY($2::text[])`,
      [turnId, [...ACTIVE_TURN_STATUSES]],
    );
    if (result.rowCount === 1) {
      await client.query(
        "UPDATE retail_price_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp() WHERE turn_id = $1 AND status IN ('CLAIMED', 'RUNNING')",
        [turnId],
      );
      await client.query(
        "UPDATE retail_price_agent.conversations SET active_turn_id = NULL WHERE id = $1 AND active_turn_id = $2",
        [conversation.rows[0]["id"], turnId],
      );
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

export async function expireDuePostgresTurns(pool: pg.Pool): Promise<number> {
  let expired = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query<{ id: string; active_turn_id: string }>(
        `SELECT c.id, c.active_turn_id
         FROM retail_price_agent.conversations c
         JOIN retail_price_agent.turns t ON t.id = c.active_turn_id
         WHERE c.contract_version = $2 AND t.status = ANY($1::text[])
           AND (t.deadline_at <= clock_timestamp() OR (t.attempt >= 3 AND t.lease_expires_at < clock_timestamp()))
         ORDER BY t.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
        [[...ACTIVE_TURN_STATUSES], QUOTE_LEAD_CONTRACT_VERSION],
      );
      if (!conversation.rows[0]) {
        await client.query("COMMIT");
        return expired;
      }
      const turn = await client.query<Record<string, unknown>>(
        "SELECT *, deadline_at <= clock_timestamp() AS deadline_expired FROM retail_price_agent.turns WHERE id = $1 FOR UPDATE",
        [conversation.rows[0].active_turn_id],
      );
      const row = turn.rows[0]!;
      const status = row["deadline_expired"] === true ? "TIMED_OUT" : "DEAD_LETTER";
      const errorCode = status === "TIMED_OUT" ? "TURN_DEADLINE_EXCEEDED" : "MAX_ATTEMPTS_EXHAUSTED";
      await client.query(
        `UPDATE retail_price_agent.turns SET status = $2, error_code = $3, fence_token = fence_token + 1,
           lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
        [row["id"], status, errorCode],
      );
      await client.query(
        "UPDATE retail_price_agent.turn_attempts SET status = 'ABANDONED', updated_at = clock_timestamp() WHERE turn_id = $1 AND status IN ('CLAIMED', 'RUNNING')",
        [row["id"]],
      );
      await client.query(
        "UPDATE retail_price_agent.conversations SET active_turn_id = NULL WHERE id = $1",
        [conversation.rows[0].id],
      );
      await appendConversationEvent(
        client,
        conversation.rows[0].id,
        String(row["id"]),
        status === "TIMED_OUT" ? "turn.timed_out" : "turn.dead_letter",
        { errorCode },
      );
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
