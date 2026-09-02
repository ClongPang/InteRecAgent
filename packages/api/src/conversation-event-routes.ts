import type { FastifyInstance } from "fastify";

import { runtimeMetrics, type ConversationRepository } from "@retail-price/runtime";

import { ApiError, ownerFor } from "./api-errors.js";
import type { IdentityVerifier } from "./auth.js";

export interface ConversationEventRouteOptions {
  repository: ConversationRepository;
  identityVerifier: IdentityVerifier;
  ssePollMs: number;
  sseMaxDurationMs: number;
}

export function registerConversationEventRoutes(
  app: FastifyInstance,
  options: ConversationEventRouteOptions,
): void {
  app.get("/api/conversations/:conversationId/events", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await options.repository.getConversation(conversationId, owner);
    if (!conversation) {
      return reply.status(404).send({ error: { code: "CONVERSATION_NOT_FOUND" } });
    }
    const query = request.query as { afterSeq?: string };
    const lastEventId = request.headers["last-event-id"];
    let afterSeq = Number(query.afterSeq ?? (typeof lastEventId === "string" ? lastEventId : "0"));
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new ApiError("INVALID_EVENT_CURSOR", 400);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const startedAt = Date.now();
    let lastWriteAt = startedAt;
    runtimeMetrics.sseConnections.add(1);
    try {
      while (!reply.raw.destroyed && Date.now() - startedAt < options.sseMaxDurationMs) {
        const events = await options.repository.listEvents(conversationId, owner, afterSeq);
        for (const event of events) {
          afterSeq = event.seq;
          lastWriteAt = Date.now();
          const createdAt = Date.parse(event.createdAt);
          if (Number.isFinite(createdAt)) {
            runtimeMetrics.sseLag.record(
              Math.max(0, lastWriteAt - createdAt) / 1000,
              { event_type: event.eventType },
            );
          }
          reply.raw.write(
            `id: ${event.seq}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        if (Date.now() - lastWriteAt >= 10_000) {
          reply.raw.write(": heartbeat\n\n");
          lastWriteAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, options.ssePollMs));
      }
    } finally {
      runtimeMetrics.sseConnections.add(-1);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });
}
