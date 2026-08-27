import { createHmac, randomUUID } from "node:crypto";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function tokenFor(tenantId, ownerId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: required("INTEREC_AUTH_ISSUER"),
    aud: required("INTEREC_AUTH_AUDIENCE"),
    tenant_id: tenantId,
    sub: ownerId,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", required("INTEREC_AUTH_HMAC_SECRET")).update(input).digest("base64url");
  return `${input}.${signature}`;
}

const baseUrl = (process.env.INTEREC_LIVE_BASE_URL?.trim() || "http://127.0.0.1:8081").replace(/\/$/, "");
const tenantId = process.env.INTEREC_LIVE_TENANT?.trim() || "live-acceptance-v4";
const ownerId = process.env.INTEREC_LIVE_OWNER?.trim() || "browser-acceptance";
const token = tokenFor(tenantId, ownerId);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function createConversation() {
  const body = await request("/api/conversations", { method: "POST", headers, body: "{}" });
  return body.conversation.id;
}

async function load(conversationId) {
  return (await request(`/api/conversations/${conversationId}`, { headers })).projection;
}

async function sendMessage(conversationId, content, expectedRevision) {
  const accepted = await request(`/api/conversations/${conversationId}/turns`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientTurnId: `live-multicase-${randomUUID()}`,
      expectedRevision,
      input: { type: "MESSAGE", content },
    }),
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const projection = await load(conversationId);
    if (projection.latestTurn?.id === accepted.turn.id && ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DEAD_LETTER"].includes(projection.latestTurn.status)) {
      return projection;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`TURN_TIMEOUT:${accepted.turn.id}`);
}

function summary(caseId, turnNo, input, projection) {
  const message = projection.latestAssistantMessage?.payload ?? {};
  const goal = projection.state?.goalRevision?.goal ?? null;
  const set = projection.state?.workingSet ?? null;
  return {
    caseId,
    turnNo,
    conversationId: projection.conversation.id,
    input,
    status: projection.latestTurn?.status ?? null,
    errorCode: projection.latestTurn?.errorCode ?? null,
    revision: projection.state?.revision ?? null,
    outcome: message.envelope?.outcome ?? message.outcome ?? null,
    renderedText: message.text ?? null,
    blocks: message.envelope?.blocks ?? [],
    goal: goal && {
      target: goal.target,
      budget: goal.budget,
      retrievalMarkets: goal.retrievalMarkets,
      exclusions: goal.exclusions,
      unresolved: goal.unresolved,
    },
    dialogue: projection.state?.dialogue ?? null,
    workingSet: set && {
      displayOfferRefs: set.displayOfferRefs,
      rejectedOfferRefs: set.rejectedOfferRefs,
      focusOfferRef: set.focusOfferRef,
      comparisonOfferRefs: set.comparisonOfferRefs,
      candidates: set.pool.map((candidate) => ({
        offerRef: candidate.offerRef,
        title: candidate.title,
        canonicalModel: candidate.canonicalModel,
        categoryId: candidate.categoryId,
        itemRole: candidate.itemRole,
        condition: candidate.condition,
        market: candidate.retrievalMarket,
        cnyAmount: candidate.cnyAmount,
      })),
    },
  };
}

const cases = [
  {
    id: "A",
    messages: [
      "想买一款通勤用的降噪耳机",
      "预算 2500 元，比较美国和新加坡",
      "第二个为什么更贵？",
      "预算加到 3000，只看新加坡，而且不要第二个",
      "为什么选它？保修有吗？",
    ],
  },
  {
    id: "B",
    messages: [
      "想买 iPhone 16 Pro 256GB 新机，预算 9000 元，比较美国和新加坡",
      "第二个和第一个差在哪？",
      "只看美国",
    ],
  },
];

const selectedCase = process.env.INTEREC_LIVE_CASE?.trim().toUpperCase() || null;
const resumeConversationId = process.env.INTEREC_LIVE_CONVERSATION_ID?.trim() || null;
const startAt = Number(process.env.INTEREC_LIVE_START_AT?.trim() || "1");
if (!Number.isSafeInteger(startAt) || startAt < 1) throw new Error("INTEREC_LIVE_START_AT_INVALID");
for (const testCase of cases.filter((item) => !selectedCase || item.id === selectedCase)) {
  const conversationId = resumeConversationId || await createConversation();
  let revision = resumeConversationId ? (await load(conversationId)).state.revision : 0;
  for (let index = startAt - 1; index < testCase.messages.length; index += 1) {
    const input = testCase.messages[index];
    const projection = await sendMessage(conversationId, input, revision);
    const result = summary(testCase.id, index + 1, input, projection);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (projection.latestTurn?.status !== "COMPLETED") throw new Error(`CASE_${testCase.id}_TURN_${index + 1}_${projection.latestTurn?.status}`);
    revision = projection.state.revision;
  }
}
