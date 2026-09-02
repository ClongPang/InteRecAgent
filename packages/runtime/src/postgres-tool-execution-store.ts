import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { ToolReservation } from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  canonicalPayloadHash,
  mapToolExecution,
  requiredText,
} from "./postgres-conversation-storage.js";

export async function reservePostgresToolExecution(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  stepKey: string,
  request: Record<string, unknown>,
): Promise<ToolReservation | null> {
  const normalizedStepKey = requiredText(stepKey, "INVALID_STEP_KEY");
  const requestHash = canonicalPayloadHash(request);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const turn = await client.query<Record<string, unknown>>(
      `SELECT * FROM retail_price_agent.turns
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
      "SELECT * FROM retail_price_agent.tool_executions WHERE turn_id = $1 AND step_key = $2 FOR UPDATE",
      [turnId, normalizedStepKey],
    );
    const row = existing.rows[0];
    if (row) {
      if (row["request_hash"] !== requestHash) {
        throw new ConversationRepositoryError(
          "TOOL_STEP_REQUEST_CONFLICT",
          `Stable tool step was reused with a different request: ${normalizedStepKey}`,
        );
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
        `UPDATE retail_price_agent.tool_executions
         SET attempt = $3, status = 'RUNNING', result_json = NULL, error_code = NULL,
             started_at = clock_timestamp(), completed_at = NULL
         WHERE turn_id = $1 AND step_key = $2 RETURNING *`,
        [turnId, normalizedStepKey, attempt],
      );
      await client.query("COMMIT");
      return { action: "CALL", execution: mapToolExecution(recovered.rows[0]!) };
    }
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO retail_price_agent.tool_executions
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

export async function completePostgresToolExecution(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  stepKey: string,
  requestHash: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const completed = await pool.query(
    `UPDATE retail_price_agent.tool_executions te
     SET status = 'SUCCEEDED', result_json = $6::jsonb, error_code = NULL, completed_at = clock_timestamp()
     FROM retail_price_agent.turns t
     WHERE te.turn_id = t.id AND te.turn_id = $1 AND te.attempt = $2 AND te.step_key = $4 AND te.request_hash = $5
       AND te.status = 'RUNNING' AND t.attempt = $2 AND t.fence_token = $3::bigint AND t.status = 'RUNNING'
       AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()`,
    [turnId, attempt, fenceToken, requiredText(stepKey, "INVALID_STEP_KEY"), requestHash, JSON.stringify(result)],
  );
  return completed.rowCount === 1;
}

export async function failPostgresToolExecution(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  stepKey: string,
  requestHash: string,
  errorCode: string,
): Promise<boolean> {
  const failed = await pool.query(
    `UPDATE retail_price_agent.tool_executions te
     SET status = 'FAILED', error_code = $6, completed_at = clock_timestamp()
     FROM retail_price_agent.turns t
     WHERE te.turn_id = t.id AND te.turn_id = $1 AND te.attempt = $2 AND te.step_key = $4 AND te.request_hash = $5
       AND te.status = 'RUNNING' AND t.attempt = $2 AND t.fence_token = $3::bigint AND t.status = 'RUNNING'
       AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()`,
    [
      turnId,
      attempt,
      fenceToken,
      requiredText(stepKey, "INVALID_STEP_KEY"),
      requestHash,
      requiredText(errorCode, "INVALID_ERROR_CODE"),
    ],
  );
  return failed.rowCount === 1;
}
