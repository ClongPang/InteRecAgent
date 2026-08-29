import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import { executeConversationTurn } from "@interec/agent";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  claimEvidenceKey,
  createGoalRevision,
  createWorkingSet,
  emptyDialogueState,
  renderAssistantEnvelope,
  type AssistantEnvelope,
  type ClaimLedger,
  type ConversationState,
  type TurnPlan,
} from "@interec/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ConversationRepositoryError,
  ConversationResearchWorld,
  ConversationWorker,
  PostgresConversationRepository,
  PostgresConversationResearchRepository,
  PostgresOutboxPublisher,
  PostgresProviderGovernor,
  createRepositoryTurnSession,
  runConversationMigrations,
  type ClaimedConversationTurn,
  type OwnerClaims,
} from "../src/index.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = process.env["INTEREC_DATABASE_URL"] ?? "postgresql://interec:interec@127.0.0.1:5432/interec";

const plan: TurnPlan = {
  userIntentSummary: "continue the conversation without external research",
  ops: [{ opId: "focus", kind: "SET_FOCUS", referent: null }],
  leftover: [],
};
const envelope: AssistantEnvelope = {
  outcome: "CHAT",
  addressedOpIds: ["focus"],
  blocks: [{ type: "TRANSITION", text: "我保留了当前上下文，可以继续比较或调整条件。" }],
  nextMoves: [],
};
const ledger: ClaimLedger = { claims: [] };

function initialPublication(): ConversationState {
  return { revision: 1, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet: null };
}

async function start(repository: PostgresConversationRepository, conversationId: string, owner: OwnerClaims, clientTurnId = randomUUID(), content = "继续聊聊当前候选"): Promise<ClaimedConversationTurn> {
  const accepted = await repository.acceptTurn({
    conversationId,
    owner,
    clientTurnId,
    input: { type: "MESSAGE", content },
  });
  const claimed = await repository.claimTurn(`worker-${randomUUID()}`, 30, accepted.id);
  expect(claimed).not.toBeNull();
  expect(await repository.markTurnRunning(claimed!.id, claimed!.attempt, claimed!.fenceToken)).toBe(true);
  return claimed!;
}

async function stageChat(repository: PostgresConversationRepository, claimed: ClaimedConversationTurn, state = initialPublication()): Promise<void> {
  expect(await repository.stageAttemptDraft(claimed.id, claimed.attempt, claimed.fenceToken, {
    plan,
    goal: state.goalRevision,
    dialogue: state.dialogue,
    workingSet: state.workingSet,
    envelope,
    claimLedger: ledger,
    evidenceKeys: [],
  })).toBe(true);
}

