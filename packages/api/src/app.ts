import Fastify from "fastify";

import type { ConversationRepository } from "@interec/runtime";

import { installApiErrorHandler } from "./api-errors.js";
import type { IdentityVerifier } from "./auth.js";
import { registerConversationEventRoutes } from "./conversation-event-routes.js";
import { registerConversationRoutes } from "./conversation-routes.js";

export interface ConversationAppOptions {
  repository: ConversationRepository;
  identityVerifier: IdentityVerifier;
  readiness?: () => Promise<void>;
  closeRepository?: boolean;
  ssePollMs?: number;
  sseMaxDurationMs?: number;
}

/** HTTP composition root; route behavior lives in focused registration modules. */
export function createConversationApp(options: ConversationAppOptions) {
  const app = Fastify({ logger: false });
  installApiErrorHandler(app);

  app.get("/health/live", async () => ({ status: "ok", service: "interec-conversation-api" }));
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

  if (options.closeRepository) {
    app.addHook("onClose", async () => options.repository.close());
  }
  return app;
}
