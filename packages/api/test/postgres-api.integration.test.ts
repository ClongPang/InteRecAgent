import { createHash, randomUUID } from "node:crypto";

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  ConversationWorker,
  PostgresConversationRepository,
  PostgresProviderCallController,
  PostgresQuoteLookupRepository,
  QUOTE_PROVIDER_CONTRACT_VERSION,
  retailPriceEnvironmentValue,
  runConversationMigrations,
  type OwnerClaims,
  type QuoteProviderResult,
} from "@retail-price/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConversationApp } from "../src/app.js";
import type { IdentityVerifier } from "../src/auth.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = retailPriceEnvironmentValue(process.env, "DATABASE_URL")
  ?? "postgresql://retail_price:retail_price@127.0.0.1:5432/retail_price";

function quoteProviderResult(): QuoteProviderResult {
  const records = [{
    id: "api-quote-record",
    title: "Sony WH-1000XM5 Wireless Headphones",
    price: { amount: "399.90", currency: "SGD" },
    merchant: "Example Shop",
    url: "https://shop.example/product/wh-1000xm5?sku=black",
    outbound_url: "https://shop.example/product/wh-1000xm5?sku=black&utm_source=buywhere",
  }];
  const rawPayload = { best_price: records[0], alternatives: [], meta: { status: "ok" } };
  return {
    status: "OK_RESULTS",
    records,
    meta: { status: "ok", emptinessReason: null, confidence: null, engineStatus: null, raw: { status: "ok" } },
    failure: null,
    rawPayload,
    artifactRef: `sha256:${createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex")}`,
    observedAt: "2026-09-01T05:00:00.000Z",
    providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
  };
}

suite("PostgreSQL quote Conversation API vertical slice", () => {
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
    await repository.pool.query("UPDATE retail_price_agent.conversations SET active_turn_id = NULL WHERE tenant_id = $1", [owner.tenantId]);
    await repository.pool.query("DELETE FROM retail_price_agent.conversations WHERE tenant_id = $1", [owner.tenantId]);
    await repository.close();
  });

  it("publishes one evidence-backed quote turn and resumes its event stream", async () => {
    const headers = { authorization: "Bearer owner" };
    const created = await app.inject({ method: "POST", url: "/api/conversations", headers });
    expect(created.statusCode).toBe(201);
    expect(created.json().conversation.contractVersion).toBe("quote-leads-sg-v1");
    const conversationId = created.json().conversation.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/turns`,
      headers,
      payload: { clientTurnId: "api-turn-1", expectedRevision: 0, input: { type: "MESSAGE", content: "Sony WH-1000XM5 headphones" } },
    });
    expect(accepted.statusCode).toBe(202);
    const turnId = accepted.json().turn.id as string;

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("commit_quote_plan", {
        userIntentSummary: "look up the exact known model",
        ops: [
          {
            opId: "set-target",
            kind: "SET_QUOTE_TARGET",
            sourceMessageOrdinal: 0,
            identityHypothesis: {
              sourceMessageOrdinal: 0,
              model: { value: "WH-1000XM5", span: { start: 5, end: 15 } },
              brand: { value: "Sony", span: { start: 0, end: 4 } },
              productType: { value: "headphones", span: { start: 16, end: 26 } },
              qualifiers: [],
              selectedVariantRef: "variant_sony_wh1000xm5",
              confidence: 0.99,
            },
            target: {
              proposedModel: "WH-1000XM5",
              brand: "Sony",
              productType: "headphones",
              requiredQualifiers: [],
              conditionPreference: "ANY",
            },
          },
          { opId: "lookup", kind: "LOOKUP_QUOTES" },
        ],
      })),
    ]);
    const worker = new ConversationWorker(
      repository,
      new PostgresProviderCallController(repository.pool),
      { getRate: async () => { throw new Error("FX_UNAVAILABLE"); } },
      { lookup: async () => quoteProviderResult() },
      { model: faux.getModel(), streamFn: models.streamSimple.bind(models), apiKey: "test" },
      { workerId: "api-quote-vertical-worker" },
    );
    expect(await worker.runOnce(turnId)).toBe(true);
    expect(await repository.getTurn(turnId, owner)).toMatchObject({ status: "COMPLETED", errorCode: null });

    const projection = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers });
    expect(projection.statusCode).toBe(200);
    expect(projection.json().projection).toMatchObject({
      conversation: { id: conversationId, contractVersion: "quote-leads-sg-v1", currentRevision: 1 },
      activeTurn: null,
      state: {
        revision: 1,
        quote: {
          contractVersion: "quote-leads-sg-v1",
          target: {
            canonicalModel: "WH-1000XM5",
            identity: {
              strength: "CURATED_ALIAS",
              registryVersion: 1,
              variantRef: "variant_sony_wh1000xm5",
            },
          },
          leadSet: {
            outcome: "QUOTE_LEADS",
            providerStatus: "OK_RESULTS",
            leads: [{ quoteLeadRef: expect.any(String), outboundUrl: expect.stringContaining("https://") }],
          },
        },
      },
      latestAssistantMessage: {
        role: "ASSISTANT",
        payload: { outcome: "QUOTE_LEADS", envelope: { outcome: "QUOTE_LEADS" } },
      },
    });
    expect(JSON.stringify(projection.json().projection.state.quote)).not.toContain("rawRecord");
    expect(JSON.stringify(projection.json().projection.state.quote)).not.toContain("availability");
    const quoteLeadSetRef = projection.json().projection.state.quote.leadSet.quoteLeadSetRef as string;
    const persisted = await new PostgresQuoteLookupRepository(repository.pool)
      .loadQuoteLeadSet(owner, conversationId, quoteLeadSetRef);
    expect(persisted).toMatchObject({
      admissions: [{
        status: "ELIGIBLE",
        policyVersion: "quote-admission-v2",
        identityStrength: "CURATED_TITLE_ALIAS_MATCH",
        identityEvidenceRefs: expect.arrayContaining(["alias_user_sony_wh1000xm5"]),
      }],
      leads: [{
        admissionPolicyVersion: "quote-admission-v2",
        identityStrength: "CURATED_TITLE_ALIAS_MATCH",
        identityEvidenceRefs: expect.arrayContaining(["alias_user_sony_wh1000xm5"]),
      }],
    });
    const hidden = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers: { authorization: "Bearer other" } });
    expect(hidden.statusCode).toBe(404);

    const events = await repository.listEvents(conversationId, owner, 0);
    const cursor = events[0]!.seq;
    const stream = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/events`,
      headers: { ...headers, "last-event-id": String(cursor) },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).not.toContain(`id: ${cursor}\n`);
    for (const event of events.slice(1)) expect(stream.body).toContain(`id: ${event.seq}\nevent: ${event.eventType}`);
  });
});
