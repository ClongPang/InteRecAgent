import { createHash, randomUUID } from "node:crypto";

import { resolveQuoteTarget } from "@retail-price/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresConversationRepository,
  PostgresQuoteLookupRepository,
  QUOTE_PROVIDER_CONTRACT_VERSION,
  QuoteLookupService,
  buildQuoteProvenance,
  retailPriceEnvironmentValue,
  runConversationMigrations,
  type ClaimedConversationTurn,
  type OwnerClaims,
  type QuoteProvider,
  type QuoteProviderResult,
} from "../src/index.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = retailPriceEnvironmentValue(process.env, "DATABASE_URL")
  ?? "postgresql://retail_price:retail_price@127.0.0.1:5432/retail_price";

function providerResult(): QuoteProviderResult {
  const records = [
    {
      id: "quote-record-1",
      title: "Sony WH-1000XM5 Wireless Headphones",
      price: { amount: "399.90", currency: "SGD" },
      merchant: "Example Shop",
      url: "https://shop.example/product/wh-1000xm5?sku=black&utm_source=one",
      outbound_url: "https://shop.example/product/wh-1000xm5?sku=black&utm_source=buywhere",
    },
    {
      id: "quote-record-2",
      title: "Sony WH-1000XM5 Wireless Headphones",
      price: { amount: "349.50", currency: "SGD" },
      merchant: "Example Shop",
      url: "https://shop.example/product/wh-1000xm5?sku=black&utm_campaign=two",
      outbound_url: "https://shop.example/product/wh-1000xm5?sku=black&utm_source=buywhere",
    },
    {
      id: "quote-record-accessory",
      title: "Replacement ear pads for Sony WH-1000XM5",
      price: { amount: "20", currency: "SGD" },
      merchant: "Parts Shop",
      url: "https://parts.example/wh-1000xm5-ear-pads",
    },
  ];
  const rawPayload = { best_price: records[0], alternatives: records.slice(1), meta: { status: "ok" } };
  const artifactRef = `sha256:${createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex")}`;
  return {
    status: "OK_RESULTS",
    records,
    meta: { status: "ok", emptinessReason: null, confidence: null, engineStatus: null, raw: { status: "ok" } },
    failure: null,
    rawPayload,
    artifactRef,
    observedAt: "2026-09-01T02:00:00.000Z",
    providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
  };
}