suite("PostgreSQL conversation repository", () => {
  const first = new PostgresConversationRepository(databaseUrl, 6);
  const second = new PostgresConversationRepository(databaseUrl, 6);
  const owner: OwnerClaims = { tenantId: `conversation-it-${randomUUID()}`, ownerId: `owner-${randomUUID()}` };

  beforeAll(async () => {
    await runConversationMigrations(first.pool);
  });

  afterAll(async () => {
    await first.pool.query("UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE tenant_id = $1 AND owner_id = $2", [owner.tenantId, owner.ownerId]);
    await first.pool.query("DELETE FROM interec_agent.conversations WHERE tenant_id = $1 AND owner_id = $2", [owner.tenantId, owner.ownerId]);
    await Promise.all([first.close(), second.close()]);
  });

  it("enforces canonical idempotency and rejects a reused key with another payload", async () => {
    const conversation = await first.createConversation(owner);
    const clientTurnId = randomUUID();
    const input = { conversationId: conversation.id, owner, clientTurnId, input: { type: "MESSAGE" as const, content: "第一条消息" } };
    const accepted = await first.acceptTurn(input);
    const replay = await first.acceptTurn(input);
    expect(replay).toMatchObject({ id: accepted.id, idempotentReplay: true, inputMessageIds: accepted.inputMessageIds });
    await expect(first.acceptTurn({ ...input, input: { type: "MESSAGE", content: "不同消息" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("persists the asynchronous trace root for the worker attempt", async () => {
    const conversation = await first.createConversation(owner);
    const telemetryTraceId = "a".repeat(32);
    const telemetryRootObservationId = "b".repeat(16);
    const accepted = await first.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: randomUUID(),
      input: { type: "MESSAGE", content: "trace root persistence" },
      telemetryTraceId,
      telemetryRootObservationId,
    });

    const claimed = await first.claimTurn(`worker-${randomUUID()}`, 30, accepted.id);
    expect(claimed).toMatchObject({ telemetryTraceId, telemetryRootObservationId });
    expect(await first.markTurnRunning(claimed!.id, claimed!.attempt, claimed!.fenceToken)).toBe(true);
    expect(await first.failTurn(claimed!.id, claimed!.attempt, claimed!.fenceToken, "TEST_COMPLETED")).toBe(true);
  });

  it("retries a failed Turn from the same unconsumed USER batch without adding a duplicate message", async () => {
    const conversation = await first.createConversation(owner);
    const failed = await start(first, conversation.id, owner);
    expect(await first.failTurn(failed.id, failed.attempt, failed.fenceToken, "TRANSIENT_MODEL_FAILURE")).toBe(true);
    const retried = await first.retryTurn({
      conversationId: conversation.id,
      turnId: failed.id,
      owner,
      clientTurnId: "retry-1",
      expectedRevision: 0,
    });
    expect(retried).toMatchObject({ status: "ACCEPTED", inputMessageIds: failed.inputMessages.map((message) => message.id), idempotentReplay: false });
    const replay = await first.retryTurn({ conversationId: conversation.id, turnId: failed.id, owner, clientTurnId: "retry-1", expectedRevision: 0 });
    expect(replay).toMatchObject({ id: retried.id, idempotentReplay: true });
    expect(await first.listMessages(conversation.id, owner, 0)).toHaveLength(1);
    expect(await first.getTurn(retried.id, { ...owner, ownerId: "another-owner" })).toBeNull();
  });

  it("enforces owner RLS when evaluated under a non-bypassing table-owner posture", async () => {
    const otherOwner: OwnerClaims = { tenantId: owner.tenantId, ownerId: `other-${randomUUID()}` };
    const ownConversation = await first.createConversation(owner);
    const otherConversation = await first.createConversation(otherOwner);
    const client = await first.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE interec_agent.conversations FORCE ROW LEVEL SECURITY");
      await client.query("SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)", [owner.tenantId, owner.ownerId]);
      const visible = await client.query<{ id: string }>("SELECT id FROM interec_agent.conversations WHERE id = ANY($1::uuid[]) ORDER BY id", [[ownConversation.id, otherConversation.id]]);
      expect(visible.rows.map((row) => row.id)).toEqual([ownConversation.id]);
      await client.query("SELECT set_config('interec.owner_id', $1, true)", [otherOwner.ownerId]);
      const switched = await client.query<{ id: string }>("SELECT id FROM interec_agent.conversations WHERE id = ANY($1::uuid[]) ORDER BY id", [[ownConversation.id, otherConversation.id]]);
      expect(switched.rows.map((row) => row.id)).toEqual([otherConversation.id]);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("claims outbox rows with a lease and moves exhausted delivery to dead letter", async () => {
    const conversation = await first.createConversation(owner);
    const accepted = await first.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: randomUUID(),
      input: { type: "MESSAGE", content: "outbox delivery test" },
    });
    const topic = `test.${randomUUID()}`;
    await first.pool.query(
      `UPDATE interec_agent.outbox o SET topic = $2
       FROM interec_agent.turn_events e
       WHERE o.event_id = e.id AND e.turn_id = $1`,
      [accepted.id, topic],
    );
    const deliveries: string[] = [];
    const publisher = new PostgresOutboxPublisher(first.pool, {
      publish: async (message) => {
        deliveries.push(message.eventId);
        throw new Error("TEST_SINK_UNAVAILABLE");
      },
    }, { workerId: `outbox-${randomUUID()}`, topics: [topic], maxAttempts: 2, retryBaseSeconds: 0 });
    expect(await publisher.runBatch()).toEqual({ published: 0, failed: 1, deadLettered: 0 });
    expect(await publisher.runBatch()).toEqual({ published: 0, failed: 0, deadLettered: 1 });
    expect(deliveries).toHaveLength(2);
    const row = await first.pool.query<{ attempt_count: number; dead: boolean; last_error: string }>(
      `SELECT attempt_count, dead_lettered_at IS NOT NULL AS dead, last_error
       FROM interec_agent.outbox WHERE topic = $1`,
      [topic],
    );
    expect(row.rows[0]).toMatchObject({ attempt_count: 2, dead: true, last_error: "TEST_SINK_UNAVAILABLE" });
  });

  it("serializes concurrent migration runners with the advisory lock", async () => {
    const results = await Promise.all([runConversationMigrations(first.pool), runConversationMigrations(second.pool)]);
    expect(results).toEqual([
      { applied: [], verifiedTables: 32 },
      { applied: [], verifiedTables: 32 },
    ]);
  });

  it("lets only one worker claim a turn", async () => {
    const conversation = await first.createConversation(owner);
    const accepted = await first.acceptTurn({ conversationId: conversation.id, owner, clientTurnId: randomUUID(), input: { type: "MESSAGE", content: "并发领取" } });
    const claims = await Promise.all([
      first.claimTurn("worker-a", 30, accepted.id),
      second.claimTurn("worker-b", 30, accepted.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("claims one exact live Turn without expiring or scanning unrelated queue state", async () => {
    const unrelatedConversation = await first.createConversation(owner);
    const unrelated = await first.acceptTurn({ conversationId: unrelatedConversation.id, owner, clientTurnId: randomUUID(), input: { type: "MESSAGE", content: "unrelated" } });
    await first.pool.query("UPDATE interec_agent.turns SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1", [unrelated.id]);
    const targetConversation = await first.createConversation(owner);
    const target = await first.acceptTurn({ conversationId: targetConversation.id, owner, clientTurnId: randomUUID(), input: { type: "MESSAGE", content: "exact target" } });
    expect(await first.claimTurn("exact-live-worker", 30, target.id)).toMatchObject({ id: target.id, status: "CLAIMED" });
    expect(await first.getTurn(unrelated.id, owner)).toMatchObject({ status: "ACCEPTED" });
  });

  it("publishes revision, state, assistant message, consumption and event atomically", async () => {
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner);
    const state = initialPublication();
    await stageChat(first, claimed, state);
    const renderedText = renderAssistantEnvelope(envelope, ledger);
    const committed = await first.commitTurn({
      turnId: claimed.id,
      attempt: claimed.attempt,
      fenceToken: claimed.fenceToken,
      state,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText,
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    });
    expect(committed).toMatchObject({ committed: true, conversationRevision: 1 });
    const replay = await first.commitTurn({
      turnId: claimed.id,
      attempt: claimed.attempt,
      fenceToken: claimed.fenceToken,
      state,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText,
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    });
    expect(replay).toMatchObject({ committed: false, responseId: committed!.responseId });
    const snapshot = await first.getSnapshot(conversation.id, owner);
    expect(snapshot).toMatchObject({ revision: 1, dialogue: { lastAssistantMessageId: committed!.assistantMessageId } });
    const messages = await first.listMessages(conversation.id, owner, 0);
    expect(messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
    expect(messages[0]?.consumedByTurnId).toBe(claimed.id);
    const events = await first.listEvents(conversation.id, owner, 0);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)?.eventType).toBe("assistant.message.committed");
    const cursor = events[1]!.seq;
    expect((await first.listEvents(conversation.id, owner, cursor)).every((event) => event.seq > cursor)).toBe(true);
    const feedback = await first.pool.query<{ kind: string; operation_id: string; offer_refs: string[]; payload_json: Record<string, unknown> }>(
      "SELECT kind, operation_id, offer_refs, payload_json FROM interec_agent.candidate_feedback_events WHERE turn_id = $1",
      [claimed.id],
    );
    expect(feedback.rows).toEqual([{ kind: "FOCUS", operation_id: "focus", offer_refs: [], payload_json: { cleared: true } }]);
    await expect(first.pool.query(
      "UPDATE interec_agent.candidate_feedback_events SET payload_json = '{}'::jsonb WHERE turn_id = $1",
      [claimed.id],
    )).rejects.toThrow(/append-only/);
  });

  it("rejects final publication after the database lease expires", async () => {
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner);
    const state = initialPublication();
    await stageChat(first, claimed, state);
    await first.pool.query("UPDATE interec_agent.turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claimed.id]);
    expect(await first.commitTurn({
      turnId: claimed.id,
      attempt: claimed.attempt,
      fenceToken: claimed.fenceToken,
      state,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(envelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    })).toBeNull();
    expect((await first.getSnapshot(conversation.id, owner))?.revision).toBe(0);
    expect(await first.listMessages(conversation.id, owner, 0)).toHaveLength(1);
  });

  it("keeps failed and cancelled attempt drafts outside the conversation projection", async () => {
    const failedConversation = await first.createConversation(owner);
    const failed = await start(first, failedConversation.id, owner);
    await stageChat(first, failed);
    expect(await first.failTurn(failed.id, failed.attempt, failed.fenceToken, "MODEL_PROTOCOL_FAILED")).toBe(true);
    expect((await first.getSnapshot(failedConversation.id, owner))?.revision).toBe(0);
    expect(await first.listMessages(failedConversation.id, owner, 0)).toHaveLength(1);

    const cancelledConversation = await first.createConversation(owner);
    const cancelled = await start(first, cancelledConversation.id, owner);
    await stageChat(first, cancelled);
    expect(await first.cancelTurn(cancelled.id, owner)).toBe(true);
    expect((await first.getSnapshot(cancelledConversation.id, owner))?.revision).toBe(0);
    expect(await first.commitTurn({
      turnId: cancelled.id,
      attempt: cancelled.attempt,
      fenceToken: cancelled.fenceToken,
      state: initialPublication(),
      plan,
      envelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(envelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    })).toBeNull();
    expect(await first.listMessages(cancelledConversation.id, owner, 0)).toHaveLength(1);

    const timedOutConversation = await first.createConversation(owner);
    const timedOut = await start(first, timedOutConversation.id, owner);
    await first.pool.query("UPDATE interec_agent.turns SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1", [timedOut.id]);
    expect(await first.failTurn(timedOut.id, timedOut.attempt, timedOut.fenceToken, "TURN_DEADLINE_EXCEEDED")).toBe(true);
    expect(await first.getTurn(timedOut.id, owner)).toMatchObject({ status: "TIMED_OUT" });
    expect((await first.listEvents(timedOutConversation.id, owner, 0)).at(-1)?.eventType).toBe("turn.timed_out");
  });

  it("supersedes a stale attempt and feeds every unconsumed user message to the next turn", async () => {
    const conversation = await first.createConversation(owner);
    const old = await start(first, conversation.id, owner, "old-turn");
    const next = await first.acceptTurn({ conversationId: conversation.id, owner, clientTurnId: "corrected-turn", input: { type: "MESSAGE", content: "纠正：预算改成 2500" } });
    expect(next.inputMessageIds).toHaveLength(2);
    const claimed = await first.claimTurn("worker-correction", 30, next.id);
    expect(claimed?.inputMessages.map((message) => message.payload["content"])).toEqual(["继续聊聊当前候选", "纠正：预算改成 2500"]);
    expect(await first.markTurnRunning(claimed!.id, claimed!.attempt, claimed!.fenceToken)).toBe(true);
    const state = initialPublication();
    await stageChat(first, claimed!, state);
    expect(await first.commitTurn({
      turnId: old.id,
      attempt: old.attempt,
      fenceToken: old.fenceToken,
      state,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(envelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    })).toBeNull();
    expect(await first.commitTurn({
      turnId: claimed!.id,
      attempt: claimed!.attempt,
      fenceToken: claimed!.fenceToken,
      state,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(envelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    })).toMatchObject({ committed: true });
    const userMessages = (await first.listMessages(conversation.id, owner, 0)).filter((message) => message.role === "USER");
    expect(userMessages.every((message) => message.consumedByTurnId === claimed!.id)).toBe(true);
  });

  it("rolls back state publication when a late response invariant fails", async () => {
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner);
    const state = initialPublication();
    await stageChat(first, claimed, state);
    await expect(first.commitTurn({
      turnId: claimed.id,
      attempt: claimed.attempt,
      fenceToken: claimed.fenceToken,
      state,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(envelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
      decision: { invalidForChat: true },
    })).rejects.toMatchObject({ code: "DECISION_OUTCOME_MISMATCH" });
    expect((await first.getSnapshot(conversation.id, owner))?.revision).toBe(0);
    expect(await first.listMessages(conversation.id, owner, 0)).toHaveLength(1);
  });

  it("durably reserves tool steps, recovers before/after results, and dead-letters attempt exhaustion", async () => {
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner);
    const state = initialPublication();
    await stageChat(first, claimed, state);
    expect((await first.getSnapshot(conversation.id, owner))?.revision).toBe(0);

    const request = { market: "US", query: "WH-1000XM5" };
    const firstReservation = await first.reserveToolExecution(claimed.id, claimed.attempt, claimed.fenceToken, "research:US:1", request);
    expect(firstReservation?.action).toBe("CALL");
    expect((await first.reserveToolExecution(claimed.id, claimed.attempt, claimed.fenceToken, "research:US:1", request))?.action).toBe("WAIT");
    await first.pool.query("UPDATE interec_agent.turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claimed.id]);

    const recovered = await first.claimTurn("worker-recovered", 30, claimed.id);
    expect(recovered?.attempt).toBe(2);
    expect(await first.completeToolExecution(claimed.id, claimed.attempt, claimed.fenceToken, "research:US:1", firstReservation!.execution.requestHash, { stale: true })).toBe(false);
    expect(await first.markTurnRunning(recovered!.id, recovered!.attempt, recovered!.fenceToken)).toBe(true);
    const retryReservation = await first.reserveToolExecution(recovered!.id, recovered!.attempt, recovered!.fenceToken, "research:US:1", request);
    expect(retryReservation?.action).toBe("CALL");
    expect(await first.completeToolExecution(recovered!.id, recovered!.attempt, recovered!.fenceToken, "research:US:1", retryReservation!.execution.requestHash, { offers: ["o1"] })).toBe(true);
    await first.pool.query("UPDATE interec_agent.turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [recovered!.id]);

    const third = await first.claimTurn("worker-third", 30, recovered!.id);
    expect(third?.attempt).toBe(3);
    expect(await first.markTurnRunning(third!.id, third!.attempt, third!.fenceToken)).toBe(true);
    const reused = await first.reserveToolExecution(third!.id, third!.attempt, third!.fenceToken, "research:US:1", request);
    expect(reused).toMatchObject({ action: "REUSE", execution: { result: { offers: ["o1"] } } });
    await expect(first.reserveToolExecution(third!.id, third!.attempt, third!.fenceToken, "research:US:1", { ...request, market: "SG" })).rejects.toMatchObject({ code: "TOOL_STEP_REQUEST_CONFLICT" });
    expect(await first.heartbeatTurn(third!.id, recovered!.attempt, recovered!.fenceToken, 30)).toBe(false);
    expect(await first.heartbeatTurn(third!.id, third!.attempt, third!.fenceToken, 30)).toBe(true);

    await first.pool.query("UPDATE interec_agent.turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [third!.id]);
    expect(await first.expireDueTurns()).toBeGreaterThanOrEqual(1);
    const terminal = await first.pool.query<{ status: string; error_code: string }>("SELECT status, error_code FROM interec_agent.turns WHERE id = $1", [third!.id]);
    expect(terminal.rows[0]).toEqual({ status: "DEAD_LETTER", error_code: "MAX_ATTEMPTS_EXHAUSTED" });
    const attempts = await first.pool.query<{ attempt: number; status: string }>("SELECT attempt, status FROM interec_agent.turn_attempts WHERE turn_id = $1 ORDER BY attempt", [third!.id]);
    expect(attempts.rows.map((row) => row.status)).toEqual(["ABANDONED", "ABANDONED", "ABANDONED"]);
  });

  it("allocates a gap-free conversation event sequence under concurrent corrections", async () => {
    const conversation = await first.createConversation(owner);
    await Promise.all(Array.from({ length: 5 }, (_, index) => first.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: `concurrent-${conversation.id}-${index}`,
      input: { type: "MESSAGE", content: `并发纠正 ${index}` },
    })));
    const events = await first.listEvents(conversation.id, owner, 0);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    const active = await first.pool.query<{ active_turn_id: string }>("SELECT active_turn_id FROM interec_agent.conversations WHERE id = $1", [conversation.id]);
    const inputs = await first.pool.query<{ count: string }>("SELECT count(*) FROM interec_agent.turn_input_messages WHERE turn_id = $1", [active.rows[0]!.active_turn_id]);
    expect(Number(inputs.rows[0]!.count)).toBe(5);
  });

  it("never promotes evidence keys owned only by an abandoned attempt", async () => {
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner);
    const source = { messageId: claimed.inputMessages[0]!.id };
    const goalRevision = createGoalRevision(null, [{
      opId: "target",
      kind: "GOAL_SET_TARGET",
      source,
      target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" },
    }], claimed.id);
    const workingSet = createWorkingSet({
      version: 1,
      boundGoalVersion: 1,
      pool: [{
        offerRef: "offer-proof",
        title: "Sony WH-1000XM5",
        canonicalModel: "WH-1000XM5",
        categoryId: "headphones",
        itemRole: "PRIMARY_PRODUCT",
        condition: "NEW",
        retrievalMarket: "US",
        merchant: "Merchant Proof",
        cnyAmount: "2100",
        stock: "IN_STOCK",
        claimIds: ["price-proof"],
      }],
    });
    const proofPlan: TurnPlan = {
      userIntentSummary: "inspect a verified price",
      ops: [{ opId: "inspect", kind: "INSPECT_WORKING_SET", referents: [{ kind: "OFFER_REF", offerRef: "offer-proof" }], fields: ["PRICE"] }],
      leftover: [],
    };
    const evidence = {
      artifactRef: "artifact-proof",
      jsonPath: "$.price.amount",
      source: "buywhere",
      observedAt: "2026-08-26T00:00:00.000Z",
      sourceFactRef: "fact-proof",
      canonicalValue: { amount: "300", currency: "USD" },
      providerSchemaVersion: "buywhere-v1",
      policyVersion: "proof-carrying-v1",
      derivation: "DERIVED" as const,
      fxSnapshotId: "fx-proof",
    };
    const proofLedger: ClaimLedger = { claims: [{
      claimId: "price-proof",
      kind: "PRICE",
      canonicalValue: { amount: "2100", currency: "CNY", basis: "FX_ESTIMATE", fxSnapshotId: "fx-proof" },
      renderedText: "按已记录汇率估算约为人民币 2100 元。",
      evidenceRefs: [evidence],
      offerRefs: ["offer-proof"],
    }] };
    const proofEnvelope: AssistantEnvelope = {
      outcome: "CHAT",
      addressedOpIds: ["inspect"],
      blocks: [{ type: "CLAIM", claimId: "price-proof" }],
      nextMoves: [],
    };
    const state: ConversationState = { revision: 1, status: "OPEN", goalRevision, dialogue: emptyDialogueState(), workingSet };
    expect(await first.stageAttemptDraft(claimed.id, claimed.attempt, claimed.fenceToken, {
      plan: proofPlan,
      goal: goalRevision,
      dialogue: state.dialogue,
      workingSet,
      envelope: proofEnvelope,
      claimLedger: proofLedger,
      evidenceKeys: [claimEvidenceKey(evidence)],
    })).toBe(true);
    await first.pool.query("UPDATE interec_agent.turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claimed.id]);
    const recovered = await first.claimTurn("worker-without-old-artifact", 30, claimed.id);
    expect(await first.markTurnRunning(recovered!.id, recovered!.attempt, recovered!.fenceToken)).toBe(true);
    expect(await first.stageAttemptDraft(recovered!.id, recovered!.attempt, recovered!.fenceToken, {
      plan: proofPlan,
      goal: goalRevision,
      dialogue: state.dialogue,
      workingSet,
      envelope: proofEnvelope,
      claimLedger: proofLedger,
      evidenceKeys: [],
    })).toBe(true);
    await expect(first.commitTurn({
      turnId: recovered!.id,
      attempt: recovered!.attempt,
      fenceToken: recovered!.fenceToken,
      state,
      plan: proofPlan,
      envelope: proofEnvelope,
      claimLedger: proofLedger,
      renderedText: renderAssistantEnvelope(proofEnvelope, proofLedger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    })).rejects.toMatchObject({ code: "EVIDENCE_OUTSIDE_ATTEMPT" });
    expect((await first.getSnapshot(conversation.id, owner))?.revision).toBe(0);
  });

  it("publishes undo as a new monotone conversation revision pointing to the exact prior state", async () => {
    const conversation = await first.createConversation(owner);
    const initial = await start(first, conversation.id, owner);
    const firstState = initialPublication();
    await stageChat(first, initial, firstState);
    expect(await first.commitTurn({
      turnId: initial.id,
      attempt: initial.attempt,
      fenceToken: initial.fenceToken,
      state: firstState,
      plan,
      envelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(envelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    })).toMatchObject({ conversationRevision: 1 });

    const accepted = await first.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: randomUUID(),
      expectedRevision: 1,
      input: { type: "UNDO", revision: 0 },
    });
    const undo = await first.claimTurn("worker-undo", 30, accepted.id);
    expect(await first.markTurnRunning(undo!.id, undo!.attempt, undo!.fenceToken)).toBe(true);
    const undoPlan: TurnPlan = { userIntentSummary: "undo the previous revision", ops: [{ opId: "undo", kind: "UNDO_REVISION", revision: 0 }], leftover: [] };
    const undoEnvelope: AssistantEnvelope = {
      outcome: "CHAT",
      addressedOpIds: ["undo"],
      blocks: [{ type: "TRANSITION", text: "已撤销上一轮状态修改，我们可以从之前的上下文继续。" }],
      nextMoves: [],
    };
    const undoState: ConversationState = { revision: 2, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet: null };
    expect(await first.stageAttemptDraft(undo!.id, undo!.attempt, undo!.fenceToken, {
      plan: undoPlan,
      goal: null,
      dialogue: undoState.dialogue,
      workingSet: null,
      envelope: undoEnvelope,
      claimLedger: ledger,
      evidenceKeys: [],
    })).toBe(true);
    const committed = await first.commitTurn({
      turnId: undo!.id,
      attempt: undo!.attempt,
      fenceToken: undo!.fenceToken,
      state: undoState,
      plan: undoPlan,
      envelope: undoEnvelope,
      claimLedger: ledger,
      renderedText: renderAssistantEnvelope(undoEnvelope, ledger),
      allowedQuestionSlotIds: new Set(),
      allowedDisclosureCodes: new Set(),
    });
    expect(committed).toMatchObject({ committed: true, conversationRevision: 2 });
    const undoEntry = await first.pool.query<{ from_revision: string; to_revision: string }>("SELECT from_revision, to_revision FROM interec_agent.undo_entries WHERE turn_id = $1", [undo!.id]);
    expect(undoEntry.rows[0]).toEqual({ from_revision: "1", to_revision: "0" });
    expect((await first.getSnapshot(conversation.id, owner))?.revision).toBe(2);
  });

  it("runs a fresh faux pi-agent attempt through draft staging and atomic PostgreSQL publication", async () => {
    const conversation = await first.createConversation(owner);
    const accepted = await first.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: randomUUID(),
      input: { type: "MESSAGE", content: "想买个通勤耳机" },
    });
    const claimed = await first.claimTurn("worker-agent-vertical", 30, accepted.id);
    expect(await first.markTurnRunning(claimed!.id, claimed!.attempt, claimed!.fenceToken)).toBe(true);
    const session = createRepositoryTurnSession(first, claimed!, {
      researchNeed: "NOT_NEEDED",
      world: {
        inspect: async () => { throw new Error("INSPECT_NOT_EXPECTED"); },
        research: async () => { throw new Error("PROVIDER_CALL_NOT_ALLOWED"); },
      },
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "ask one high-impact clarification",
        ops: [{ opId: "ask-product", kind: "REQUEST_CLARIFICATION", slotId: "target_product", reasonCode: "HIGH_IMPACT_GAP" }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CLARIFICATION",
        blocks: [{ type: "QUESTION", slotId: "target_product" }],
        nextMoves: [],
      })),
    ]);
    const agentResult = await executeConversationTurn({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      host: session.host,
      context: {
        state: claimed!.snapshot,
        currentUserMessages: claimed!.inputMessages.map((message) => String(message.payload["content"] ?? "")),
        capabilities: ["clarification"],
        now: "2026-08-26T00:00:00.000Z",
        modelId: "faux-model",
        providerCallBudget: 0,
      },
      sessionId: `${claimed!.id}:${claimed!.attempt}`,
    });
    expect(agentResult).toMatchObject({ modelInferences: 2, toolCalls: 2, usedFallback: false, envelope: { outcome: "CLARIFICATION" } });
    expect(session.getCommitResult()).toMatchObject({ committed: true, conversationRevision: 1 });
    const snapshot = await first.getSnapshot(conversation.id, owner);
    expect(snapshot).toMatchObject({ revision: 1, status: "OPEN", dialogue: { pendingClarification: { slotId: "target_product" } } });
    expect((await first.listMessages(conversation.id, owner, 0)).map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
  });

  it("runs typed goal controls through the Conversation worker without model or Provider calls", async () => {
    const conversation = await first.createConversation(owner);
    const accepted = await first.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: randomUUID(),
      input: {
        type: "PATCH_GOAL",
        operations: [
          { opId: "typed-target", kind: "GOAL_SET_TARGET", target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
          { opId: "typed-markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", markets: ["US", "SG"] },
        ],
      },
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const worker = new ConversationWorker(
      first,
      new PostgresConversationResearchRepository(first.pool),
      new PostgresProviderGovernor(first.pool),
      { search: async () => { throw new Error("PROVIDER_CALL_NOT_ALLOWED"); } },
      { getRate: async () => { throw new Error("FX_CALL_NOT_ALLOWED"); } },
      { model: faux.getModel(), streamFn: models.streamSimple.bind(models), apiKey: "test" },
      { workerId: "typed-worker" },
    );
    expect(await worker.runOnce(accepted.id)).toBe(true);
    expect(await first.getSnapshot(conversation.id, owner)).toMatchObject({
      revision: 1,
      goalRevision: { goal: { target: { canonicalModel: "WH-1000XM5" }, retrievalMarkets: ["SG", "US"] } },
    });
    expect((await first.listMessages(conversation.id, owner, 0)).map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
  });

  it("promotes only a proof-qualified research campaign with partial-provider evidence", async () => {
    // This test exercises proof persistence, not a circuit that may have been
    // opened by a previous local run. Freeze the shared provider precondition
    // so the result does not depend on historical database state.
    await first.pool.query(
      `UPDATE interec_agent.provider_circuits
       SET consecutive_failures = 0, open_until = NULL, updated_at = clock_timestamp()
       WHERE provider IN ('buywhere', 'fxratesapi')`,
    );
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner, randomUUID(), "想买全新 Sony WH-1000XM5 耳机，比较美国和新加坡");
    const productSource = {
      search: async (_query: string, market: "US" | "SG") => {
        if (market === "SG") throw new Error("BUYWHERE_HTTP_503");
        const data = [1, 2, 3].map((index) => ({
          id: `sony-${index}`,
          title: "Brand New Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
          price: { amount: String(290 + index), currency: "USD" },
          merchant: `Merchant ${index}`,
          url: `https://merchant${index}.us/products/sony-wh1000xm5`,
          click_url: `https://buywhere.ai/api/click?url=https%3A%2F%2Fmerchant${index}.us%2Fproducts%2Fsony-wh1000xm5`,
          country_code: "US",
          category_path: ["Electronics", "Headphones"],
          availability: { in_stock: true },
        }));
        const rawPayload = { data };
        return {
          market,
          products: data,
          artifactRef: `sha256:${createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex")}`,
          rawPayload,
          observedAt: "2026-08-01T00:00:00.123Z",
        };
      },
    };
    const fxSource = {
      getRate: async (base: string) => ({
        id: randomUUID(), base, quote: "CNY" as const, rate: "7", provider: "test-fx",
        observedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-27T00:00:00.000Z",
      }),
    };
    const researchRepository = new PostgresConversationResearchRepository(first.pool);
    const world = new ConversationResearchWorld(
      claimed,
      first,
      researchRepository,
      new PostgresProviderGovernor(first.pool),
      productSource,
      fxSource,
    );
    const session = createRepositoryTurnSession(first, claimed, { researchNeed: "INSUFFICIENT_COVERAGE", world });
    const committed = await session.host.commitPlan({
      userIntentSummary: "set the target and research two markets",
      ops: [
        { opId: "target", kind: "GOAL_SET_TARGET", sourceMessageOrdinal: 0, target: { categoryId: "headphones", canonicalModel: "WH-1000XM5", itemRole: "PRIMARY_PRODUCT", condition: "NEW" } },
        { opId: "markets", kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal: 0, markets: ["US", "SG"] },
        { opId: "research", kind: "RESEARCH_OFFERS", reasonCode: "INSUFFICIENT_COVERAGE", queryVariant: "Sony WH-1000XM5 headphones" },
      ],
      leftover: [],
    });
    const receipts = [];
    for (const operation of committed.plan.ops) receipts.push(await session.host.executeOperation(operation));
    const researchReceipt = receipts.at(-1)!;
    const priceClaim = (researchReceipt.publicResult["claims"] as Array<{ claimId: string; kind: string }>).find((claim) => claim.kind === "PRICE")!;
    const observationPrecision = await first.pool.query<{ artifact_observed_at: string; fact_observed_at: string; listing_observed_at: string; fact_kind: string; fact_path: string }>(
      `SELECT pa.observed_at AS artifact_observed_at, sf.observed_at AS fact_observed_at,
              sl.listing_json->>'observedAt' AS listing_observed_at, sf.fact_kind, sf.json_path AS fact_path
       FROM interec_agent.source_facts sf
       JOIN interec_agent.provider_artifacts pa ON pa.id = sf.artifact_id
       JOIN interec_agent.source_listings sl ON sl.artifact_id = pa.id
       WHERE sf.turn_id = $1 ORDER BY sf.fact_kind, sf.json_path`,
      [claimed.id],
    );
    expect(observationPrecision.rows.map((row) => ({ ...row,
      artifact_observed_at: new Date(row.artifact_observed_at).toISOString(),
      fact_observed_at: new Date(row.fact_observed_at).toISOString(),
    }))).toEqual(expect.arrayContaining([expect.objectContaining({
      artifact_observed_at: "2026-08-01T00:00:00.123Z",
      fact_observed_at: "2026-08-01T00:00:00.123Z",
      listing_observed_at: "2026-08-01T00:00:00.123Z",
    })]));
    expect(new Set(observationPrecision.rows.map((row) => new Date(row.fact_observed_at).toISOString()))).toEqual(new Set(["2026-08-01T00:00:00.123Z"]));
    await session.host.publishReply({
      outcome: "RECOMMENDATION",
      blocks: [
        { type: "CLAIM", claimId: priceClaim.claimId },
        { type: "DISCLOSURE", disclosureCode: "PARTIAL_PROVIDER_COVERAGE" },
      ],
      nextMoves: [],
    });
    expect(session.getCommitResult()).toMatchObject({ committed: true, conversationRevision: 1 });
    const snapshot = await first.getSnapshot(conversation.id, owner);
    expect(snapshot?.workingSet?.pool).toHaveLength(3);
    const proof = await first.pool.query<{ status: string; promoted_revision: string; failed_markets: number; published_evidence: number }>(
      `SELECT cs.status, cs.promoted_revision,
              (SELECT count(*) FROM interec_agent.market_searches ms
               JOIN interec_agent.research_waves rw ON rw.id = ms.research_wave_id
               WHERE rw.turn_id = $1 AND ms.status = 'FAILED')::int AS failed_markets,
              (SELECT count(*) FROM interec_agent.published_claim_evidence pce
               JOIN interec_agent.published_claims pc ON pc.id = pce.published_claim_id
               JOIN interec_agent.assistant_responses ar ON ar.id = pc.response_id
               WHERE ar.turn_id = $1)::int AS published_evidence
       FROM interec_agent.comparison_sets cs WHERE cs.turn_id = $1`,
      [claimed.id],
    );
    expect(proof.rows[0]).toMatchObject({ status: "PROMOTED", promoted_revision: "1", failed_markets: 1 });
    expect(proof.rows[0]!.published_evidence).toBeGreaterThan(0);
    await expect(researchRepository.loadLatestPromotedResearchCoverage(owner, conversation.id)).resolves.toMatchObject({
      waveNo: 1,
      status: "PARTIAL",
      promotedRevision: 1,
      coverage: { completedMarkets: ["US"], failedMarkets: ["SG"] },
      marketOutcomes: expect.arrayContaining([
        { market: "SG", status: "FAILED", resultCount: 0 },
        { market: "US", status: "COMPLETED", resultCount: 3 },
      ]),
    });
    await expect(researchRepository.loadLatestPromotedResearchCoverage(
      { tenantId: owner.tenantId, ownerId: randomUUID() },
      conversation.id,
    )).resolves.toBeNull();
    await expect(first.pool.query(
      `UPDATE interec_agent.source_facts SET canonical_value = '"tampered"'::jsonb WHERE turn_id = $1`,
      [claimed.id],
    )).rejects.toThrow(/PROMOTED_PROOF_IMMUTABLE/);
    const cleaned = await researchRepository.cleanExpiredArtifacts();
    expect(cleaned.purged).toBeGreaterThan(0);
    const retainedProof = await first.pool.query<{ payload_json: unknown; facts: number }>(
      `SELECT pa.payload_json,
              (SELECT count(*) FROM interec_agent.source_facts sf WHERE sf.turn_id = $1)::int AS facts
       FROM interec_agent.provider_artifacts pa WHERE pa.turn_id = $1 LIMIT 1`,
      [claimed.id],
    );
    expect(retainedProof.rows[0]).toMatchObject({ payload_json: null });
    expect(retainedProof.rows[0]!.facts).toBeGreaterThan(0);
  });

  it("enforces provider bulkhead, retry budget, tenant quota and circuit state atomically", async () => {
    const conversation = await first.createConversation(owner);
    const claimed = await start(first, conversation.id, owner);
    const provider = `governor-${randomUUID()}`;
    const governor = new PostgresProviderGovernor(first.pool, {
      clusterConcurrency: 1,
      tenantConcurrency: 1,
      tenantRequestsPerMinute: 10,
      tenantRequestsPerDay: 10,
      retryBudgetPerTurn: 1,
      circuitFailureThreshold: 2,
      circuitOpenSeconds: 60,
    });
    const context = (stepKey: string, isRetry = false) => ({
      tenantId: owner.tenantId,
      turnId: claimed.id,
      attempt: claimed.attempt,
      fenceToken: claimed.fenceToken,
      stepKey,
      provider,
      isRetry,
    });
    const firstPermit = await governor.acquire(context("first"));
    await expect(governor.acquire(context("bulkhead"))).rejects.toMatchObject({ code: "PROVIDER_BULKHEAD_FULL" });
    await governor.release(firstPermit, { success: false, errorCode: "UPSTREAM_503" });
    const retryPermit = await governor.acquire(context("retry-one", true));
    await governor.release(retryPermit, { success: false, errorCode: "UPSTREAM_503" });
    await expect(governor.acquire(context("retry-two", true))).rejects.toMatchObject({ code: "PROVIDER_CIRCUIT_OPEN" });
    const circuit = await first.pool.query<{ consecutive_failures: number; open: boolean }>(
      `SELECT consecutive_failures, open_until > clock_timestamp() AS open
       FROM interec_agent.provider_circuits WHERE provider = $1`,
      [provider],
    );
    expect(circuit.rows[0]).toMatchObject({ consecutive_failures: 2, open: true });

    const retryProvider = `retry-${randomUUID()}`;
    const retryGovernor = new PostgresProviderGovernor(first.pool, { retryBudgetPerTurn: 1, circuitFailureThreshold: 10 });
    const allowedRetry = await retryGovernor.acquire({ ...context("allowed-retry", true), provider: retryProvider });
    await retryGovernor.release(allowedRetry, { success: true });
    await expect(retryGovernor.acquire({ ...context("extra-retry", true), provider: retryProvider })).rejects.toMatchObject({ code: "PROVIDER_RETRY_BUDGET_EXHAUSTED" });

    const quotaProvider = `quota-${randomUUID()}`;
    const quotaGovernor = new PostgresProviderGovernor(first.pool, { tenantRequestsPerMinute: 1, tenantRequestsPerDay: 5 });
    const quotaPermit = await quotaGovernor.acquire({ ...context("quota-first"), provider: quotaProvider });
    await quotaGovernor.release(quotaPermit, { success: true });
    await expect(quotaGovernor.acquire({ ...context("quota-second"), provider: quotaProvider })).rejects.toMatchObject({ code: "TENANT_PROVIDER_RPM_EXCEEDED" });
  });

  it("detects immutable migration checksum drift", async () => {
    const directory = await mkdtemp(`${tmpdir()}${sep}interec-migration-`);
    try {
      const source = new URL("../conversation-migrations/0001_conversation_core.sql", import.meta.url);
      const changed = `${await readFile(source, "utf8")}\n-- forbidden rewrite\n`;
      await writeFile(`${directory}${sep}0001_conversation_core.sql`, changed, "utf8");
      await expect(runConversationMigrations(first.pool, pathToFileURL(`${directory}${sep}`))).rejects.toThrowError(/MIGRATION_CHECKSUM_MISMATCH/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes repository error codes as stable machine values", () => {
    const error = new ConversationRepositoryError("EXAMPLE", "example");
    expect(error).toMatchObject({ name: "ConversationRepositoryError", code: "EXAMPLE" });
  });
});
