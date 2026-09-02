import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ConversationRepositoryError,
  PostgresConversationRepository,
  runConversationMigrations,
  type OwnerClaims,
} from "../src/index.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = process.env["INTEREC_DATABASE_URL"] ?? "postgresql://interec:interec@127.0.0.1:5432/interec";

suite("PostgreSQL quote conversation lifecycle", () => {
  const repository = new PostgresConversationRepository(databaseUrl, 4);
  const owner: OwnerClaims = { tenantId: `quote-lifecycle-${randomUUID()}`, ownerId: `owner-${randomUUID()}` };

  beforeAll(async () => {
    await runConversationMigrations(repository.pool);
  });

  afterAll(async () => {
    await repository.pool.query(
      "UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE tenant_id = $1 AND owner_id = $2",
      [owner.tenantId, owner.ownerId],
    );
    await repository.pool.query(
      "DELETE FROM interec_agent.conversations WHERE tenant_id = $1 AND owner_id = $2",
      [owner.tenantId, owner.ownerId],
    );
    await repository.close();
  });

  it("creates only quote contracts and preserves idempotency, supersession, batching, and fences", async () => {
    const conversation = await repository.createConversation(owner);
    expect(conversation.contractVersion).toBe("quote-leads-sg-v1");
    await expect(repository.getConversation(conversation.id, { ...owner, ownerId: "another-owner" })).resolves.toBeNull();

    const firstInput = {
      conversationId: conversation.id,
      owner,
      clientTurnId: `client-${randomUUID()}`,
      expectedRevision: 0,
      input: { type: "MESSAGE" as const, content: "查 Sony WH-1000XM5 报价" },
    };
    const first = await repository.acceptTurn(firstInput);
    const replay = await repository.acceptTurn(firstInput);
    expect(replay).toMatchObject({ id: first.id, idempotentReplay: true });

    const second = await repository.acceptTurn({
      conversationId: conversation.id,
      owner,
      clientTurnId: `client-${randomUUID()}`,
      expectedRevision: 0,
      input: { type: "MESSAGE", content: "只看准确型号，不要相近款" },
      telemetryTraceId: "c".repeat(32),
      telemetryRootObservationId: "d".repeat(16),
    });
    expect(await repository.getTurn(first.id, owner)).toMatchObject({ status: "SUPERSEDED" });

    const claimed = await repository.claimTurn(`worker-${randomUUID()}`, 30, second.id);
    expect(claimed).not.toBeNull();
    expect(claimed).toMatchObject({ contractVersion: "quote-leads-sg-v1", snapshot: { revision: 0 } });
    expect(claimed!.telemetryEnqueueTraceId).toMatch(/^[0-9a-f]{32}$/);
    const enqueueTrace = await repository.pool.query<{
      trace_id: string;
      trace_id_source: string;
    }>(
      "SELECT trace_id, trace_id_source FROM interec_agent.turns WHERE id = $1",
      [second.id],
    );
    expect(enqueueTrace.rows[0]).toEqual({
      trace_id: "c".repeat(32),
      trace_id_source: "OBSERVED_ENQUEUE_ROOT",
    });
    expect(claimed!.inputMessages).toHaveLength(2);
    const beforeAttemptTrace = await repository.pool.query<{
      trace_id: string | null;
      root_observation_id: string | null;
      trace_id_source: string | null;
    }>(
      "SELECT trace_id, root_observation_id, trace_id_source FROM interec_agent.turn_attempts WHERE turn_id = $1 AND attempt = $2",
      [claimed!.id, claimed!.attempt],
    );
    expect(beforeAttemptTrace.rows[0]).toEqual({ trace_id: null, root_observation_id: null, trace_id_source: null });
    expect(await repository.markTurnRunning(claimed!.id, claimed!.attempt, claimed!.fenceToken)).toBe(true);
    const attemptTraceId = "a".repeat(32);
    const attemptRootObservationId = "b".repeat(16);
    expect(attemptTraceId).not.toBe(claimed!.telemetryEnqueueTraceId);
    expect(await repository.recordAttemptTelemetryLink(
      claimed!.id,
      claimed!.attempt,
      claimed!.fenceToken,
      attemptTraceId,
      attemptRootObservationId,
    )).toBe(true);
    const afterAttemptTrace = await repository.pool.query<{
      trace_id: string;
      root_observation_id: string;
      trace_id_source: string;
    }>(
      "SELECT trace_id, root_observation_id, trace_id_source FROM interec_agent.turn_attempts WHERE turn_id = $1 AND attempt = $2",
      [claimed!.id, claimed!.attempt],
    );
    expect(afterAttemptTrace.rows[0]).toEqual({
      trace_id: attemptTraceId,
      root_observation_id: attemptRootObservationId,
      trace_id_source: "OBSERVED_ATTEMPT_ROOT",
    });
    const syntheticLegacyRows = await repository.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM interec_agent.turns
       WHERE trace_id = md5('interec-turn-trace-v1:' || conversation_id::text || ':' || client_turn_id)`,
    );
    expect(syntheticLegacyRows.rows[0]?.count).toBe("0");
    expect(await repository.heartbeatTurn(claimed!.id, claimed!.attempt, `${Number(claimed!.fenceToken) + 1}`, 30)).toBe(false);
    expect(await repository.failTurn(claimed!.id, claimed!.attempt, claimed!.fenceToken, "TEST_FAILURE")).toBe(true);
    expect(await repository.getTurn(claimed!.id, owner)).toMatchObject({ status: "FAILED", errorCode: "TEST_FAILURE" });
  });

  it("makes persisted legacy conversations explicitly read-only and unclaimable", async () => {
    const legacyId = randomUUID();
    await repository.pool.query(
      `INSERT INTO interec_agent.conversations
         (id, tenant_id, owner_id, status, contract_version)
       VALUES ($1, $2, $3, 'OPEN', 'legacy-shopping-v1')`,
      [legacyId, owner.tenantId, owner.ownerId],
    );
    await expect(repository.getConversation(legacyId, owner)).rejects.toMatchObject<Partial<ConversationRepositoryError>>({
      code: "LEGACY_CONVERSATION_RETIRED",
    });
    await expect(repository.acceptTurn({
      conversationId: legacyId,
      owner,
      clientTurnId: `legacy-${randomUUID()}`,
      input: { type: "MESSAGE", content: "继续" },
    })).rejects.toMatchObject<Partial<ConversationRepositoryError>>({ code: "LEGACY_CONVERSATION_RETIRED" });
    await expect(repository.claimTurn(`worker-${randomUUID()}`, 30)).resolves.toBeNull();
  });
});
