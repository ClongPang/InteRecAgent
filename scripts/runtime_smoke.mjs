import { createHmac, randomUUID } from "node:crypto";

if (process.env.INTEREC_RUNTIME_SMOKE_CONFIRM !== "authorized-local-state") {
  throw new Error("INTEREC_RUNTIME_SMOKE_CONFIRM_MUST_BE_authorized-local-state");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function tokenFor(ownerId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: required("INTEREC_AUTH_ISSUER"),
    aud: required("INTEREC_AUTH_AUDIENCE"),
    tenant_id: "runtime-smoke",
    sub: ownerId,
    exp: Math.floor(Date.now() / 1000) + 180,
  });
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", required("INTEREC_AUTH_HMAC_SECRET")).update(input).digest("base64url");
  return `${input}.${signature}`;
}

const baseUrl = (process.env.INTEREC_RUNTIME_SMOKE_BASE_URL?.trim() || "http://127.0.0.1:8081").replace(/\/$/, "");
const headers = { authorization: `Bearer ${tokenFor("owner-a")}`, "content-type": "application/json" };
const request = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { response, body };
};

const unauthenticated = await request("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
if (unauthenticated.response.status !== 401) throw new Error(`RUNTIME_SMOKE_AUTH_BOUNDARY_FAILED:${unauthenticated.response.status}`);

const created = await request("/api/conversations", { method: "POST", headers, body: "{}" });
if (created.response.status !== 201) throw new Error(`RUNTIME_SMOKE_CREATE_FAILED:${created.response.status}`);
const conversationId = created.body.conversation?.id;
if (typeof conversationId !== "string") throw new Error("RUNTIME_SMOKE_CONVERSATION_ID_MISSING");

const accepted = await request(`/api/conversations/${conversationId}/turns`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    clientTurnId: `runtime-smoke-${randomUUID()}`,
    expectedRevision: 0,
    input: {
      type: "PATCH_GOAL",
      operations: [{ opId: "stock-known", kind: "GOAL_SET_STOCK_PREFERENCE", preference: "KNOWN_IN_STOCK" }],
    },
  }),
});
if (accepted.response.status !== 202) throw new Error(`RUNTIME_SMOKE_TURN_NOT_ACCEPTED:${accepted.response.status}`);

let projection;
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  const result = await request(`/api/conversations/${conversationId}`, { headers });
  if (result.response.status !== 200) throw new Error(`RUNTIME_SMOKE_PROJECTION_FAILED:${result.response.status}`);
  projection = result.body.projection;
  if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DEAD_LETTER"].includes(projection?.latestTurn?.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (projection?.latestTurn?.status !== "COMPLETED") throw new Error(`RUNTIME_SMOKE_TURN_FAILED:${projection?.latestTurn?.status ?? "TIMEOUT"}`);
if (projection.state?.revision !== 1 || projection.conversation?.currentRevision !== 1) throw new Error("RUNTIME_SMOKE_REVISION_NOT_ATOMIC");
if (projection.state?.goalRevision?.goal?.stockPreference !== "KNOWN_IN_STOCK") throw new Error("RUNTIME_SMOKE_GOAL_NOT_PERSISTED");
if (projection.messages?.map((message) => message.role).join(",") !== "USER,ASSISTANT") throw new Error("RUNTIME_SMOKE_MESSAGE_LEDGER_INVALID");
if (projection.latestAssistantMessage?.payload?.envelope?.outcome !== "CHAT") throw new Error("RUNTIME_SMOKE_ASSISTANT_ENVELOPE_INVALID");

const otherOwner = await request(`/api/conversations/${conversationId}`, { headers: { authorization: `Bearer ${tokenFor("owner-b")}` } });
if (otherOwner.response.status !== 404) throw new Error(`RUNTIME_SMOKE_OWNER_ISOLATION_FAILED:${otherOwner.response.status}`);

process.stdout.write(`${JSON.stringify({
  conversationId,
  turnId: accepted.body.turn?.id,
  status: projection.latestTurn.status,
  revision: projection.state.revision,
  messageRoles: projection.messages.map((message) => message.role),
  ownerIsolation: "404",
  externalCalls: 0,
})}\n`);
