import {
  PostgresConversationRepository,
  requiredRetailPriceEnvironmentValue,
  retailPriceEnvironmentValue,
  startTelemetry,
  verifyConversationSchema,
  waitForTerminationSignal,
} from "@retail-price/runtime";

import { createConversationApp } from "./app.js";
import { HmacJwtIdentityVerifier, type HmacJwtOptions } from "./auth.js";
import { developmentAuthFromEnvironment } from "./development-auth.js";

function portFromEnvironment(): number {
  const value = Number(retailPriceEnvironmentValue(process.env, "API_PORT") ?? "8081");
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("RETAIL_PRICE_API_PORT_INVALID");
  return value;
}

const repository = new PostgresConversationRepository(requiredRetailPriceEnvironmentValue(process.env, "DATABASE_URL"));
const jwt: HmacJwtOptions = {
  secret: requiredRetailPriceEnvironmentValue(process.env, "AUTH_HMAC_SECRET"),
  issuer: requiredRetailPriceEnvironmentValue(process.env, "AUTH_ISSUER"),
  audience: requiredRetailPriceEnvironmentValue(process.env, "AUTH_AUDIENCE"),
};
const identityVerifier = new HmacJwtIdentityVerifier(jwt);
const developmentAuth = developmentAuthFromEnvironment(process.env, jwt);
const telemetry = await startTelemetry("retail-price-conversation-api");
const app = createConversationApp({
  repository,
  identityVerifier,
  closeRepository: true,
  ...(developmentAuth ? { developmentAuth } : {}),
  readiness: async () => {
    const client = await repository.pool.connect();
    try {
      await client.query("SELECT 1");
      await verifyConversationSchema(client);
    } finally {
      client.release();
    }
  },
});

await app.listen({
  host: retailPriceEnvironmentValue(process.env, "API_HOST")?.trim() || "127.0.0.1",
  port: portFromEnvironment(),
});

await waitForTerminationSignal();
await app.close();
await telemetry.shutdown({ strict: true });
