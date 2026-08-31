import { randomUUID } from "node:crypto";

import { ConversationWorker } from "./conversation-worker.js";
import { PostgresConversationSearchRepository } from "./conversation-search-repository.js";
import { resolveLiveTurnConfig } from "./live-turn-config.js";
import { createPiModelRuntime } from "./model-factory.js";
import { PostgresConversationRepository } from "./postgres-conversation-repository.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";
import { BuyWhereClient, FxRatesClient } from "./providers.js";
import { resolveBuyWhereRuntimeConfig } from "./runtime-config.js";
import { startTelemetry } from "./telemetry.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const { turnId } = resolveLiveTurnConfig();
const databaseUrl = process.env["INTEREC_WORKER_DATABASE_URL"]?.trim() || required("INTEREC_DATABASE_URL");
const repository = new PostgresConversationRepository(databaseUrl);
const buyWhere = resolveBuyWhereRuntimeConfig();
const telemetry = await startTelemetry("interec-conversation-live-turn");
try {
  const worker = new ConversationWorker(
    repository,
    new PostgresConversationSearchRepository(repository.pool),
    new PostgresProviderCallController(repository.pool),
    new BuyWhereClient(buyWhere.apiKey, { timeoutMs: buyWhere.timeoutMs }),
    new FxRatesClient(),
    createPiModelRuntime(),
    { workerId: `live-turn-${randomUUID()}` },
  );
  const claimed = await worker.runOnce(turnId);
  if (!claimed) throw new Error("INTEREC_LIVE_TURN_NOT_CLAIMABLE");
  process.stdout.write(`Processed exactly one authorized Turn: ${turnId}\n`);
} finally {
  await repository.close();
  await telemetry.shutdown();
}
