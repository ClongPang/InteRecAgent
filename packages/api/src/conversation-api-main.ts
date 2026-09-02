import {
  PostgresConversationRepository,
  startTelemetry,
  verifyConversationSchema,
  waitForTerminationSignal,
} from "@interec/runtime";

import { createConversationApp } from "./app.js";
import { HmacJwtIdentityVerifier, type HmacJwtOptions } from "./auth.js";
import { developmentAuthFromEnvironment } from "./development-auth.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function portFromEnvironment(): number {
  const value = Number(process.env["INTEREC_API_PORT"] ?? "8081");
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("INTEREC_API_PORT_INVALID");
  return value;
}

const repository = new PostgresConversationRepository(required("INTEREC_DATABASE_URL"));
const jwt: HmacJwtOptions = {
  secret: required("INTEREC_AUTH_HMAC_SECRET"),
  issuer: required("INTEREC_AUTH_ISSUER"),
  audience: required("INTEREC_AUTH_AUDIENCE"),
};
const identityVerifier = new HmacJwtIdentityVerifier(jwt);
const developmentAuth = developmentAuthFromEnvironment(process.env, jwt);
const telemetry = await startTelemetry("interec-conversation-api");
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
  host: process.env["INTEREC_API_HOST"]?.trim() || "127.0.0.1",
  port: portFromEnvironment(),
});

await waitForTerminationSignal();
await app.close();
await telemetry.shutdown({ strict: true });
