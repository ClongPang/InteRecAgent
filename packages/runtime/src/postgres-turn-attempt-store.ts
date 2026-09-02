import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { AttemptDraft, RecordPlanReviewInput } from "./conversation-repository-types.js";
import { ConversationRepositoryError } from "./conversation-repository-types.js";

export async function recordPostgresAttemptTelemetryLink(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  traceId: string,
  rootObservationId: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "0".repeat(32)) return false;
  if (!/^[0-9a-f]{16}$/.test(rootObservationId) || rootObservationId === "0".repeat(16)) return false;
  const result = await pool.query(
    `UPDATE interec_agent.turn_attempts
     SET trace_id = $4, root_observation_id = $5,
         trace_id_source = 'OBSERVED_ATTEMPT_ROOT', updated_at = clock_timestamp()
     WHERE turn_id = $1 AND attempt = $2 AND fence_token = $3::bigint
       AND status IN ('CLAIMED', 'RUNNING')`,
    [turnId, attempt, fenceToken, traceId, rootObservationId],
  );
  return result.rowCount === 1;
}

export async function stagePostgresAttemptDraft(
  pool: pg.Pool,
  turnId: string,
  attempt: number,
  fenceToken: string,
  draft: AttemptDraft,
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(draft, "quotePlan")) patch["quotePlan"] = draft.quotePlan ?? null;
  if (Object.prototype.hasOwnProperty.call(draft, "quoteState")) patch["quoteState"] = draft.quoteState ?? null;
  if (Object.prototype.hasOwnProperty.call(draft, "quoteReply")) patch["quoteReply"] = draft.quoteReply ?? null;
  const result = await pool.query(
    `UPDATE interec_agent.turn_attempts ta
     SET draft_json = draft_json || $4::jsonb,
         updated_at = clock_timestamp()
     FROM interec_agent.turns t
     WHERE ta.turn_id = t.id AND ta.turn_id = $1 AND ta.attempt = $2 AND ta.fence_token = $3::bigint
       AND ta.status = 'RUNNING' AND t.status = 'RUNNING'
       AND t.attempt = $2 AND t.fence_token = $3::bigint
       AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()`,
    [turnId, attempt, fenceToken, JSON.stringify(patch)],
  );
  return result.rowCount === 1;
}

export async function recordPostgresPlanReview(
  pool: pg.Pool,
  input: RecordPlanReviewInput,
): Promise<boolean> {
  if (!Number.isSafeInteger(input.proposalNumber) || input.proposalNumber < 1 || input.proposalNumber > 3) {
    throw new ConversationRepositoryError(
      "INVALID_PLAN_PROPOSAL_NUMBER",
      "Plan proposal number must be between 1 and 3",
    );
  }
  const result = await pool.query(
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
