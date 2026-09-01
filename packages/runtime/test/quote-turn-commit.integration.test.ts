import { createHash, randomUUID } from "node:crypto";

import {
  projectPublishedQuoteLeadSet,
  resolveQuoteTarget,
  reviewQuoteTurnPlan,
  type QuoteAssistantPublication,
  type QuoteConversationState,
  type QuoteTurnPlan,
} from "@interec/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresConversationRepository,
  PostgresQuoteLookupRepository,
  QUOTE_PROVIDER_CONTRACT_VERSION,
  QuoteLookupService,
  buildQuoteProvenance,
  runConversationMigrations,
  type OwnerClaims,
  type QuoteProviderResult,
} from "../src/index.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = process.env["INTEREC_DATABASE_URL"] ?? "postgresql://interec:interec@127.0.0.1:5432/interec";

function providerResult(): QuoteProviderResult {
  const records = [{
    id: "commit-record-1",
    title: "Sony WH-1000XM5 Wireless Headphones",
    price: { amount: "399.90", currency: "SGD" },
    merchant: "Example Shop",
    url: "https://shop.example/product/wh-1000xm5?sku=black",
    outbound_url: "https://shop.example/out/wh-1000xm5",
  }];
  const rawPayload = { best_price: records[0], alternatives: [], meta: { status: "ok" } };
  return {
    status: "OK_RESULTS",
    records,
    meta: { status: "ok", emptinessReason: null, confidence: null, engineStatus: null, raw: { status: "ok" } },
    failure: null,
    rawPayload,
    artifactRef: `sha256:${createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex")}`,
    observedAt: "2026-09-01T06:00:00.000Z",
    providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
  };
}

