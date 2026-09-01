import { randomUUID } from "node:crypto";

import { BuyWhereMcpQuoteClient } from "./buywhere-mcp-quote-client.js";
import { ConversationWorker } from "./conversation-worker.js";
import { FxRatesClient } from "./fx-provider.js";
import { createPiModelRuntime } from "./model-factory.js";
import { registerPostgresOperationalMetrics } from "./operational-metrics.js";
import { PostgresConversationRepository } from "./postgres-conversation-repository.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";
import { resolveBuyWhereRuntimeConfig } from "./runtime-config.js";
import { startTelemetry } from "./telemetry.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const databaseUrl = process.env["INTEREC_WORKER_DATABASE_URL"]?.trim() || required("INTEREC_DATABASE_URL");
const repository = new PostgresConversationRepository(databaseUrl);
const buyWhere = resolveBuyWhereRuntimeConfig();
const telemetry = await startTelemetry("interec-conversation-worker");
const operationalMetrics = registerPostgresOperationalMetrics(repository.pool);
const worker = new ConversationWorker(
  repository,
  new PostgresProviderCallController(repository.pool),
  new FxRatesClient(),
  new BuyWhereMcpQuoteClient(buyWhere.apiKey, { timeoutMs: buyWhere.timeoutMs }),
  createPiModelRuntime(),
  {
    workerId: process.env["INTEREC_WORKER_ID"]?.trim() || `worker-${randomUUID()}`,
  },
);
let stopping = false;
const stop = () => { stopping = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  while (!stopping) {
    if (!await worker.runOnce()) await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  operationalMetrics.close();
  await repository.close();
  await telemetry.shutdown();
}
