import { createHash, randomUUID } from "node:crypto";

import {
  emptyQuoteConversationState,
  QUOTE_LEAD_CONTRACT_VERSION,
  validateQuoteConversationState,
  type ConversationState,
} from "@interec/domain";
import pg from "pg";

import type {
  ConversationMessageRecord,
  ConversationRecord,
  ConversationTurnRecord,
  ConversationTurnStatus,
  OwnerClaims,
  ToolExecutionRecord,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";

export type Queryable = Pick<pg.PoolClient, "query">;

export const ACTIVE_TURN_STATUSES = ["ACCEPTED", "CLAIMED", "RUNNING", "COMMITTING"] as const;

/** Required only because the durable schema predates the quote-only cutover. */
export const EMPTY_COMPAT_DIALOGUE_STATE = {
  pendingClarification: null,
  clarificationHistory: [],
  pendingOps: [],
  focusOfferRef: null,
  comparisonOfferRefs: [],
  lastAssistantMessageId: null,
} as const;

export function requiredText(value: string, code: string): string {
  const result = value.trim();
  if (!result) throw new ConversationRepositoryError(code, `${code}: a non-empty value is required`);
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new ConversationRepositoryError("INVALID_CANONICAL_PAYLOAD", `Unsupported canonical payload value: ${typeof value}`);
  }
  return value;
}

export function canonicalPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : asIso(value);
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function mapConversation(row: Record<string, unknown>): ConversationRecord {
  if (row["contract_version"] !== QUOTE_LEAD_CONTRACT_VERSION) {
    throw new ConversationRepositoryError(
      "LEGACY_CONVERSATION_RETIRED",
      "This conversation belongs to the retired recommendation contract and is read-only",
    );
  }
  return {
    id: String(row["id"]),
    owner: { tenantId: String(row["tenant_id"]), ownerId: String(row["owner_id"]) },
    status: String(row["status"]) as ConversationRecord["status"],
    contractVersion: String(row["contract_version"]) as ConversationRecord["contractVersion"],
    currentRevision: Number(row["current_revision"]),
    messageCursor: Number(row["next_message_seq"]),
    eventCursor: Number(row["next_event_seq"]),
    activeTurnId: row["active_turn_id"] === null ? null : String(row["active_turn_id"]),
    createdAt: asIso(row["created_at"]),
    updatedAt: asIso(row["updated_at"]),
  };
}

export function mapTurn(row: Record<string, unknown>): ConversationTurnRecord {
  return {
    id: String(row["id"]),
    conversationId: String(row["conversation_id"]),
    clientTurnId: String(row["client_turn_id"]),
    baseRevision: Number(row["base_revision"]),
    status: String(row["status"]) as ConversationTurnStatus,
    attempt: Number(row["attempt"]),
    fenceToken: String(row["fence_token"]),
    workerId: row["worker_id"] === null ? null : String(row["worker_id"]),
    leaseExpiresAt: nullableIso(row["lease_expires_at"]),
    deadlineAt: asIso(row["deadline_at"]),
    errorCode: row["error_code"] === null ? null : String(row["error_code"]),
    createdAt: asIso(row["created_at"]),
    completedAt: nullableIso(row["completed_at"]),
  };
}

export function mapMessage(row: Record<string, unknown>): ConversationMessageRecord {
  const payload = row["payload_json"] as Record<string, unknown>;
  return {
    id: String(row["id"]),
    conversationId: String(row["conversation_id"]),
    seq: Number(row["seq"]),
    role: String(row["role"]) as ConversationMessageRecord["role"],
    payload: {
      ...payload,
      ...(row["envelope_json"] ? { envelope: row["envelope_json"] } : {}),
      ...(row["ledger_json"] ? { groundedClaims: row["ledger_json"] } : {}),
    },
    consumedByTurnId: row["consumed_by_turn_id"] === null ? null : String(row["consumed_by_turn_id"]),
    createdAt: asIso(row["created_at"]),
  };
}

export function mapToolExecution(row: Record<string, unknown>): ToolExecutionRecord {
  return {
    id: String(row["id"]),
    turnId: String(row["turn_id"]),
    attempt: Number(row["attempt"]),
    stepKey: String(row["step_key"]),
    requestHash: String(row["request_hash"]),
    status: String(row["status"]) as ToolExecutionRecord["status"],
    request: row["request_json"] as Record<string, unknown>,
    result: row["result_json"] === null ? null : row["result_json"] as Record<string, unknown>,
    errorCode: row["error_code"] === null ? null : String(row["error_code"]),
  };
}

