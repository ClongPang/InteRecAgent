import { createHash, randomUUID } from "node:crypto";

import {
  DomainError,
  candidateFeedbackForTurn,
  emptyDialogueState,
  normalizeDialogueState,
  renderAssistantEnvelope,
  routeForTurnPlan,
  validateAssistantEnvelope,
  validateNoPlanDegradedPublication,
  validateTurnPlan,
  validateWorkingSet,
  validateGroundedClaimSet,
  validateClarificationAnswer,
  type ConversationState,
  type GoalRevision,
  type WorkingSet,
  type GroundedClaimSet,
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
  ToolExecutionRecord,
  ToolReservation,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import { runtimeMetrics, telemetryTraceIdForTurn } from "./telemetry.js";

function validatePersistedPlan(plan: CommitConversationTurnInput["plan"], envelope?: AttemptDraft["envelope"]) {
  if (plan.ops.length > 0) return validateTurnPlan(plan);
  if (!envelope || envelope.outcome !== "DEGRADED" || envelope.addressedOpIds.length !== 0) {
    throw new ConversationRepositoryError(
      "EMPTY_PLAN_REQUIRES_SYSTEM_DEGRADATION",
      "Only an unaddressed system-owned DEGRADED publication may persist without an approved plan",
    );
  }
  return validateNoPlanDegradedPublication(plan);
}

const { Pool } = pg;
type Queryable = Pick<pg.PoolClient, "query">;
const ACTIVE_STATUSES = ["ACCEPTED", "CLAIMED", "RUNNING", "COMMITTING"] as const;

function recordTerminalTurn(status: ConversationTurnStatus, route = "unknown"): void {
  try {
    runtimeMetrics.terminalTurns.add(1, { status, route, committed: status === "COMPLETED" });
  } catch {
    // Observability cannot change an already committed authoritative transition.
  }
}

function requiredText(value: string, code: string): string {
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

interface ResolvedClaimSources {
  claimId: string;
  sourceFacts: Array<{ sourceFactId: string; fxSnapshotId: string | null }>;
}

async function validatePublishedClaimSources(
  client: pg.PoolClient,
  input: {
    conversationId: string;
    turnId: string;
    attempt: number;
    currentRevision: number;
    ledger: GroundedClaimSet;
  },
): Promise<ResolvedClaimSources[]> {
  const resolved: ResolvedClaimSources[] = [];
  for (const claim of input.ledger.claims) {
    const candidates = await client.query<Record<string, unknown>>(
      `SELECT ac.id, ac.turn_id, ac.attempt, ac.kind, ac.canonical_value, ac.rendered_text, ac.offer_ref
       FROM interec_agent.attempt_claims ac
       WHERE ac.conversation_id = $1 AND ac.claim_ref = $2
       ORDER BY (ac.turn_id = $3 AND ac.attempt = $4) DESC,
                COALESCE((
                  SELECT bool_and(sf.promoted_revision IS NOT NULL AND sf.promoted_revision <= $5)
                  FROM interec_agent.attempt_claim_evidence ace
                  JOIN interec_agent.source_facts sf ON sf.id = ace.source_fact_id
                  WHERE ace.attempt_claim_id = ac.id
                ), false) DESC,
                ac.id`,
      [input.conversationId, claim.claimId, input.turnId, input.attempt, input.currentRevision],
    );
    const claimRow = candidates.rows.find((row) =>
      String(row["kind"]) === claim.kind
      && canonicalPayloadHash(row["canonical_value"]) === canonicalPayloadHash(claim.canonicalValue)
      && String(row["rendered_text"]) === claim.renderedText
      && canonicalPayloadHash(row["offer_ref"] ? [String(row["offer_ref"])] : []) === canonicalPayloadHash(claim.offerRefs),
    );
    if (!claimRow) {
      throw new ConversationRepositoryError("CLAIM_SOURCE_NOT_PERSISTED", `No persisted source record matches claim ${claim.claimId}`);
    }
    const evidenceRows = await client.query<Record<string, unknown>>(
      `SELECT sf.id AS source_fact_id, sf.turn_id, sf.attempt, sf.source_fact_ref, sf.json_path,
              sf.canonical_value, sf.provider_schema_version, sf.policy_version, sf.observed_at,
              sf.derivation, sf.promoted_revision, pa.artifact_ref, ace.fx_snapshot_id,
              fx.turn_id AS fx_turn_id, fx.attempt AS fx_attempt, fx.promoted_revision AS fx_promoted_revision
       FROM interec_agent.attempt_claim_evidence ace
       JOIN interec_agent.source_facts sf ON sf.id = ace.source_fact_id
       JOIN interec_agent.provider_artifacts pa ON pa.id = sf.artifact_id
       LEFT JOIN interec_agent.fx_snapshots fx ON fx.id = ace.fx_snapshot_id
       WHERE ace.attempt_claim_id = $1`,
      [claimRow["id"]],
    );
    if (evidenceRows.rowCount !== claim.evidenceRefs.length) {
      throw new ConversationRepositoryError("CLAIM_EVIDENCE_COUNT_MISMATCH", `Persisted evidence count differs for claim ${claim.claimId}`);
    }
    const sourceFacts: ResolvedClaimSources["sourceFacts"] = [];
    for (const evidence of claim.evidenceRefs) {
      const row = evidenceRows.rows.find((candidate) =>
        String(candidate["source_fact_ref"]) === evidence.sourceFactRef
        && String(candidate["artifact_ref"]) === evidence.artifactRef
        && String(candidate["json_path"]) === evidence.jsonPath,
      );
      if (!row) throw new ConversationRepositoryError("CLAIM_EVIDENCE_NOT_PERSISTED", `Evidence is not persisted for claim ${claim.claimId}`);
      const currentAttempt = String(row["turn_id"]) === input.turnId && Number(row["attempt"]) === input.attempt;
      const previouslyPublished = row["promoted_revision"] !== null && Number(row["promoted_revision"]) <= input.currentRevision;
      if (!currentAttempt && !previouslyPublished) {
        throw new ConversationRepositoryError("CLAIM_EVIDENCE_OUTSIDE_AUTHORITY", `Evidence is not current or previously promoted: ${evidence.sourceFactRef}`);
      }
      const mismatchedFields = [
        ...(canonicalPayloadHash(row["canonical_value"]) !== canonicalPayloadHash(evidence.canonicalValue) ? ["canonical_value"] : []),
        ...(String(row["provider_schema_version"]) !== evidence.providerSchemaVersion ? ["provider_schema_version"] : []),
        ...(String(row["policy_version"]) !== evidence.policyVersion ? ["policy_version"] : []),
        ...(String(row["derivation"]) !== evidence.derivation ? ["derivation"] : []),
        ...(asIso(row["observed_at"]) !== asIso(evidence.observedAt) ? ["observed_at"] : []),
      ];
      if (mismatchedFields.length > 0) {
        const timeDetails = mismatchedFields.includes("observed_at")
          ? ` persisted=${asIso(row["observed_at"])} referenced=${asIso(evidence.observedAt)}`
          : "";
        throw new ConversationRepositoryError("CLAIM_EVIDENCE_VALUE_MISMATCH", `Evidence fields differ from immutable source fact ${evidence.sourceFactRef}: ${mismatchedFields.join(",")}${timeDetails}`);
      }
      const persistedFxId = nullableString(row["fx_snapshot_id"]);
      if (persistedFxId !== (evidence.fxSnapshotId ?? null)) {
        throw new ConversationRepositoryError("CLAIM_FX_REFERENCE_MISMATCH", `FX reference differs for claim ${claim.claimId}`);
      }
      if (persistedFxId) {
        const currentFx = String(row["fx_turn_id"]) === input.turnId && Number(row["fx_attempt"]) === input.attempt;
        const publishedFx = row["fx_promoted_revision"] !== null && Number(row["fx_promoted_revision"]) <= input.currentRevision;
        if (!currentFx && !publishedFx) throw new ConversationRepositoryError("CLAIM_FX_OUTSIDE_AUTHORITY", `FX snapshot is not current or previously promoted: ${persistedFxId}`);
      }
      sourceFacts.push({ sourceFactId: String(row["source_fact_id"]), fxSnapshotId: persistedFxId });
    }
    resolved.push({ claimId: claim.claimId, sourceFacts });
  }
  return resolved;
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : asIso(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    id: String(row["id"]),
    owner: { tenantId: String(row["tenant_id"]), ownerId: String(row["owner_id"]) },
    status: String(row["status"]) as ConversationRecord["status"],
    currentRevision: Number(row["current_revision"]),
    messageCursor: Number(row["next_message_seq"]),
    eventCursor: Number(row["next_event_seq"]),
    activeTurnId: row["active_turn_id"] === null ? null : String(row["active_turn_id"]),
    createdAt: asIso(row["created_at"]),
    updatedAt: asIso(row["updated_at"]),
  };
}

function mapTurn(row: Record<string, unknown>): ConversationTurnRecord {
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

function mapMessage(row: Record<string, unknown>): ConversationMessageRecord {
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

function mapToolExecution(row: Record<string, unknown>): ToolExecutionRecord {
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

async function allocateMessageSeq(client: Queryable, conversationId: string): Promise<number> {
  const result = await client.query<{ seq: string }>(
    `UPDATE interec_agent.conversations
     SET next_message_seq = next_message_seq + 1, updated_at = clock_timestamp()
     WHERE id = $1 RETURNING next_message_seq AS seq`,
    [conversationId],
  );
  if (!result.rows[0]) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${conversationId}`);
  return Number(result.rows[0].seq);
}

async function appendConversationEvent(
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

async function inputMessageIds(client: Queryable, turnId: string): Promise<string[]> {
  const result = await client.query<{ message_id: string }>(
    "SELECT message_id FROM interec_agent.turn_input_messages WHERE turn_id = $1 ORDER BY ordinal",
    [turnId],
  );
  return result.rows.map((row) => row.message_id);
}

async function hydrateSnapshot(client: Queryable, conversationId: string, requestedRevision?: number): Promise<ConversationState | null> {
  const conversation = await client.query<Record<string, unknown>>(
    "SELECT current_revision, status FROM interec_agent.conversations WHERE id = $1",
    [conversationId],
  );
  const current = conversation.rows[0];
  if (!current) throw new ConversationRepositoryError("CONVERSATION_NOT_FOUND", `Conversation not found: ${conversationId}`);
  const currentRevision = Number(current["current_revision"]);
  const revision = requestedRevision ?? currentRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > currentRevision) return null;
  if (revision === 0) {
    return { revision: 0, status: String(current["status"]) as ConversationState["status"], goalRevision: null, dialogue: emptyDialogueState(), workingSet: null };
  }
  const result = await client.query<Record<string, unknown>>(
    `SELECT cr.revision,
            gv.revision AS goal_revision, gv.goal_json, gv.operations_json, gv.committed_by_turn_id AS goal_turn_id,
            pgv.revision AS goal_parent_revision,
            dv.state_json AS dialogue_json,
            ws.state_json AS working_set_json
     FROM interec_agent.conversation_revisions cr
     LEFT JOIN interec_agent.goal_versions gv ON gv.id = cr.goal_version_id
     LEFT JOIN interec_agent.goal_versions pgv ON pgv.id = gv.parent_id
     JOIN interec_agent.dialogue_state_versions dv ON dv.id = cr.dialogue_state_version_id
     LEFT JOIN interec_agent.working_sets ws ON ws.id = cr.working_set_id
     WHERE cr.conversation_id = $1 AND cr.revision = $2`,
    [conversationId, revision],
  );
  const row = result.rows[0];
  if (!row) return null;
  const goalRevision: GoalRevision | null = row["goal_revision"] === null ? null : {
    version: Number(row["goal_revision"]),
    parentVersion: row["goal_parent_revision"] === null ? null : Number(row["goal_parent_revision"]),
    goal: row["goal_json"] as GoalRevision["goal"],
    operations: row["operations_json"] as GoalRevision["operations"],
    committedByTurnId: String(row["goal_turn_id"]),
  };
  const workingSet = row["working_set_json"] === null ? null : validateWorkingSet(row["working_set_json"] as WorkingSet);
  return {
    revision,
    status: String(current["status"]) as ConversationState["status"],
    goalRevision,
    dialogue: normalizeDialogueState(row["dialogue_json"]),
    workingSet,
  };
}

async function lockConversationForTurn(client: Queryable, turnId: string): Promise<Record<string, unknown> | null> {
  const located = await client.query<{ conversation_id: string }>("SELECT conversation_id FROM interec_agent.turns WHERE id = $1", [turnId]);
  if (!located.rows[0]) return null;
  const locked = await client.query<Record<string, unknown>>(
    "SELECT * FROM interec_agent.conversations WHERE id = $1 FOR UPDATE",
    [located.rows[0].conversation_id],
  );
  return locked.rows[0] ?? null;
}

async function setOwnerContext(client: Queryable, owner: OwnerClaims): Promise<void> {
  await client.query(
    "SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)",
    [requiredText(owner.tenantId, "INVALID_TENANT_ID"), requiredText(owner.ownerId, "INVALID_OWNER_ID")],
  );
}

async function withOwnerTransaction<T>(pool: pg.Pool, owner: OwnerClaims, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

async function withOwnerSnapshotTransaction<T>(pool: pg.Pool, owner: OwnerClaims, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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
    const terminalRoute = input.plan.ops.length === 0 ? "talk" : routeForTurnPlan(input.plan);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await lockConversationForTurn(client, input.turnId);
      if (!conversation) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        "SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)",
        [String(conversation["tenant_id"]), String(conversation["owner_id"])],
      );
      const turnResult = await client.query<Record<string, unknown>>("SELECT * FROM interec_agent.turns WHERE id = $1 FOR UPDATE", [input.turnId]);
      const turn = turnResult.rows[0]!;
      if (turn["status"] === "COMPLETED") {
        if (Number(turn["attempt"]) !== input.attempt || String(turn["fence_token"]) !== input.fenceToken) {
          await client.query("ROLLBACK");
          return null;
        }
        const published = await client.query<Record<string, unknown>>(
          `SELECT ar.id AS response_id, m.id AS message_id, cr.revision
           FROM interec_agent.assistant_responses ar
           JOIN interec_agent.messages m ON m.assistant_response_id = ar.id
           JOIN interec_agent.conversation_revisions cr ON cr.committed_by_turn_id = ar.turn_id
           WHERE ar.turn_id = $1`,
          [input.turnId],
        );
        await client.query("COMMIT");
        const row = published.rows[0];
        return row ? { committed: false, conversationRevision: Number(row["revision"]), assistantMessageId: String(row["message_id"]), responseId: String(row["response_id"]) } : null;
      }
      const attemptResult = await client.query<Record<string, unknown>>(
        "SELECT * FROM interec_agent.turn_attempts WHERE turn_id = $1 AND attempt = $2 FOR UPDATE",
        [input.turnId, input.attempt],
      );
      const attempt = attemptResult.rows[0];
      const authorized = await client.query<Record<string, unknown>>(
        `UPDATE interec_agent.turns t
         SET status = 'COMMITTING', updated_at = clock_timestamp()
         FROM interec_agent.turn_attempts ta
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
      const draft = attempt["draft_json"] as Record<string, unknown>;
      for (const [field, value] of [
        ["plan", input.plan],
        ["goal", input.state.goalRevision],
        ["dialogue", input.state.dialogue],
        ["workingSet", input.state.workingSet],
        ["envelope", input.envelope],
        ["groundedClaims", input.groundedClaims],
      ] as const) {
        if (!Object.prototype.hasOwnProperty.call(draft, field)
          || canonicalPayloadHash(draft[field]) !== canonicalPayloadHash(value)) {
          throw new ConversationRepositoryError("ATTEMPT_DRAFT_MISMATCH", `Final publication does not match staged attempt field: ${field}`);
        }
      }
      if (!attempt?.["plan_json"] || canonicalPayloadHash(attempt["plan_json"]) !== canonicalPayloadHash(input.plan)) {
        throw new ConversationRepositoryError("TURN_PLAN_NOT_STAGED", "Final commit plan does not match the attempt-scoped staged plan");
      }
      const plan = validatePersistedPlan(input.plan, input.envelope);
      const undoOperation = plan.ops.find((operation) => operation.kind === "UNDO_REVISION");
      const workingSet = input.state.workingSet ? validateWorkingSet(input.state.workingSet) : null;
      if (workingSet && (input.state.dialogue.focusOfferRef !== workingSet.focusOfferRef
        || canonicalPayloadHash(input.state.dialogue.comparisonOfferRefs) !== canonicalPayloadHash(workingSet.comparisonOfferRefs))) {
        throw new ConversationRepositoryError("DIALOGUE_WORKING_SET_DRIFT", "Dialogue focus/comparison must match the committed working set");
      }
      const allowedOfferRefs = new Set(workingSet?.pool.map((item) => item.offerRef) ?? []);
      validateAssistantEnvelope(input.envelope, {
        plan,
        groundedClaims: input.groundedClaims,
        allowedOfferRefs,
        allowedClarificationIds: input.allowedClarificationIds,
        allowedDisclosureCodes: input.allowedDisclosureCodes,
      });
      const deterministicText = renderAssistantEnvelope(input.envelope, input.groundedClaims);
      if (deterministicText !== input.renderedText.trim()) {
        throw new ConversationRepositoryError("ASSISTANT_RENDER_MISMATCH", "Rendered assistant text differs from the validated envelope");
      }
      let publishedClaimSources: ResolvedClaimSources[] = [];
      if (input.groundedClaims.claims.length > 0) {
        if (!workingSet) throw new ConversationRepositoryError("CLAIM_WORKING_SET_REQUIRED", "Claims require a committed working set");
        validateGroundedClaimSet(input.groundedClaims, {
          workingSet,
          allowedEvidenceRefs: new Set((attempt["evidence_keys"] as string[] | null) ?? []),
          envelope: input.envelope,
          renderedDraft: input.renderedText,
        });
        publishedClaimSources = await validatePublishedClaimSources(client, {
          conversationId: String(turn["conversation_id"]),
          turnId: input.turnId,
          attempt: input.attempt,
          currentRevision: Number(conversation["current_revision"]),
          ledger: input.groundedClaims,
        });
      }
      const nextRevision = Number(conversation["current_revision"]) + 1;
      if (input.state.revision !== nextRevision) {
        throw new ConversationRepositoryError("INVALID_PUBLICATION_REVISION", `Expected publication revision ${nextRevision}, received ${input.state.revision}`);
      }
      if (input.state.status !== conversation["status"]) {
        throw new ConversationRepositoryError("CONVERSATION_STATUS_MUTATION_NOT_ALLOWED", "A normal Turn cannot change the Conversation lifecycle status");
      }
      if (workingSet && workingSet.boundGoalVersion !== input.state.goalRevision?.version) {
        throw new ConversationRepositoryError("WORKING_SET_GOAL_VERSION_MISMATCH", "Working set must be bound to the published goal version");
      }
      if (!workingSet && (input.state.dialogue.focusOfferRef !== null || input.state.dialogue.comparisonOfferRefs.length > 0)) {
        throw new ConversationRepositoryError("DIALOGUE_WORKING_SET_REQUIRED", "Dialogue cannot focus or compare offers without a working set");
      }

      const currentPointers = Number(conversation["current_revision"]) === 0 ? null : (await client.query<Record<string, unknown>>(
        `SELECT goal_version_id, working_set_id FROM interec_agent.conversation_revisions
         WHERE conversation_id = $1 AND revision = $2`,
        [turn["conversation_id"], conversation["current_revision"]],
      )).rows[0] ?? null;
      const responseId = randomUUID();
      const assistantMessageId = randomUUID();
      const publishedDialogue = { ...input.state.dialogue, lastAssistantMessageId: assistantMessageId };
      const goalVersionId = await this.resolveGoalVersion(client, String(turn["conversation_id"]), input.turnId, input.state.goalRevision, currentPointers?.["goal_version_id"], nextRevision);
      const dialogueVersionId = randomUUID();
      await client.query(
        `INSERT INTO interec_agent.dialogue_state_versions
           (id, conversation_id, revision, state_json, committed_by_turn_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [dialogueVersionId, turn["conversation_id"], nextRevision, JSON.stringify(publishedDialogue), input.turnId],
      );
      const workingSetId = await this.resolveWorkingSet(client, String(turn["conversation_id"]), input.turnId, input.attempt, workingSet, currentPointers?.["working_set_id"], nextRevision);
      if (undoOperation?.kind === "UNDO_REVISION") {
        if (undoOperation.revision < 0 || undoOperation.revision >= Number(conversation["current_revision"])) {
          throw new ConversationRepositoryError("INVALID_UNDO_TARGET", `Undo target must precede current revision ${conversation["current_revision"]}`);
        }
        const target = undoOperation.revision === 0
          ? { goal_version_id: null, working_set_id: null, dialogue_json: emptyDialogueState() }
          : (await client.query<Record<string, unknown>>(
            `SELECT cr.goal_version_id, cr.working_set_id, dv.state_json AS dialogue_json
             FROM interec_agent.conversation_revisions cr
             JOIN interec_agent.dialogue_state_versions dv ON dv.id = cr.dialogue_state_version_id
             WHERE cr.conversation_id = $1 AND cr.revision = $2`,
            [turn["conversation_id"], undoOperation.revision],
          )).rows[0];
        if (!target) throw new ConversationRepositoryError("UNDO_TARGET_NOT_FOUND", `Undo target revision not found: ${undoOperation.revision}`);
        if (goalVersionId !== nullableString(target["goal_version_id"])
          || workingSetId !== nullableString(target["working_set_id"])
          || canonicalPayloadHash(input.state.dialogue) !== canonicalPayloadHash(target["dialogue_json"])) {
          throw new ConversationRepositoryError("UNDO_STATE_MISMATCH", "Undo publication must restore the exact target shopping goal, Dialogue and WorkingSet pointers");
        }
      } else {
        const currentGoalId = nullableString(currentPointers?.["goal_version_id"]);
        const currentWorkingSetId = nullableString(currentPointers?.["working_set_id"]);
        if (goalVersionId !== currentGoalId && input.state.goalRevision?.version !== nextRevision) {
          throw new ConversationRepositoryError("GOAL_POINTER_REGRESSION", "Only an explicit undo operation may restore an older goal version");
        }
        if (workingSetId !== null && workingSetId !== currentWorkingSetId && workingSet?.version !== nextRevision) {
          throw new ConversationRepositoryError("WORKING_SET_POINTER_REGRESSION", "Only an explicit undo operation may restore an older working-set version");
        }
      }
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO interec_agent.conversation_revisions
           (id, conversation_id, revision, parent_revision, base_revision, goal_version_id, dialogue_state_version_id, working_set_id, committed_by_turn_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [revisionId, turn["conversation_id"], nextRevision, conversation["current_revision"], turn["base_revision"], goalVersionId, dialogueVersionId, workingSetId, input.turnId],
      );
      if (undoOperation?.kind === "UNDO_REVISION") {
        await client.query(
          `INSERT INTO interec_agent.undo_entries (id, conversation_id, turn_id, from_revision, to_revision)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), turn["conversation_id"], input.turnId, conversation["current_revision"], undoOperation.revision],
        );
      }

      const feedbackEvents = candidateFeedbackForTurn(plan, workingSet);
      for (const feedback of feedbackEvents) {
        await client.query(
          `INSERT INTO interec_agent.candidate_feedback_events
             (id, tenant_id, owner_id, conversation_id, turn_id, attempt, kind, operation_id,
              offer_refs, payload_json, goal_version, working_set_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::jsonb, $11, $12)`,
          [
            randomUUID(),
            conversation["tenant_id"],
            conversation["owner_id"],
            turn["conversation_id"],
            input.turnId,
            input.attempt,
            feedback.kind,
            feedback.operationId,
            feedback.offerRefs,
            JSON.stringify(feedback.payload),
            input.state.goalRevision?.version ?? null,
            workingSet?.version ?? null,
          ],
        );
      }

      await client.query(
        `INSERT INTO interec_agent.assistant_responses (id, conversation_id, turn_id, outcome, rendered_text)
         VALUES ($1, $2, $3, $4, $5)`,
        [responseId, turn["conversation_id"], input.turnId, input.envelope.outcome, input.renderedText.trim()],
      );
      await client.query("INSERT INTO interec_agent.assistant_envelopes (response_id, envelope_json) VALUES ($1, $2::jsonb)", [responseId, JSON.stringify(input.envelope)]);
      await client.query("INSERT INTO interec_agent.claim_ledgers (response_id, ledger_json) VALUES ($1, $2::jsonb)", [responseId, JSON.stringify(input.groundedClaims)]);
      for (const claim of input.groundedClaims.claims) {
        const groundedSource = publishedClaimSources.find((item) => item.claimId === claim.claimId);
        if (!groundedSource) throw new ConversationRepositoryError("CLAIM_SOURCE_NOT_RESOLVED", `Claim sources were not resolved: ${claim.claimId}`);
        const publishedClaimId = randomUUID();
        await client.query(
          `INSERT INTO interec_agent.published_claims
             (id, response_id, claim_id, kind, canonical_value, rendered_text)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [publishedClaimId, responseId, claim.claimId, claim.kind, JSON.stringify(claim.canonicalValue), claim.renderedText],
        );
        for (const evidence of groundedSource.sourceFacts) {
          await client.query(
            `INSERT INTO interec_agent.published_claim_evidence
               (published_claim_id, source_fact_id, fx_snapshot_id)
             VALUES ($1, $2, $3)`,
            [publishedClaimId, evidence.sourceFactId, evidence.fxSnapshotId],
          );
        }
      }
      if (input.decision) {
        if (input.envelope.outcome !== "RECOMMENDATION" && input.envelope.outcome !== "NO_MATCH") {
          throw new ConversationRepositoryError("DECISION_OUTCOME_MISMATCH", "Only recommendation/no-match outcomes may publish a Decision");
        }
        await client.query(
          "INSERT INTO interec_agent.decisions (id, response_id, decision_json) VALUES ($1, $2, $3::jsonb)",
          [randomUUID(), responseId, JSON.stringify(input.decision)],
        );
      }
      const assistantSeq = await allocateMessageSeq(client, String(turn["conversation_id"]));
      await client.query(
        `INSERT INTO interec_agent.messages
           (id, conversation_id, seq, role, payload_json, assistant_response_id)
         VALUES ($1, $2, $3, 'ASSISTANT', $4::jsonb, $5)`,
        [assistantMessageId, turn["conversation_id"], assistantSeq, JSON.stringify({ responseId, outcome: input.envelope.outcome, text: input.renderedText.trim() }), responseId],
      );
      await client.query(
        `UPDATE interec_agent.messages m SET consumed_by_turn_id = $1
         FROM interec_agent.turn_input_messages tim
         WHERE tim.turn_id = $1 AND tim.message_id = m.id AND m.consumed_by_turn_id IS NULL`,
        [input.turnId],
      );
      await client.query(
        `UPDATE interec_agent.turns
         SET status = 'COMPLETED', lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [input.turnId],
      );
      await client.query(
        "UPDATE interec_agent.turn_attempts SET status = 'COMMITTED', updated_at = clock_timestamp() WHERE turn_id = $1 AND attempt = $2",
        [input.turnId, input.attempt],
      );
      await client.query(
        `UPDATE interec_agent.conversations
         SET current_revision = $2, status = $3, active_turn_id = NULL, updated_at = clock_timestamp()
         WHERE id = $1`,
        [turn["conversation_id"], nextRevision, input.state.status],
      );
      await appendConversationEvent(client, String(turn["conversation_id"]), input.turnId, "assistant.message.committed", { revision: nextRevision, messageSeq: assistantSeq, outcome: input.envelope.outcome });
      await client.query("COMMIT");
      for (const feedback of feedbackEvents) runtimeMetrics.feedbackEvents.add(1, { kind: feedback.kind });
      recordTerminalTurn("COMPLETED", terminalRoute);
      return { committed: true, conversationRevision: nextRevision, assistantMessageId, responseId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveGoalVersion(
    client: pg.PoolClient,
    conversationId: string,
    turnId: string,
    goalRevision: GoalRevision | null,
    currentGoalVersionId: unknown,
    publicationRevision: number,
  ): Promise<string | null> {
    if (!goalRevision) return null;
    const existing = await client.query<Record<string, unknown>>(
      "SELECT id, goal_json, operations_json FROM interec_agent.goal_versions WHERE conversation_id = $1 AND revision = $2",
      [conversationId, goalRevision.version],
    );
    if (existing.rows[0]) {
      if (canonicalPayloadHash(existing.rows[0]["goal_json"]) !== canonicalPayloadHash(goalRevision.goal)) {
        throw new ConversationRepositoryError("GOAL_VERSION_CONFLICT", `shopping goal version ${goalRevision.version} has different state`);
      }
      if (canonicalPayloadHash(existing.rows[0]["operations_json"]) !== canonicalPayloadHash(goalRevision.operations)) {
        throw new ConversationRepositoryError("GOAL_OPERATION_HISTORY_CONFLICT", `shopping goal version ${goalRevision.version} has different operations`);
      }
      return String(existing.rows[0]["id"]);
    }
    if (goalRevision.version !== publicationRevision) {
      throw new ConversationRepositoryError("GOAL_VERSION_NOT_MONOTONE", `A new goal version must use publication revision ${publicationRevision}`);
    }
    let parentId: string | null = null;
    if (goalRevision.parentVersion !== null) {
      const parent = await client.query<{ id: string }>(
        "SELECT id FROM interec_agent.goal_versions WHERE conversation_id = $1 AND revision = $2",
        [conversationId, goalRevision.parentVersion],
      );
      if (!parent.rows[0]) throw new ConversationRepositoryError("GOAL_PARENT_REVISION_NOT_FOUND", `shopping goal parent version not found: ${goalRevision.parentVersion}`);
      parentId = parent.rows[0].id;
    }
    const currentId = currentGoalVersionId === null || currentGoalVersionId === undefined ? null : String(currentGoalVersionId);
    if (parentId !== currentId) {
      throw new ConversationRepositoryError("GOAL_PARENT_NOT_CURRENT", "A new goal version must branch from the currently published goal pointer");
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO interec_agent.goal_versions
         (id, conversation_id, revision, parent_id, goal_json, operations_json, committed_by_turn_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [id, conversationId, goalRevision.version, parentId, JSON.stringify(goalRevision.goal), JSON.stringify(goalRevision.operations), turnId],
    );
    return id;
  }

  private async resolveWorkingSet(
    client: pg.PoolClient,
    conversationId: string,
    turnId: string,
    attempt: number,
    workingSet: WorkingSet | null,
    currentWorkingSetId: unknown,
    publicationRevision: number,
  ): Promise<string | null> {
    if (!workingSet) return null;
    const existing = await client.query<Record<string, unknown>>(
      "SELECT id, state_json FROM interec_agent.working_sets WHERE conversation_id = $1 AND revision = $2",
      [conversationId, workingSet.version],
    );
    if (existing.rows[0]) {
      if (canonicalPayloadHash(existing.rows[0]["state_json"]) !== canonicalPayloadHash(workingSet)) {
        throw new ConversationRepositoryError("WORKING_SET_VERSION_CONFLICT", `Working-set version ${workingSet.version} has different state`);
      }
      return String(existing.rows[0]["id"]);
    }
    if (workingSet.version !== publicationRevision) {
      throw new ConversationRepositoryError("WORKING_SET_VERSION_NOT_MONOTONE", `A new working-set version must use publication revision ${publicationRevision}`);
    }
    const refsHash = canonicalPayloadHash(workingSet.pool.map((candidate) => candidate.offerRef).sort());
    const draftRankedOfferSet = await client.query<Record<string, unknown>>(
      `SELECT id FROM interec_agent.comparison_sets
       WHERE conversation_id = $1 AND turn_id = $2 AND attempt = $3 AND status = 'DRAFT'
         AND candidate_refs_hash = $4 AND bound_goal_version = $5
       ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [conversationId, turnId, attempt, refsHash, workingSet.boundGoalVersion],
    );
    let sourceRankedOfferSetId = nullableString(draftRankedOfferSet.rows[0]?.["id"]);
    if (sourceRankedOfferSetId) {
      const rankedItems = await client.query<Record<string, unknown>>(
        `SELECT offer_ref, candidate_json FROM interec_agent.comparison_set_items
         WHERE comparison_set_id = $1 ORDER BY rank`,
        [sourceRankedOfferSetId],
      );
      if (rankedItems.rowCount !== workingSet.pool.length) {
        throw new ConversationRepositoryError("WORKING_SET_SOURCE_SIZE_MISMATCH", "Working set and source-ranked offer set differ in size");
      }
      for (const candidate of workingSet.pool) {
        const item = rankedItems.rows.find((row) => String(row["offer_ref"]) === candidate.offerRef);
        if (!item || canonicalPayloadHash(item["candidate_json"]) !== canonicalPayloadHash(candidate)) {
          throw new ConversationRepositoryError("WORKING_SET_SOURCE_MISMATCH", `Candidate differs from its source-grounded projection: ${candidate.offerRef}`);
        }
      }
    } else if (currentWorkingSetId) {
      const currentSource = await client.query<Record<string, unknown>>(
        `SELECT proof_comparison_set_id, state_json FROM interec_agent.working_sets WHERE id = $1`,
        [currentWorkingSetId],
      );
      const previous = currentSource.rows[0];
      const previousPool = (previous?.["state_json"] as WorkingSet | undefined)?.pool ?? [];
      if (canonicalPayloadHash(previousPool) === canonicalPayloadHash(workingSet.pool)) {
        sourceRankedOfferSetId = nullableString(previous?.["proof_comparison_set_id"]);
      }
    }
    if (workingSet.pool.length > 0 && !sourceRankedOfferSetId) {
      throw new ConversationRepositoryError("WORKING_SET_SOURCE_REQUIRED", "A non-empty working set must originate from a published ranked offer set");
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO interec_agent.working_sets
         (id, conversation_id, revision, bound_goal_version, state_json, committed_by_turn_id, proof_comparison_set_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [id, conversationId, workingSet.version, workingSet.boundGoalVersion, JSON.stringify(workingSet), turnId, sourceRankedOfferSetId],
    );
    for (const [ordinal, candidate] of workingSet.pool.entries()) {
      const ref = candidate.offerRef;
      await client.query(
        `INSERT INTO interec_agent.working_set_items
           (working_set_id, offer_ref, ordinal, candidate_json, is_displayed, is_mentioned, is_compared, is_rejected, is_focused)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
        [
          id,
          ref,
          ordinal,
          JSON.stringify(candidate),
          workingSet.displayOfferRefs.includes(ref),
          workingSet.mentionedOfferRefs.includes(ref),
          workingSet.comparisonOfferRefs.includes(ref),
          workingSet.rejectedOfferRefs.includes(ref),
          workingSet.focusOfferRef === ref,
        ],
      );
    }
    if (draftRankedOfferSet.rows[0]) {
      await client.query(
        `UPDATE interec_agent.comparison_sets
         SET status = 'PROMOTED', promoted_revision = $2
         WHERE id = $1 AND status = 'DRAFT'`,
        [sourceRankedOfferSetId, publicationRevision],
      );
      await client.query(
        `UPDATE interec_agent.source_facts SET promoted_revision = $3
         WHERE turn_id = $1 AND attempt = $2 AND promoted_revision IS NULL`,
        [turnId, attempt, publicationRevision],
      );
      await client.query(
        `UPDATE interec_agent.fx_snapshots SET promoted_revision = $3
         WHERE turn_id = $1 AND attempt = $2 AND promoted_revision IS NULL`,
        [turnId, attempt, publicationRevision],
      );
      await client.query(
        `UPDATE interec_agent.provider_artifacts SET promoted_revision = $3
         WHERE turn_id = $1 AND attempt = $2 AND promoted_revision IS NULL`,
        [turnId, attempt, publicationRevision],
      );
    }
    return id;
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
