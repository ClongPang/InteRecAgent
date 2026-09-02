import {
  observeTurnAttempt,
  resolveTelemetryConfig,
  startTelemetry,
} from "../packages/runtime/src/telemetry.js";
import { retailPriceEnvironmentValue } from "../packages/runtime/src/environment.js";

const CONFIRM = "authorized-langfuse-readback";

function skip(reason: string): never {
  console.log(`observability:smoke SKIP ${reason}`);
  process.exit(0);
}

const config = resolveTelemetryConfig();
if (!config.langfuseEnabled) skip("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are unset");
if (retailPriceEnvironmentValue(process.env, "LANGFUSE_SMOKE_CONFIRM") !== CONFIRM) {
  skip(`set RETAIL_PRICE_LANGFUSE_SMOKE_CONFIRM=${CONFIRM} to write and read back one probe trace`);
}

const probeId = `smoke-${Date.now().toString(16)}`;
const telemetry = await startTelemetry("retail-price-observability-smoke");
let traceId: string | undefined;
try {
  await observeTurnAttempt({
    turnId: probeId,
    conversationId: `smoke-conversation-${probeId}`,
    tenantId: "smoke-tenant",
    ownerId: "smoke-owner",
    attempt: 1,
    currentUserMessages: ["observability smoke probe"],
  }, async (active) => {
    traceId = active.traceId;
    return { status: "COMPLETED", committed: false };
  });
  const checkpoint = await telemetry.forceFlush({ strict: true });
  if (checkpoint.failures.length > 0) {
    throw new Error(`TELEMETRY_FORCE_FLUSH_FAILED:${checkpoint.failures.join(",")}`);
  }
} finally {
  await telemetry.shutdown({ strict: true });
}

if (!traceId) throw new Error("SMOKE_TRACE_ID_MISSING");

const baseUrl = (config.baseUrl ?? "https://cloud.langfuse.com").replace(/\/$/u, "");
const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
let lastStatus = 0;
for (let attempt = 0; attempt < 8; attempt += 1) {
  const response = await fetch(`${baseUrl}/api/public/traces/${traceId}`, {
    headers: { authorization },
  });
  lastStatus = response.status;
  if (response.ok) {
    const body = await response.json() as { id?: string };
    if (body.id !== traceId) throw new Error(`SMOKE_TRACE_ID_MISMATCH:${String(body.id)}`);
    console.log(`observability:smoke PASS traceId=${traceId}`);
    process.exit(0);
  }
  if (response.status !== 404) {
    throw new Error(`SMOKE_READBACK_FAILED:${response.status}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
}
throw new Error(`SMOKE_TRACE_NOT_FOUND:${traceId}:lastStatus=${lastStatus}`);
