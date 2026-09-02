import type { FastifyInstance } from "fastify";
import { retailPriceEnvironmentValue, type OwnerClaims } from "@retail-price/runtime";

import { issueHmacJwt, type HmacJwtOptions } from "./auth.js";

const DEVELOPMENT_TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;
const DEVELOPMENT_OWNER: OwnerClaims = { tenantId: "local-dev", ownerId: "local-user" };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface DevelopmentAuthOptions {
  jwt: HmacJwtOptions;
}

export function developmentAuthFromEnvironment(
  environment: NodeJS.ProcessEnv,
  jwt: HmacJwtOptions,
): DevelopmentAuthOptions | undefined {
  if (retailPriceEnvironmentValue(environment, "ENABLE_DEV_AUTH")?.trim() !== "true") return undefined;
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new Error("RETAIL_PRICE_DEV_AUTH_FORBIDDEN_IN_PRODUCTION");
  }
  const host = retailPriceEnvironmentValue(environment, "API_HOST")?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("RETAIL_PRICE_DEV_AUTH_REQUIRES_LOOPBACK_HOST");
  return { jwt };
}

function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_HOSTS.has(address.replace(/^::ffff:/u, ""));
}

/** Registers an opt-in, loopback-only token issuer for local development. */
export function registerDevelopmentAuthRoute(
  app: FastifyInstance,
  options: DevelopmentAuthOptions,
): void {
  app.post("/api/dev/auth", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(404).send({ error: { code: "DEV_AUTH_NOT_FOUND" } });
    }
    reply.header("cache-control", "no-store");
    return {
      session: issueHmacJwt(options.jwt, {
        owner: DEVELOPMENT_OWNER,
        lifetimeSeconds: DEVELOPMENT_TOKEN_LIFETIME_SECONDS,
      }),
    };
  });
}
