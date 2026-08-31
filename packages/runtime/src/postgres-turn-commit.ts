import { randomUUID } from "node:crypto";

import {
  candidateFeedbackForTurn,
  emptyDialogueState,
  renderAssistantEnvelope,
  routeForTurnPlan,
  validateAssistantEnvelope,
  validateNoPlanDegradedPublication,
  validateTurnPlan,
  validateWorkingSet,
  validateGroundedClaimSet,
  type GoalRevision,
  type GroundedClaimSet,
  type WorkingSet,
} from "@interec/domain";
import pg from "pg";

import type {
  AttemptDraft,
  CommitConversationTurnInput,
  ConversationTurnStatus,
  FinalCommitResult,
} from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";
import {
  allocateMessageSeq,
  appendConversationEvent,
  asIso,
  canonicalPayloadHash,
  lockConversationForTurn,
  nullableString,
} from "./postgres-conversation-storage.js";
import { runtimeMetrics } from "./telemetry.js";

export function validatePersistedPlan(plan: CommitConversationTurnInput["plan"], envelope?: AttemptDraft["envelope"]) {
  if (plan.ops.length > 0) return validateTurnPlan(plan);
  if (!envelope || envelope.outcome !== "DEGRADED" || envelope.addressedOpIds.length !== 0) {
    throw new ConversationRepositoryError(
      "EMPTY_PLAN_REQUIRES_SYSTEM_DEGRADATION",
      "Only an unaddressed system-owned DEGRADED publication may persist without an approved plan",
    );
  }
  return validateNoPlanDegradedPublication(plan);
}

export function recordTerminalTurn(status: ConversationTurnStatus, route = "unknown"): void {
  try {
    runtimeMetrics.terminalTurns.add(1, { status, route, committed: status === "COMPLETED" });
  } catch {
    // Observability cannot change an already committed authoritative transition.
  }
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

export async function commitPostgresConversationTurn(pool: pg.Pool, input: CommitConversationTurnInput): Promise<FinalCommitResult | null> {
    const terminalRoute = input.plan.ops.length === 0 ? "talk" : routeForTurnPlan(input.plan);
    const client = await pool.connect();
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
      const goalVersionId = await resolveGoalVersion(client, String(turn["conversation_id"]), input.turnId, input.state.goalRevision, currentPointers?.["goal_version_id"], nextRevision);
      const dialogueVersionId = randomUUID();
      await client.query(
        `INSERT INTO interec_agent.dialogue_state_versions
           (id, conversation_id, revision, state_json, committed_by_turn_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [dialogueVersionId, turn["conversation_id"], nextRevision, JSON.stringify(publishedDialogue), input.turnId],
      );
      const workingSetId = await resolveWorkingSet(client, String(turn["conversation_id"]), input.turnId, input.attempt, workingSet, currentPointers?.["working_set_id"], nextRevision);
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

async function resolveGoalVersion(
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

async function resolveWorkingSet(
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

