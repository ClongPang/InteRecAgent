import { randomUUID } from "node:crypto";

import { QUOTE_LEAD_CONTRACT_VERSION, type ConversationState } from "@interec/domain";
import type pg from "pg";

import type {
  ConversationEventRecord,
  ConversationMessageRecord,
  ConversationProjectionRecord,
  ConversationRecord,
  ConversationTurnRecord,
  OwnerClaims,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  asIso,
  hydrateSnapshot,
  mapConversation,
  mapMessage,
  mapTurn,
  requiredText,
  withOwnerSnapshotTransaction,
  withOwnerTransaction,
} from "./postgres-conversation-storage.js";

export async function createPostgresConversation(
  pool: pg.Pool,
  owner: OwnerClaims,
): Promise<ConversationRecord> {
  const tenantId = requiredText(owner.tenantId, "INVALID_TENANT_ID");
  const ownerId = requiredText(owner.ownerId, "INVALID_OWNER_ID");
  return withOwnerTransaction(pool, owner, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `INSERT INTO interec_agent.conversations (id, tenant_id, owner_id, status, contract_version)
       VALUES ($1, $2, $3, 'OPEN', $4) RETURNING *`,
      [randomUUID(), tenantId, ownerId, QUOTE_LEAD_CONTRACT_VERSION],
    );
    return mapConversation(result.rows[0]!);
  });
}

export async function getPostgresConversation(
  pool: pg.Pool,
  id: string,
  owner: OwnerClaims,
): Promise<ConversationRecord | null> {
  return withOwnerTransaction(pool, owner, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM interec_agent.conversations
       WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
      [id, owner.tenantId, owner.ownerId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  });
}

export async function getPostgresConversationProjection(
  pool: pg.Pool,
  conversationId: string,
  owner: OwnerClaims,
): Promise<ConversationProjectionRecord | null> {
  return withOwnerSnapshotTransaction(pool, owner, async (client) => {
    const conversationResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM interec_agent.conversations
       WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
      [conversationId, owner.tenantId, owner.ownerId],
    );
    const row = conversationResult.rows[0];
    if (!row) return null;
    const conversation = mapConversation(row);
    const state = await hydrateSnapshot(client, conversationId);
    if (!state) {
      throw new ConversationRepositoryError(
        "CONVERSATION_SNAPSHOT_MISSING",
        `Conversation snapshot missing: ${conversationId}`,
      );
    }
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
      ? await client.query<Record<string, unknown>>(
          "SELECT * FROM interec_agent.turns WHERE id = $1",
          [conversation.activeTurnId],
        )
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

export async function getPostgresSnapshot(
  pool: pg.Pool,
  conversationId: string,
  owner: OwnerClaims,
): Promise<ConversationState | null> {
  return withOwnerTransaction(pool, owner, async (client) => {
    const exists = await client.query(
      "SELECT 1 FROM interec_agent.conversations WHERE id = $1 AND tenant_id = $2 AND owner_id = $3",
      [conversationId, owner.tenantId, owner.ownerId],
    );
    return exists.rowCount === 1 ? hydrateSnapshot(client, conversationId) : null;
  });
}

export async function getPostgresRevision(
  pool: pg.Pool,
  conversationId: string,
  owner: OwnerClaims,
  revision: number,
): Promise<ConversationState | null> {
  return withOwnerTransaction(pool, owner, async (client) => {
    const exists = await client.query(
      "SELECT 1 FROM interec_agent.conversations WHERE id = $1 AND tenant_id = $2 AND owner_id = $3",
      [conversationId, owner.tenantId, owner.ownerId],
    );
    return exists.rowCount === 1 ? hydrateSnapshot(client, conversationId, revision) : null;
  });
}

export async function getPostgresTurn(
  pool: pg.Pool,
  turnId: string,
  owner: OwnerClaims,
): Promise<ConversationTurnRecord | null> {
  return withOwnerTransaction(pool, owner, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT t.* FROM interec_agent.turns t
       JOIN interec_agent.conversations c ON c.id = t.conversation_id
       WHERE t.id = $1 AND c.tenant_id = $2 AND c.owner_id = $3`,
      [turnId, owner.tenantId, owner.ownerId],
    );
    return result.rows[0] ? mapTurn(result.rows[0]) : null;
  });
}

export async function getLatestPostgresTurn(
  pool: pg.Pool,
  conversationId: string,
  owner: OwnerClaims,
): Promise<ConversationTurnRecord | null> {
  return withOwnerTransaction(pool, owner, async (client) => {
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

export async function listPostgresMessages(
  pool: pg.Pool,
  conversationId: string,
  owner: OwnerClaims,
  afterSeq: number,
): Promise<ConversationMessageRecord[]> {
  return withOwnerTransaction(pool, owner, async (client) => {
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

export async function listPostgresEvents(
  pool: pg.Pool,
  conversationId: string,
  owner: OwnerClaims,
  afterSeq: number,
): Promise<ConversationEventRecord[]> {
  return withOwnerTransaction(pool, owner, async (client) => {
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