async function execution() {
  const provider: QuoteProvider = { lookup: async () => providerResult() };
  const resolution = resolveQuoteTarget({
    rawText: "Sony WH-1000XM5 headphones quote",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  const result = await new QuoteLookupService(provider).lookup(resolution);
  if (result.status !== "LOOKUP_COMPLETED") throw new Error("fixture target did not resolve");
  return result;
}

async function runningTurn(repository: PostgresConversationRepository, owner: OwnerClaims): Promise<ClaimedConversationTurn> {
  const conversation = await repository.createConversation(owner);
  const accepted = await repository.acceptTurn({
    conversationId: conversation.id,
    owner,
    clientTurnId: randomUUID(),
    input: { type: "MESSAGE", content: "Find Sony WH-1000XM5 headphones quote leads" },
  });
  const claimed = await repository.claimTurn(`quote-worker-${randomUUID()}`, 30, accepted.id);
  if (!claimed) throw new Error("fixture turn was not claimed");
  if (!await repository.markTurnRunning(claimed.id, claimed.attempt, claimed.fenceToken)) throw new Error("fixture turn was not started");
  return claimed;
}

suite("PostgreSQL quote lookup repository", () => {
  const conversations = new PostgresConversationRepository(databaseUrl, 4);
  const quotes = new PostgresQuoteLookupRepository(conversations.pool);
  const owner: OwnerClaims = { tenantId: `quote-it-${randomUUID()}`, ownerId: `owner-${randomUUID()}` };

  beforeAll(async () => {
    await runConversationMigrations(conversations.pool);
  });

  afterAll(async () => {
    await conversations.pool.query("UPDATE retail_price_agent.conversations SET active_turn_id = NULL WHERE tenant_id = $1 AND owner_id = $2", [owner.tenantId, owner.ownerId]);
    await conversations.pool.query("DELETE FROM retail_price_agent.conversations WHERE tenant_id = $1 AND owner_id = $2", [owner.tenantId, owner.ownerId]);
    await conversations.close();
  });

  it("atomically stores raw observations, admissions, one grouped lead and its evidence graph", async () => {
    const claimed = await runningTurn(conversations, owner);
    const result = await execution();
    const provenance = buildQuoteProvenance(result.leadSet);
    const saved = await quotes.saveQuoteLookup(claimed, result, provenance);
    expect(saved).toMatchObject({ quoteLeadSetRef: result.leadSet.quoteLeadSetRef, replayed: false });
    await expect(quotes.saveQuoteLookup(claimed, result, provenance)).resolves.toMatchObject({
      quoteLeadSetId: saved.quoteLeadSetId,
      replayed: true,
    });

    const counts = await conversations.pool.query<Record<string, unknown>>(
      `SELECT
         (SELECT count(*)::int FROM retail_price_agent.quote_observations WHERE lead_set_id = $1) AS observations,
         (SELECT count(*)::int FROM retail_price_agent.quote_observations WHERE lead_set_id = $1 AND admission_status = 'REJECTED') AS rejected,
         (SELECT count(*)::int FROM retail_price_agent.quote_leads WHERE lead_set_id = $1) AS leads,
         (SELECT count(*)::int FROM retail_price_agent.quote_lead_observations WHERE lead_set_id = $1) AS memberships,
         (SELECT count(*)::int FROM retail_price_agent.quote_claims WHERE lead_set_id = $1) AS claims,
         (SELECT count(*)::int FROM retail_price_agent.quote_claim_evidence WHERE lead_set_id = $1) AS evidence`,
      [saved.quoteLeadSetId],
    );
    expect(counts.rows[0]).toMatchObject({ observations: 3, rejected: 1, leads: 1, memberships: 2 });
    expect(Number(counts.rows[0]?.["claims"])).toBeGreaterThan(0);
    expect(Number(counts.rows[0]?.["evidence"])).toBeGreaterThanOrEqual(Number(counts.rows[0]?.["claims"]));
    expect(await quotes.loadQuoteLeadSet(owner, claimed.conversationId, result.leadSet.quoteLeadSetRef)).toEqual(result.leadSet);
    expect(await conversations.failTurn(claimed.id, claimed.attempt, claimed.fenceToken, "TEST_COMPLETED")).toBe(true);
  });

  it("rejects a stale fence before writing any quote evidence", async () => {
    const claimed = await runningTurn(conversations, owner);
    const result = await execution();
    const stale = { ...claimed, fenceToken: (BigInt(claimed.fenceToken) + 1n).toString() };
    await expect(quotes.saveQuoteLookup(stale, result, buildQuoteProvenance(result.leadSet))).rejects.toThrow("QUOTE_LOOKUP_FENCE_REJECTED");
    const count = await conversations.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM retail_price_agent.quote_lead_sets WHERE turn_id = $1",
      [claimed.id],
    );
    expect(count.rows[0]?.count).toBe(0);
    expect(await conversations.failTurn(claimed.id, claimed.attempt, claimed.fenceToken, "TEST_COMPLETED")).toBe(true);
  });

  it("rolls back the entire graph when a late source-fact serialization fails", async () => {
    const claimed = await runningTurn(conversations, owner);
    const result = await execution();
    const provenance = buildQuoteProvenance(result.leadSet);
    provenance.sourceFacts.at(-1)!.canonicalValue = undefined;
    await expect(quotes.saveQuoteLookup(claimed, result, provenance)).rejects.toThrow("QUOTE_PAYLOAD_NOT_JSON_SERIALIZABLE");
    const count = await conversations.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM retail_price_agent.quote_lead_sets WHERE turn_id = $1",
      [claimed.id],
    );
    expect(count.rows[0]?.count).toBe(0);
    expect(await conversations.failTurn(claimed.id, claimed.attempt, claimed.fenceToken, "TEST_COMPLETED")).toBe(true);
  });

  it("enforces owner RLS for quote lead sets", async () => {
    const claimed = await runningTurn(conversations, owner);
    const result = await execution();
    const saved = await quotes.saveQuoteLookup(claimed, result, buildQuoteProvenance(result.leadSet));
    const client = await conversations.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE retail_price_agent.quote_lead_sets FORCE ROW LEVEL SECURITY");
      await client.query(
        "SELECT set_config('retail_price.tenant_id', $1, true), set_config('retail_price.owner_id', $2, true)",
        [owner.tenantId, `other-${randomUUID()}`],
      );
      const hidden = await client.query("SELECT id FROM retail_price_agent.quote_lead_sets WHERE id = $1", [saved.quoteLeadSetId]);
      expect(hidden.rows).toEqual([]);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(await conversations.failTurn(claimed.id, claimed.attempt, claimed.fenceToken, "TEST_COMPLETED")).toBe(true);
  });
});
