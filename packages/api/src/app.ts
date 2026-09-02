import Fastify from "fastify";

import type { ConversationRepository } from "@retail-price/runtime";

import { installApiErrorHandler } from "./api-errors.js";
import type { IdentityVerifier } from "./auth.js";
import { registerConversationEventRoutes } from "./conversation-event-routes.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import {
  registerDevelopmentAuthRoute,
  type DevelopmentAuthOptions,
} from "./development-auth.js";

export interface ConversationAppOptions {
  repository: ConversationRepository;
  identityVerifier: IdentityVerifier;
  readiness?: () => Promise<void>;
  closeRepository?: boolean;
  ssePollMs?: number;
  sseMaxDurationMs?: number;
  developmentAuth?: DevelopmentAuthOptions;
}

/** HTTP composition root; route behavior lives in focused registration modules. */
export function createConversationApp(options: ConversationAppOptions) {
  const app = Fastify({ logger: false });
  installApiErrorHandler(app);

  app.get("/health/live", async () => ({ status: "ok", service: "retail-price-conversation-api" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await options.readiness?.();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });

  registerConversationRoutes(app, options);
  registerConversationEventRoutes(app, {
    repository: options.repository,
    identityVerifier: options.identityVerifier,
    ssePollMs: options.ssePollMs ?? 250,
    sseMaxDurationMs: options.sseMaxDurationMs ?? 25_000,
  });
  if (options.developmentAuth) registerDevelopmentAuthRoute(app, options.developmentAuth);

  if (options.closeRepository) {
    app.addHook("onClose", async () => options.repository.close());
  }
  return app;
}
