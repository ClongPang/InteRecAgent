import { getActiveTraceId, propagateAttributes, startActiveObservation } from "@langfuse/tracing";

import { resolveTelemetryConfig, startTelemetry } from "./telemetry.js";

if (process.env["INTEREC_LANGFUSE_SMOKE_CONFIRM"] !== "authorized-single-trace") {
  throw new Error("INTEREC_LANGFUSE_SMOKE_CONFIRM_MUST_BE_authorized-single-trace");
}

const telemetry = await startTelemetry("interec-conversation-langfuse-smoke");
const telemetryConfig = resolveTelemetryConfig();
if (!telemetry.langfuseEnabled) {
  await telemetry.shutdown();
  throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
}

let traceId: string | undefined;
try {
  await propagateAttributes(
    {
      traceName: "langfuse-connectivity-smoke",
      environment: telemetryConfig.environment,
      tags: ["connectivity-smoke"],
      metadata: { engine: "pi-agent", containsBusinessRequest: "false" },
    },
    () => startActiveObservation(
      "langfuse-connectivity-smoke",
      async (observation) => {
        traceId = getActiveTraceId();
        observation.update({
          input: { kind: "synthetic-connectivity-check" },
          output: { status: "ok" },
          metadata: { externalProviderCalls: 0 },
        });
      },
      { asType: "agent" },
    ),
  );
  await telemetry.forceFlush({ strict: true });
  console.log(JSON.stringify({ sent: true, traceId, externalProviderCalls: 0 }, null, 2));
} finally {
  await telemetry.shutdown();
}
