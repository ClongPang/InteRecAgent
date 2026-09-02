import { randomUUID } from "node:crypto";

import {
  QUOTE_LEAD_CONTRACT_VERSION,
  projectPublishedQuoteLeadSet,
  validateQuoteAssistantPublication,
  validateQuoteConversationState,
  type QuoteLeadSet,
} from "@retail-price/domain";
import type pg from "pg";

import type { CommitQuoteConversationTurnInput, FinalCommitResult } from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  allocateMessageSeq,
  appendConversationEvent,
  canonicalPayloadHash,
  EMPTY_COMPAT_DIALOGUE_STATE,
  lockConversationForTurn,
} from "./postgres-conversation-storage.js";
import { recordTerminalTurn } from "./turn-terminal-metrics.js";

interface ResolvedQuoteLeadSet {
  id: string;
  status: "DRAFT" | "PUBLISHED";
}

async function resolveQuoteLeadSet(
  client: pg.PoolClient,
  input: CommitQuoteConversationTurnInput,
  conversationId: string,
  currentRevision: number,
): Promise<ResolvedQuoteLeadSet | null> {
  if (!input.state.leadSet) return null;
  const result = await client.query<Record<string, unknown>>(
    `SELECT id, turn_id, attempt, status, published_revision, lead_set_json
     FROM retail_price_agent.quote_lead_sets
     WHERE conversation_id = $1 AND quote_lead_set_ref = $2
     ORDER BY observed_at DESC LIMIT 1 FOR UPDATE`,
    [conversationId, input.state.leadSet.quoteLeadSetRef],
  );
  const row = result.rows[0];
  if (!row) throw new ConversationRepositoryError("QUOTE_LEAD_SET_NOT_PERSISTED", input.state.leadSet.quoteLeadSetRef);
  const projected = projectPublishedQuoteLeadSet(row["lead_set_json"] as QuoteLeadSet);
  if (canonicalPayloadHash(projected) !== canonicalPayloadHash(input.state.leadSet)) {
    throw new ConversationRepositoryError("QUOTE_STATE_SOURCE_MISMATCH", input.state.leadSet.quoteLeadSetRef);
  }
  const status = String(row["status"]) as ResolvedQuoteLeadSet["status"];
  if (status === "DRAFT") {
    if (String(row["turn_id"]) !== input.turnId || Number(row["attempt"]) !== input.attempt) {
      throw new ConversationRepositoryError("QUOTE_DRAFT_OUTSIDE_ATTEMPT", input.state.leadSet.quoteLeadSetRef);
    }
  } else if (row["published_revision"] === null || Number(row["published_revision"]) > currentRevision) {
    throw new ConversationRepositoryError("QUOTE_LEAD_SET_OUTSIDE_PUBLISHED_HISTORY", input.state.leadSet.quoteLeadSetRef);
  }
  return { id: String(row["id"]), status };
}

function assertStagedQuoteDraft(draft: Record<string, unknown>, input: CommitQuoteConversationTurnInput): void {
  for (const [field, value] of [
    ["quotePlan", input.plan],
    ["quoteState", input.state],
    ["quoteReply", input.reply],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(draft, field)
      || canonicalPayloadHash(draft[field]) !== canonicalPayloadHash(value)) {
      throw new ConversationRepositoryError("QUOTE_ATTEMPT_DRAFT_MISMATCH", field);
    }
  }
}

