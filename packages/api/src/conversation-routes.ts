import type { FastifyInstance } from "fastify";
import { Type } from "typebox";

import {
  observeTurnEnqueue,
  runtimeMetrics,
  type ConversationRepository,
  type ConversationTurnInput,
} from "@retail-price/runtime";

import { ApiError, ownerFor } from "./api-errors.js";
import type { IdentityVerifier } from "./auth.js";
import { loadConversationProjection } from "./projection.js";

export interface ConversationRouteOptions {
  repository: ConversationRepository;
  identityVerifier: IdentityVerifier;
}

const turnInputSchema = Type.Object({
  type: Type.Literal("MESSAGE"),
  content: Type.String({ minLength: 1, maxLength: 4000 }),
}, { additionalProperties: false });

export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRouteOptions,
): void {
  app.post("/api/conversations", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const conversation = await options.repository.createConversation(owner);
    return reply.status(201).send({ conversation });
  });

  app.post(
    "/api/conversations/:conversationId/turns",
    {
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          clientTurnId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
          input: turnInputSchema,
        }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const startedAt = performance.now();
      let outcome = "error";
      try {
        const owner = await ownerFor(request, options.identityVerifier);
        const { conversationId } = request.params as { conversationId: string };
        const body = request.body as {
          clientTurnId: string;
          expectedRevision?: number;
          input: ConversationTurnInput;
        };
        const turn = await observeTurnEnqueue({
          conversationId,
          tenantId: owner.tenantId,
          ownerId: owner.ownerId,
          operation: "accept_turn",
          inputType: body.input.type,
        }, (active) => options.repository.acceptTurn({
          conversationId,
          owner,
          ...body,
          ...(active.traceId
            ? {
                telemetryTraceId: active.traceId,
                ...(active.rootObservationId
                  ? { telemetryRootObservationId: active.rootObservationId }
                  : {}),
              }
            : {}),
        }));
        outcome = turn.idempotentReplay ? "idempotent_replay" : "accepted";
        return reply.status(202).send({ turn });
      } finally {
        runtimeMetrics.apiEnqueueDuration.record(
          (performance.now() - startedAt) / 1000,
          { operation: "accept_turn", outcome },
        );
      }
    },
  );

  app.get("/api/conversations/:conversationId", async (request, reply) => {
    const startedAt = performance.now();
    let outcome = "error";
    try {
      const owner = await ownerFor(request, options.identityVerifier);
      const { conversationId } = request.params as { conversationId: string };
      const projection = await loadConversationProjection(options.repository, conversationId, owner);
      outcome = projection ? "found" : "not_found";
      return projection
        ? { projection }
        : reply.status(404).send({ error: { code: "CONVERSATION_NOT_FOUND" } });
    } finally {
      runtimeMetrics.apiProjectionDuration.record(
        (performance.now() - startedAt) / 1000,
        { outcome },
      );
    }
  });

  app.get("/api/conversations/:conversationId/messages", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await options.repository.getConversation(conversationId, owner);
    if (!conversation) {
      return reply.status(404).send({ error: { code: "CONVERSATION_NOT_FOUND" } });
    }
    const query = request.query as { afterSeq?: string };
    const afterSeq = Number(query.afterSeq ?? "0");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new ApiError("INVALID_MESSAGE_CURSOR", 400);
    }
    return { messages: await options.repository.listMessages(conversationId, owner, afterSeq) };
  });

  app.post("/api/conversations/:conversationId/turns/:turnId/cancel", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const { conversationId, turnId } = request.params as { conversationId: string; turnId: string };
    const turn = await options.repository.getTurn(turnId, owner);
    if (!turn || turn.conversationId !== conversationId) {
      return reply.status(404).send({ error: { code: "TURN_NOT_FOUND" } });
    }
    const cancelled = await options.repository.cancelTurn(turnId, owner);
    return cancelled
      ? reply.status(202).send({ cancelled: true })
      : reply.status(409).send({ error: { code: "TURN_NOT_CANCELLABLE" } });
  });

  app.post(
    "/api/conversations/:conversationId/turns/:turnId/retry",
    {
      schema: {
        params: Type.Object({
          conversationId: Type.String({ format: "uuid" }),
          turnId: Type.String({ format: "uuid" }),
        }),
        body: Type.Object({
          clientTurnId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
        }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const startedAt = performance.now();
      let outcome = "error";
      try {
        const owner = await ownerFor(request, options.identityVerifier);
        const { conversationId, turnId } = request.params as {
          conversationId: string;
          turnId: string;
        };
        const body = request.body as { clientTurnId: string; expectedRevision?: number };
        const turn = await observeTurnEnqueue({
          conversationId,
          tenantId: owner.tenantId,
          ownerId: owner.ownerId,
          operation: "retry_turn",
          inputType: "RETRY",
        }, (active) => options.repository.retryTurn({
          conversationId,
          turnId,
          owner,
          ...body,
          ...(active.traceId
            ? {
                telemetryTraceId: active.traceId,
                ...(active.rootObservationId
                  ? { telemetryRootObservationId: active.rootObservationId }
                  : {}),
              }
            : {}),
        }));
        outcome = turn.idempotentReplay ? "idempotent_replay" : "accepted";
        return reply.status(202).send({ turn });
      } finally {
        runtimeMetrics.apiEnqueueDuration.record(
          (performance.now() - startedAt) / 1000,
          { operation: "retry_turn", outcome },
        );
      }
    },
  );
}