export async function allocateMessageSeq(client: Queryable, conversationId: string): Promise<number> {
  const result = await client.query<{ seq: string }>(
    `UPDATE interec_agent.conversations
     SET next_message_seq = next_message_seq + 1, updated_at = clock_timestamp()
     WHERE id = $1 RETURNING next_message_seq AS seq`,
    [conversationId],
  );
  if (!result.rows[0]) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${conversationId}`);
  return Number(result.rows[0].seq);
}

export async function appendConversationEvent(
  client: Queryable,
  conversationId: string,
  turnId: string | null,
  eventType: string,
  publicPayload: Record<string, unknown>,
): Promise<number> {
  const sequence = await client.query<{ seq: string }>(
    `UPDATE interec_agent.conversations
     SET next_event_seq = next_event_seq + 1, updated_at = clock_timestamp()
     WHERE id = $1 RETURNING next_event_seq AS seq`,
    [conversationId],
  );
  if (!sequence.rows[0]) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${conversationId}`);
  const seq = Number(sequence.rows[0].seq);
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO interec_agent.turn_events (id, conversation_id, turn_id, seq, event_type, public_payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [eventId, conversationId, turnId, seq, eventType, JSON.stringify(publicPayload)],
  );
  await client.query(
    `INSERT INTO interec_agent.outbox (id, event_id, topic, payload)
     VALUES ($1, $2, 'conversation.events', $3::jsonb)`,
    [randomUUID(), eventId, JSON.stringify({ conversationId, turnId, seq, eventType, ...publicPayload })],
  );
  return seq;
}

export async function inputMessageIds(client: Queryable, turnId: string): Promise<string[]> {
  const result = await client.query<{ message_id: string }>(
    "SELECT message_id FROM interec_agent.turn_input_messages WHERE turn_id = $1 ORDER BY ordinal",
    [turnId],
  );
  return result.rows.map((row) => row.message_id);
}

export async function hydrateSnapshot(client: Queryable, conversationId: string, requestedRevision?: number): Promise<ConversationState | null> {
  const conversation = await client.query<Record<string, unknown>>(
    "SELECT current_revision, status, contract_version FROM interec_agent.conversations WHERE id = $1",
    [conversationId],
  );
  const current = conversation.rows[0];
  if (!current) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${conversationId}`);
  if (current["contract_version"] !== QUOTE_LEAD_CONTRACT_VERSION) {
    throw new ConversationRepositoryError(
      "LEGACY_CONVERSATION_RETIRED",
      "This conversation belongs to the retired recommendation contract and cannot be executed",
    );
  }
  const currentRevision = Number(current["current_revision"]);
  const revision = requestedRevision ?? currentRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > currentRevision) return null;
  if (revision === 0) {
    return {
      revision: 0,
      status: String(current["status"]) as ConversationState["status"],
      quote: emptyQuoteConversationState(),
    };
  }
  const result = await client.query<Record<string, unknown>>(
    `SELECT cr.revision, qsv.state_json AS quote_state_json
     FROM interec_agent.conversation_revisions cr
     JOIN interec_agent.quote_state_versions qsv ON qsv.id = cr.quote_state_version_id
     WHERE cr.conversation_id = $1 AND cr.revision = $2`,
    [conversationId, revision],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row["quote_state_json"] === null) {
    throw new ConversationRepositoryError("QUOTE_STATE_VERSION_MISSING", `Quote state missing at revision ${revision}`);
  }
  const quote = validateQuoteConversationState(row["quote_state_json"] as ConversationState["quote"]);
  return {
    revision,
    status: String(current["status"]) as ConversationState["status"],
    quote,
  };
}

export async function lockConversationForTurn(client: Queryable, turnId: string): Promise<Record<string, unknown> | null> {
  const located = await client.query<{ conversation_id: string }>("SELECT conversation_id FROM interec_agent.turns WHERE id = $1", [turnId]);
  if (!located.rows[0]) return null;
  const locked = await client.query<Record<string, unknown>>(
    "SELECT * FROM interec_agent.conversations WHERE id = $1 FOR UPDATE",
    [located.rows[0].conversation_id],
  );
  return locked.rows[0] ?? null;
}

export async function setOwnerContext(client: Queryable, owner: OwnerClaims): Promise<void> {
  await client.query(
    "SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)",
    [requiredText(owner.tenantId, "INVALID_TENANT_ID"), requiredText(owner.ownerId, "INVALID_OWNER_ID")],
  );
}

export async function withOwnerTransaction<T>(pool: pg.Pool, owner: OwnerClaims, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setOwnerContext(client, owner);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withOwnerSnapshotTransaction<T>(pool: pg.Pool, owner: OwnerClaims, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await setOwnerContext(client, owner);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