export async function commitPostgresQuoteConversationTurn(
  pool: pg.Pool,
  input: CommitQuoteConversationTurnInput,
): Promise<FinalCommitResult | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await lockConversationForTurn(client, input.turnId);
    if (!conversation) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      "SELECT set_config('retail_price.tenant_id', $1, true), set_config('retail_price.owner_id', $2, true)",
      [String(conversation["tenant_id"]), String(conversation["owner_id"])],
    );
    if (conversation["contract_version"] !== QUOTE_LEAD_CONTRACT_VERSION) {
      throw new ConversationRepositoryError("QUOTE_CONVERSATION_CONTRACT_REQUIRED", String(conversation["contract_version"]));
    }
    const turnResult = await client.query<Record<string, unknown>>("SELECT * FROM retail_price_agent.turns WHERE id = $1 FOR UPDATE", [input.turnId]);
    const turn = turnResult.rows[0];
    if (!turn) {
      await client.query("ROLLBACK");
      return null;
    }
    if (turn["status"] === "COMPLETED") {
      if (Number(turn["attempt"]) !== input.attempt || String(turn["fence_token"]) !== input.fenceToken) {
        await client.query("ROLLBACK");
        return null;
      }
      const published = await client.query<Record<string, unknown>>(
        `SELECT ar.id AS response_id, m.id AS message_id, cr.revision
         FROM retail_price_agent.assistant_responses ar
         JOIN retail_price_agent.messages m ON m.assistant_response_id = ar.id
         JOIN retail_price_agent.conversation_revisions cr ON cr.committed_by_turn_id = ar.turn_id
         WHERE ar.turn_id = $1`,
        [input.turnId],
      );
      await client.query("COMMIT");
      const row = published.rows[0];
      return row ? {
        committed: false,
        conversationRevision: Number(row["revision"]),
        assistantMessageId: String(row["message_id"]),
        responseId: String(row["response_id"]),
      } : null;
    }

    const attemptResult = await client.query<Record<string, unknown>>(
      "SELECT * FROM retail_price_agent.turn_attempts WHERE turn_id = $1 AND attempt = $2 FOR UPDATE",
      [input.turnId, input.attempt],
    );
    const attempt = attemptResult.rows[0];
    const authorized = await client.query<Record<string, unknown>>(
      `UPDATE retail_price_agent.turns t
       SET status = 'COMMITTING', updated_at = clock_timestamp()
       FROM retail_price_agent.turn_attempts ta
       WHERE t.id = $1 AND t.attempt = $2 AND t.fence_token = $3::bigint AND t.status = 'RUNNING'
         AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()
         AND t.base_revision = $4
         AND ta.turn_id = t.id AND ta.attempt = t.attempt AND ta.fence_token = t.fence_token AND ta.status = 'RUNNING'
       RETURNING t.*`,
      [input.turnId, input.attempt, input.fenceToken, conversation["current_revision"]],
    );
    if (!authorized.rows[0] || !attempt) {
      await client.query("ROLLBACK");
      return null;
    }
    assertStagedQuoteDraft(attempt["draft_json"] as Record<string, unknown>, input);

    const state = validateQuoteConversationState(input.state);
    const reply = validateQuoteAssistantPublication(input.reply, input.plan, state);
    const nextRevision = Number(conversation["current_revision"]) + 1;
    if (state.version !== nextRevision) throw new ConversationRepositoryError("INVALID_QUOTE_PUBLICATION_REVISION", `${state.version}:${nextRevision}`);
    if (input.conversationStatus !== conversation["status"]) throw new ConversationRepositoryError("CONVERSATION_STATUS_MUTATION_NOT_ALLOWED", input.conversationStatus);
    if (input.plan.ops.length === 0) {
      if (reply.outcome !== "DEGRADED" || reply.addressedOpIds.length !== 0) {
        throw new ConversationRepositoryError("EMPTY_QUOTE_PLAN_REQUIRES_DEGRADATION", reply.outcome);
      }
    } else {
      const approved = await client.query<{ approved_plan_json: unknown }>(
        `SELECT approved_plan_json FROM retail_price_agent.turn_plan_reviews
         WHERE turn_id = $1 AND attempt = $2 AND decision = 'APPROVED'
         ORDER BY proposal_number DESC LIMIT 1`,
        [input.turnId, input.attempt],
      );
      if (!approved.rows[0]
        || canonicalPayloadHash(approved.rows[0].approved_plan_json) !== canonicalPayloadHash(input.plan)) {
        throw new ConversationRepositoryError("QUOTE_PLAN_NOT_APPROVED", input.turnId);
      }
    }

    const leadSet = await resolveQuoteLeadSet(client, input, String(turn["conversation_id"]), Number(conversation["current_revision"]));
    const quoteStateVersionId = randomUUID();
    await client.query(
      `INSERT INTO retail_price_agent.quote_state_versions
         (id, conversation_id, revision, state_json, quote_lead_set_id, committed_by_turn_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [quoteStateVersionId, turn["conversation_id"], nextRevision, JSON.stringify(state), leadSet?.id ?? null, input.turnId],
    );
    const dialogueVersionId = randomUUID();
    await client.query(
      `INSERT INTO retail_price_agent.dialogue_state_versions
         (id, conversation_id, revision, state_json, committed_by_turn_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dialogueVersionId, turn["conversation_id"], nextRevision, JSON.stringify(EMPTY_COMPAT_DIALOGUE_STATE), input.turnId],
    );
    await client.query(
      `INSERT INTO retail_price_agent.conversation_revisions
         (id, conversation_id, revision, parent_revision, base_revision, goal_version_id,
          dialogue_state_version_id, working_set_id, quote_state_version_id, committed_by_turn_id)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, $7, $8)`,
      [randomUUID(), turn["conversation_id"], nextRevision, conversation["current_revision"], turn["base_revision"], dialogueVersionId, quoteStateVersionId, input.turnId],
    );
    if (leadSet?.status === "DRAFT") {
      const promoted = await client.query(
        `UPDATE retail_price_agent.quote_lead_sets
         SET status = 'PUBLISHED', published_revision = $2
         WHERE id = $1 AND status = 'DRAFT' AND published_revision IS NULL`,
        [leadSet.id, nextRevision],
      );
      if (promoted.rowCount !== 1) throw new ConversationRepositoryError("QUOTE_LEAD_SET_PROMOTION_FAILED", leadSet.id);
    }

    const responseId = randomUUID();
    const assistantMessageId = randomUUID();
    await client.query(
      `INSERT INTO retail_price_agent.assistant_responses (id, conversation_id, turn_id, outcome, rendered_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [responseId, turn["conversation_id"], input.turnId, reply.outcome, reply.text],
    );
    await client.query(
      "INSERT INTO retail_price_agent.assistant_envelopes (response_id, envelope_json) VALUES ($1, $2::jsonb)",
      [responseId, JSON.stringify(reply)],
    );
    await client.query(
      "INSERT INTO retail_price_agent.claim_ledgers (response_id, ledger_json) VALUES ($1, $2::jsonb)",
      [responseId, JSON.stringify({ claims: [] })],
    );
    const assistantSeq = await allocateMessageSeq(client, String(turn["conversation_id"]));
    await client.query(
      `INSERT INTO retail_price_agent.messages
         (id, conversation_id, seq, role, payload_json, assistant_response_id)
       VALUES ($1, $2, $3, 'ASSISTANT', $4::jsonb, $5)`,
      [assistantMessageId, turn["conversation_id"], assistantSeq, JSON.stringify({ responseId, outcome: reply.outcome, text: reply.text }), responseId],
    );
    await client.query(
      `UPDATE retail_price_agent.messages m SET consumed_by_turn_id = $1
       FROM retail_price_agent.turn_input_messages tim
       WHERE tim.turn_id = $1 AND tim.message_id = m.id AND m.consumed_by_turn_id IS NULL`,
      [input.turnId],
    );
    await client.query(
      `UPDATE retail_price_agent.turns
       SET status = 'COMPLETED', lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1`,
      [input.turnId],
    );
    await client.query(
      "UPDATE retail_price_agent.turn_attempts SET status = 'COMMITTED', updated_at = clock_timestamp() WHERE turn_id = $1 AND attempt = $2",
      [input.turnId, input.attempt],
    );
    await client.query(
      `UPDATE retail_price_agent.conversations
       SET current_revision = $2, status = $3, active_turn_id = NULL, updated_at = clock_timestamp()
       WHERE id = $1`,
      [turn["conversation_id"], nextRevision, input.conversationStatus],
    );
    await appendConversationEvent(client, String(turn["conversation_id"]), input.turnId, "assistant.message.committed", {
      revision: nextRevision,
      messageSeq: assistantSeq,
      outcome: reply.outcome,
      contractVersion: QUOTE_LEAD_CONTRACT_VERSION,
    });
    await client.query("COMMIT");
    recordTerminalTurn("COMPLETED", input.plan.ops.some((operation) => operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES") ? "quote_lookup" : "quote_followup");
    return { committed: true, conversationRevision: nextRevision, assistantMessageId, responseId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
