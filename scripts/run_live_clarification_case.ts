import { createHmac, randomUUID } from "node:crypto";

if (process.env["INTEREC_LIVE_CASE_CONFIRM"] !== "authorized-external-cases") {
  throw new Error("INTEREC_LIVE_CASE_CONFIRM_MUST_BE_authorized-external-cases");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function tokenFor(tenantId: string, ownerId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: required("INTEREC_AUTH_ISSUER"),
    aud: required("INTEREC_AUTH_AUDIENCE"),
    tenant_id: tenantId,
    sub: ownerId,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  const input = `${header}.${payload}`;
  return `${input}.${createHmac("sha256", required("INTEREC_AUTH_HMAC_SECRET")).update(input).digest("base64url")}`;
}

const baseUrl = (process.env["INTEREC_LIVE_BASE_URL"]?.trim() || "http://127.0.0.1:8081").replace(/\/$/, "");
const token = tokenFor("live-clarification-v1", "structured-answer-acceptance");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function request(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}:${JSON.stringify(body)}`);
  return body as Record<string, any>;
}

async function waitForTurn(conversationId: string, turnId: string, minimumRevision: number): Promise<Record<string, any>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const projection = (await request(`/api/conversations/${conversationId}`, { headers }))["projection"];
    const latest = projection.latestTurn;
    if (latest?.id === turnId && ["FAILED", "CANCELLED", "TIMED_OUT", "DEAD_LETTER"].includes(latest.status)) {
      throw new Error(`LIVE_CLARIFICATION_TURN_FAILED:${latest.status}:${latest.errorCode ?? "UNKNOWN"}`);
    }
    if (latest?.id === turnId && latest.status === "COMPLETED" && Number(projection.state.revision) >= minimumRevision) return projection;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`LIVE_CLARIFICATION_TURN_TIMEOUT:${turnId}`);
}

const created = await request("/api/conversations", { method: "POST", headers, body: "{}" });
const conversationId = String(created["conversation"].id);
const first = await request(`/api/conversations/${conversationId}/turns`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    clientTurnId: `live-clarification-question-${randomUUID()}`,
    expectedRevision: 0,
    input: { type: "MESSAGE", content: "想买头戴式耳机，预算 3000 元以内。" },
  }),
});
const firstProjection = await waitForTurn(conversationId, String(first["turn"].id), 1);
const firstEnvelope = firstProjection.latestAssistantMessage?.payload?.envelope;
const firstGoal = firstProjection.state.goalRevision?.goal;
if (firstGoal?.target?.categoryId !== "headphones" || firstGoal.target.canonicalModel !== null) {
  throw new Error(`KNOWN_TARGET_NOT_PERSISTED_BEFORE_CLARIFICATION:${JSON.stringify(firstGoal?.target)}`);
}
if (firstGoal?.budget?.amount !== "3000" || firstGoal.budget.currency !== "CNY") {
  throw new Error(`KNOWN_BUDGET_NOT_PERSISTED_BEFORE_CLARIFICATION:${JSON.stringify(firstGoal?.budget)}`);
}
const question = firstEnvelope?.blocks?.find((block: Record<string, unknown>) => block["type"] === "QUESTION");
if (firstEnvelope?.outcome !== "CLARIFICATION") throw new Error(`EXPECTED_CLARIFICATION:${firstEnvelope?.outcome}`);
if (question?.clarification?.kind !== "PURCHASE_MARKET") throw new Error(`EXPECTED_PURCHASE_MARKET:${JSON.stringify(question)}`);
if (!String(question.wording ?? "").includes("美国") || !String(question.wording ?? "").includes("新加坡")) throw new Error("MARKET_GUIDANCE_MISSING");
if (String(question.wording ?? "").includes("关键选购条件")) throw new Error("GENERIC_CLARIFICATION_FALLBACK_REAPPEARED");
const optionIds = (question.responseSpec?.options ?? []).map((option: Record<string, unknown>) => option["id"]);
if (JSON.stringify(optionIds) !== JSON.stringify(["US", "SG", "US_SG"])) throw new Error(`AUTHORITATIVE_OPTIONS_MISMATCH:${JSON.stringify(optionIds)}`);

const second = await request(`/api/conversations/${conversationId}/turns`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    clientTurnId: `live-clarification-answer-${randomUUID()}`,
    expectedRevision: 1,
    input: {
      type: "ANSWER_CLARIFICATION",
      clarificationId: question.clarificationId,
      answer: { type: "OPTION", optionId: "US_SG" },
    },
  }),
});
const secondProjection = await waitForTurn(conversationId, String(second["turn"].id), 2);
const secondGoal = secondProjection.state.goalRevision?.goal;
if (JSON.stringify(secondGoal?.target) !== JSON.stringify(firstGoal.target)) {
  throw new Error(`TARGET_CHANGED_ACROSS_CLARIFICATION:${JSON.stringify({ before: firstGoal.target, after: secondGoal?.target })}`);
}
if (JSON.stringify(secondGoal?.budget) !== JSON.stringify(firstGoal.budget)) {
  throw new Error(`BUDGET_CHANGED_ACROSS_CLARIFICATION:${JSON.stringify({ before: firstGoal.budget, after: secondGoal?.budget })}`);
}
const markets = secondProjection.state.goalRevision?.goal?.retrievalMarkets ?? [];
if (JSON.stringify(markets) !== JSON.stringify(["SG", "US"])) throw new Error(`STRUCTURED_MARKET_MAPPING_FAILED:${JSON.stringify(markets)}`);
if (secondProjection.state.dialogue.pendingClarification !== null) throw new Error("CLARIFICATION_NOT_CLEARED");
const answerOutcome = secondProjection.latestAssistantMessage?.payload?.envelope?.outcome;
const answerBlocks = secondProjection.latestAssistantMessage?.payload?.envelope?.blocks ?? [];
const incompleteCoverageDisclosures = answerBlocks
  .filter((block: Record<string, unknown>) => block["type"] === "DISCLOSURE")
  .map((block: Record<string, unknown>) => String(block["disclosureCode"] ?? ""))
  .filter((code: string) => code === "PROVIDER_UNAVAILABLE"
    || code === "PARTIAL_PROVIDER_COVERAGE"
    || code === "UNVERIFIED_RESULTS_NOT_RECOMMENDED"
    || code.startsWith("SEARCH_COVERAGE_"));
const evidenceSafeCoverageFailure = answerOutcome === "CHAT" && incompleteCoverageDisclosures.length > 0;
if (!["RECOMMENDATION", "SEARCH_RESULTS", "NO_MATCH"].includes(String(answerOutcome)) && !evidenceSafeCoverageFailure) {
  throw new Error(`STRUCTURED_ANSWER_DID_NOT_CONTINUE_SEARCH:${answerOutcome ?? "MISSING"}`);
}

process.stdout.write(`${JSON.stringify({
  conversationId,
  questionTurnId: first["turn"].id,
  answerTurnId: second["turn"].id,
  question: {
    clarificationId: question.clarificationId,
    kind: question.clarification.kind,
    wording: question.wording,
    optionIds,
    allowSkip: question.responseSpec.allowSkip,
  },
  answerOutcome,
  incompleteCoverageDisclosures,
  retainedGoal: { target: secondGoal?.target, budget: secondGoal?.budget },
  markets,
  pendingClarification: secondProjection.state.dialogue.pendingClarification,
  candidateCount: secondProjection.state.workingSet?.pool?.length ?? 0,
})}\n`);
