import { randomUUID } from "node:crypto";

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  ConversationWorker,
  PostgresConversationRepository,
  PostgresConversationResearchRepository,
  PostgresProviderGovernor,
  runConversationMigrations,
  type OwnerClaims,
} from "@interec/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConversationApp } from "../src/app.js";
import type { IdentityVerifier } from "../src/auth.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = process.env["INTEREC_DATABASE_URL"] ?? "postgresql://interec:interec@127.0.0.1:5432/interec";

suite("PostgreSQL Conversation API vertical slice", () => {
  const repository = new PostgresConversationRepository(databaseUrl, 6);
  const owner: OwnerClaims = { tenantId: `api-it-${randomUUID()}`, ownerId: `owner-${randomUUID()}` };
  const verifier: IdentityVerifier = {
    verify: async (request) => request.headers.authorization === "Bearer owner"
      ? owner
      : request.headers.authorization === "Bearer other"
        ? { ...owner, ownerId: "other-owner" }
        : null,
  };
  const app = createConversationApp({ repository, identityVerifier: verifier, ssePollMs: 1, sseMaxDurationMs: 5 });

  beforeAll(async () => runConversationMigrations(repository.pool));
  afterAll(async () => {
    await app.close();
    await repository.pool.query("UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE tenant_id = $1", [owner.tenantId]);
    await repository.pool.query("DELETE FROM interec_agent.conversations WHERE tenant_id = $1", [owner.tenantId]);
    await repository.close();
  });

  it("publishes one durable dialogue turn and resumes its Conversation event stream", async () => {
    const headers = { authorization: "Bearer owner" };
    const created = await app.inject({ method: "POST", url: "/api/conversations", headers });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/turns`,
      headers,
      payload: { clientTurnId: "api-turn-1", expectedRevision: 0, input: { type: "MESSAGE", content: "想买降噪耳机" } },
    });
    expect(accepted.statusCode).toBe(202);
    const turnId = accepted.json().turn.id as string;

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
        userIntentSummary: "ask the highest-impact target clarification",
        ops: [{ opId: "ask-model", kind: "REQUEST_CLARIFICATION", slotId: "target_model", reasonCode: "HIGH_IMPACT_GAP" }],
        leftover: [],
      })),
      fauxAssistantMessage(fauxToolCall("publish_reply", {
        outcome: "CLARIFICATION",
        blocks: [{ type: "QUESTION", slotId: "target_model" }],
        nextMoves: [],
      })),
    ]);
    const worker = new ConversationWorker(
      repository,
      new PostgresConversationResearchRepository(repository.pool),
      new PostgresProviderGovernor(repository.pool),
      { search: async () => { throw new Error("PROVIDER_CALL_NOT_ALLOWED"); } },
      { getRate: async () => { throw new Error("FX_CALL_NOT_ALLOWED"); } },
      { model: faux.getModel(), streamFn: models.streamSimple.bind(models), apiKey: "test" },
      { workerId: "api-vertical-worker" },
    );
    expect(await worker.runOnce(turnId)).toBe(true);

    const projection = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers });
    expect(projection.statusCode).toBe(200);
    expect(projection.json().projection).toMatchObject({
      conversation: { id: conversationId, currentRevision: 1 },
      activeTurn: null,
      state: { revision: 1, dialogue: { pendingClarification: { slotId: "target_model" } } },
      latestAssistantMessage: { role: "ASSISTANT", payload: { outcome: "CLARIFICATION", envelope: { outcome: "CLARIFICATION" } } },
    });
    const hidden = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers: { authorization: "Bearer other" } });
    expect(hidden.statusCode).toBe(404);

    const events = await repository.listEvents(conversationId, owner, 0);
    const cursor = events[0]!.seq;
    const stream = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/events`, headers: { ...headers, "last-event-id": String(cursor) } });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).not.toContain(`id: ${cursor}\n`);
    for (const event of events.slice(1)) expect(stream.body).toContain(`id: ${event.seq}\nevent: ${event.eventType}`);
  });
});
