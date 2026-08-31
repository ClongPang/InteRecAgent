import { createHmac, randomUUID } from "node:crypto";

import {
  BuyWhereClient,
  ConversationWorker,
  FxRatesClient,
  PostgresConversationRepository,
  PostgresConversationSearchRepository,
  PostgresProviderCallController,
  createPiModelRuntime,
  resolveBuyWhereRuntimeConfig,
  runConversationMigrations,
} from "../packages/runtime/src/index.js";

if (process.env["INTEREC_LIVE_CASE_CONFIRM"] !== "authorized-external-cases") {
  throw new Error("INTEREC_LIVE_CASE_CONFIRM_MUST_BE_authorized-external-cases");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) throw new Error(`${name}_INVALID`);
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
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", required("INTEREC_AUTH_HMAC_SECRET")).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

const cases = {
  HEADPHONES: [
    "想买 Sony WH-1000XM5 耳机，预算 2500 元，比较美国和新加坡",
    "只看美国，更偏好轻便的，保留当前候选",
    "不要当前排第一的候选",
  ],
  SMARTPHONE: [
    "想买 iPhone 16 Pro 256GB，比较美国和新加坡，不设预算",
    "只看美国，比较当前前两个候选",
  ],
  WASHER: [
    "想买前置式洗衣机，在美国市场找，偏好 10 公斤左右，不设预算",
    "更偏好节能和低噪音，基于当前候选重新排序",
  ],
} as const;

const selectedCase = (process.env["INTEREC_LIVE_CASE"]?.trim().toUpperCase() || "HEADPHONES") as keyof typeof cases;
if (!Object.hasOwn(cases, selectedCase)) throw new Error("INTEREC_LIVE_CASE_INVALID");
const startAt = integer("INTEREC_LIVE_START_AT", 1);
const maxTurns = integer("INTEREC_LIVE_MAX_TURNS", cases[selectedCase].length);
const baseUrl = (process.env["INTEREC_LIVE_BASE_URL"]?.trim() || "http://127.0.0.1:8082").replace(/\/$/, "");
const tenantId = process.env["INTEREC_LIVE_TENANT"]?.trim() || "live-external-v1";
const ownerId = process.env["INTEREC_LIVE_OWNER"]?.trim() || "exact-worker-acceptance";
const token = tokenFor(tenantId, ownerId);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function request(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}:${JSON.stringify(body)}`);
  return body as Record<string, any>;
}

const databaseUrl = required("INTEREC_DATABASE_URL");
const repository = new PostgresConversationRepository(databaseUrl);
await runConversationMigrations(repository.pool);
const buyWhere = resolveBuyWhereRuntimeConfig();
const worker = new ConversationWorker(
  repository,
  new PostgresConversationSearchRepository(repository.pool),
  new PostgresProviderCallController(repository.pool),
  new BuyWhereClient(buyWhere.apiKey, { timeoutMs: buyWhere.timeoutMs }),
  new FxRatesClient(),
  createPiModelRuntime(),
  { workerId: `live-exact-${randomUUID()}` },
);

try {
  let conversationId = process.env["INTEREC_LIVE_CONVERSATION_ID"]?.trim() || "";
  if (!conversationId) {
    const created = await request("/api/conversations", { method: "POST", headers, body: "{}" });
    conversationId = String(created["conversation"].id);
  }
  let projection = (await request(`/api/conversations/${conversationId}`, { headers }))["projection"];
  let revision = Number(projection.state.revision);
  const messages = cases[selectedCase].slice(startAt - 1, startAt - 1 + maxTurns);
  for (const [offset, content] of messages.entries()) {
    const turnNo = startAt + offset;
    const acceptedAt = performance.now();
    const accepted = await request(`/api/conversations/${conversationId}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientTurnId: `live-exact-${selectedCase.toLowerCase()}-${turnNo}-${randomUUID()}`,
        expectedRevision: revision,
        input: { type: "MESSAGE", content },
      }),
    });
    const turnId = String(accepted["turn"].id);
    if (!await worker.runOnce(turnId)) {
      // A separately running production-style worker may win the claim race.
      // Observe that exact turn to terminal state instead of claiming or
      // processing an unrelated queued turn.
      const waitDeadline = Date.now() + 120_000;
      while (Date.now() < waitDeadline) {
        const observed = (await request(`/api/conversations/${conversationId}`, { headers }))["projection"];
        if (observed.latestTurn?.id === turnId && observed.latestTurn.status === "COMPLETED") break;
        if (observed.latestTurn?.id === turnId && observed.latestTurn.status === "FAILED") {
          throw new Error(`LIVE_TURN_FAILED:${turnId}:${observed.latestTurn.errorCode ?? "UNKNOWN"}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    projection = (await request(`/api/conversations/${conversationId}`, { headers }))["projection"];
    if (projection.latestTurn?.id !== turnId || projection.latestTurn?.status !== "COMPLETED") {
      throw new Error(`LIVE_TURN_FAILED:${turnId}:${projection.latestTurn?.status ?? "MISSING"}:${projection.latestTurn?.errorCode ?? "UNKNOWN"}`);
    }
    revision = Number(projection.state.revision);
    const pool = projection.state.workingSet?.pool ?? [];
    const databaseEvidence = await repository.pool.query<{
      product_calls: number;
      fx_calls: number;
      artifacts: number;
      claims: number;
      feedback: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM interec_agent.tool_executions WHERE turn_id = $1 AND (step_key LIKE 'search:%:market:%' OR step_key LIKE 'research:%:market:%') AND status = 'SUCCEEDED') AS product_calls,
         (SELECT count(*)::int FROM interec_agent.tool_executions WHERE turn_id = $1 AND (step_key LIKE 'search:%:fx:%' OR step_key LIKE 'research:%:fx:%') AND status = 'SUCCEEDED') AS fx_calls,
         (SELECT count(*)::int FROM interec_agent.provider_artifacts WHERE turn_id = $1) AS artifacts,
         (SELECT count(*)::int FROM interec_agent.attempt_claims WHERE turn_id = $1) AS claims,
         (SELECT count(*)::int FROM interec_agent.candidate_feedback_events WHERE turn_id = $1) AS feedback`,
      [turnId],
    );
    const assistant = projection.latestAssistantMessage?.payload ?? {};
    process.stdout.write(`${JSON.stringify({
      caseId: selectedCase,
      turnNo,
      conversationId,
      turnId,
      durationMs: Math.round(performance.now() - acceptedAt),
      status: projection.latestTurn.status,
      outcome: assistant.envelope?.outcome ?? assistant.outcome ?? null,
      goal: projection.state.goalRevision?.goal ?? null,
      candidates: {
        total: pool.length,
        displayed: projection.state.workingSet?.displayOfferRefs?.length ?? 0,
        ranking: pool.filter((candidate: any) => candidate.ranking?.validationMode === "SEARCH_ONLY").length,
        verified: pool.filter((candidate: any) => candidate.ranking?.validationMode === "RULE_VALIDATED").length,
        offerOnly: pool.filter((candidate: any) => candidate.ranking?.identityResolution === "LISTING_LEVEL").length,
        sampleTitles: pool.slice(0, 3).map((candidate: any) => candidate.title),
      },
      databaseEvidence: databaseEvidence.rows[0],
    })}\n`);
  }
} finally {
  await repository.close();
}