async function fixture(repository: PostgresConversationRepository, owner: OwnerClaims) {
  const conversation = await repository.createConversation(owner);
  const accepted = await repository.acceptTurn({
    conversationId: conversation.id,
    owner,
    clientTurnId: randomUUID(),
    input: { type: "MESSAGE", content: "Sony WH-1000XM5 headphones" },
  });
  const claimed = await repository.claimTurn(`quote-commit-${randomUUID()}`, 30, accepted.id);
  if (!claimed) throw new Error("fixture claim failed");
  if (!await repository.markTurnRunning(claimed.id, claimed.attempt, claimed.fenceToken)) throw new Error("fixture start failed");
  const targetResolution = resolveQuoteTarget({
    rawText: "Sony WH-1000XM5 headphones",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  if (targetResolution.status !== "RESOLVED") throw new Error("fixture target failed");
  const execution = await new QuoteLookupService({ lookup: async () => providerResult() }).lookup(targetResolution);
  if (execution.status !== "LOOKUP_COMPLETED") throw new Error("fixture lookup failed");
  const saved = await new PostgresQuoteLookupRepository(repository.pool).saveQuoteLookup(claimed, execution, buildQuoteProvenance(execution.leadSet));
  const leadSet = projectPublishedQuoteLeadSet(execution.leadSet);
  const state: QuoteConversationState = {
    contractVersion: "quote-leads-sg-v1",
    version: 1,
    target: targetResolution.target,
    pendingTargetConfirmation: null,
    leadSet,
    displayQuoteLeadRefs: leadSet.leads.map((lead) => lead.quoteLeadRef),
    excludedQuoteLeadRefs: [],
    comparisonQuoteLeadRefs: [],
    focusQuoteLeadRef: null,
  };
  const plan: QuoteTurnPlan = {
    userIntentSummary: "look up exact model",
    ops: [
      {
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        source: { messageId: claimed.inputMessages[0]!.id },
        target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: "headphones", requiredQualifiers: [], conditionPreference: "ANY" },
      },
      { opId: "lookup", kind: "LOOKUP_QUOTES" },
    ],
  };
  const review = reviewQuoteTurnPlan({
    plan,
    state: claimed.snapshot.quote!,
    currentUserMessages: [{ messageId: claimed.inputMessages[0]!.id, content: "Sony WH-1000XM5 headphones" }],
  });
  if (review.decision !== "APPROVED") throw new Error(`fixture plan failed: ${review.violations[0]?.code}`);
  await repository.recordPlanReview({
    turnId: claimed.id,
    attempt: claimed.attempt,
    fenceToken: claimed.fenceToken,
    proposalNumber: 1,
    proposal: plan,
    reviewedPlan: plan,
    review,
    approvedPlan: plan,
  });
  const reply: QuoteAssistantPublication = {
    outcome: "QUOTE_LEADS",
    addressedOpIds: ["target", "lookup"],
    disclosureCodes: ["MERCHANT_PAGE_CHECK_REQUIRED", "AFFILIATE_LINK_DISCLOSURE"],
    text: "已记录这次报价观测，共发布 1 个报价线索。原币价格、成色和入口见报价区；请打开商家页确认最终价格、准确型号/版本、成色与是否可购买。部分入口可能是推广或联盟链接。",
  };
  return { conversation, claimed, state, plan, reply, saved };
}

suite("PostgreSQL quote turn atomic publication", () => {
  const repository = new PostgresConversationRepository(databaseUrl, 4);
  const owner: OwnerClaims = { tenantId: `quote-commit-it-${randomUUID()}`, ownerId: `owner-${randomUUID()}` };

  beforeAll(async () => runConversationMigrations(repository.pool));
  afterAll(async () => {
    await repository.pool.query("UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE tenant_id = $1", [owner.tenantId]);
    await repository.pool.query("DELETE FROM interec_agent.conversations WHERE tenant_id = $1", [owner.tenantId]);
    await repository.close();
  });

  it("atomically promotes evidence, revision, quote state and assistant message and hydrates after restart", async () => {
    const value = await fixture(repository, owner);
    await repository.stageAttemptDraft(value.claimed.id, value.claimed.attempt, value.claimed.fenceToken, {
      quotePlan: value.plan,
      quoteState: value.state,
      quoteReply: value.reply,
    });
    await expect(repository.commitQuoteTurn({
      turnId: value.claimed.id,
      attempt: value.claimed.attempt,
      fenceToken: value.claimed.fenceToken,
      conversationStatus: "OPEN",
      state: value.state,
      plan: value.plan,
      reply: value.reply,
    })).resolves.toMatchObject({ committed: true, conversationRevision: 1 });
    const graph = await repository.pool.query<Record<string, unknown>>(
      `SELECT qls.status, qls.published_revision, cr.quote_state_version_id,
              (SELECT count(*)::int FROM interec_agent.assistant_responses WHERE turn_id = $2) AS responses
       FROM interec_agent.quote_lead_sets qls
       JOIN interec_agent.conversation_revisions cr ON cr.conversation_id = qls.conversation_id AND cr.revision = 1
       WHERE qls.id = $1`,
      [value.saved.quoteLeadSetId, value.claimed.id],
    );
    expect(graph.rows[0]).toMatchObject({ status: "PUBLISHED", published_revision: "1", responses: 1 });
    expect(graph.rows[0]?.["quote_state_version_id"]).toBeTruthy();

    const restarted = new PostgresConversationRepository(databaseUrl, 2);
    try {
      await expect(restarted.getSnapshot(value.conversation.id, owner)).resolves.toMatchObject({
        revision: 1,
        quote: { version: 1, leadSet: { quoteLeadSetRef: value.state.leadSet!.quoteLeadSetRef } },
      });
    } finally {
      await restarted.close();
    }
  });

  it("rolls back every publication row and leaves evidence DRAFT when public state validation fails", async () => {
    const value = await fixture(repository, owner);
    const invalid = structuredClone(value.state) as QuoteConversationState & { stock?: string };
    invalid.stock = "IN_STOCK";
    await repository.stageAttemptDraft(value.claimed.id, value.claimed.attempt, value.claimed.fenceToken, {
      quotePlan: value.plan,
      quoteState: invalid,
      quoteReply: value.reply,
    });
    await expect(repository.commitQuoteTurn({
      turnId: value.claimed.id,
      attempt: value.claimed.attempt,
      fenceToken: value.claimed.fenceToken,
      conversationStatus: "OPEN",
      state: invalid,
      plan: value.plan,
      reply: value.reply,
    })).rejects.toMatchObject({ code: "QUOTE_PUBLIC_FIELD_FORBIDDEN" });
    const result = await repository.pool.query<Record<string, unknown>>(
      `SELECT c.current_revision, qls.status,
              (SELECT count(*)::int FROM interec_agent.quote_state_versions WHERE conversation_id = c.id) AS quote_states,
              (SELECT count(*)::int FROM interec_agent.assistant_responses WHERE turn_id = $2) AS responses
       FROM interec_agent.conversations c
       JOIN interec_agent.quote_lead_sets qls ON qls.conversation_id = c.id
       WHERE qls.id = $1`,
      [value.saved.quoteLeadSetId, value.claimed.id],
    );
    expect(result.rows[0]).toMatchObject({ current_revision: "0", status: "DRAFT", quote_states: 0, responses: 0 });
    expect(await repository.failTurn(value.claimed.id, value.claimed.attempt, value.claimed.fenceToken, "EXPECTED_TEST_FAILURE")).toBe(true);
  });
});
