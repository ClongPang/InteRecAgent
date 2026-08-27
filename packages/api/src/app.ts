import Fastify, { type FastifyRequest } from "fastify";
import { Type } from "typebox";

import {
  ConversationRepositoryError,
  runtimeMetrics,
  type ConversationRepository,
  type ConversationTurnInput,
  type OwnerClaims,
} from "@interec/runtime";

import type { IdentityVerifier } from "./auth.js";
import { loadConversationProjection } from "./projection.js";

export interface ConversationAppOptions {
  repository: ConversationRepository;
  identityVerifier: IdentityVerifier;
  readiness?: () => Promise<void>;
  closeRepository?: boolean;
  ssePollMs?: number;
  sseMaxDurationMs?: number;
}

class ApiError extends Error {
  public constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = "ApiError";
  }
}

async function ownerFor(request: FastifyRequest, verifier: IdentityVerifier): Promise<OwnerClaims> {
  const owner = await verifier.verify(request);
  if (!owner) throw new ApiError("AUTHENTICATION_REQUIRED", 401);
  return owner;
}

function statusForRepositoryError(code: string): number {
  if (code === "CONVERSATION_NOT_FOUND") return 404;
  if ([
    "IDEMPOTENCY_KEY_REUSED",
    "REVISION_CONFLICT",
    "CONVERSATION_NOT_OPEN",
    "CONVERSATION_TURN_ACTIVE",
    "TURN_NOT_RETRYABLE",
    "RETRY_INPUT_ALREADY_CONSUMED",
    "UNCONSUMED_MESSAGE_BATCH_LIMIT",
  ].includes(code)) return 409;
  return 400;
}

const unboundGoalOperationSchema = Type.Object({
  opId: Type.String({ minLength: 1, maxLength: 128 }),
  kind: Type.String({ pattern: "^GOAL_[A-Z_]+$" }),
}, { additionalProperties: true });

const turnInputSchema = Type.Union([
  Type.Object({
    type: Type.Literal("MESSAGE"),
    content: Type.String({ minLength: 1, maxLength: 4000 }),
    focusOfferRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("PATCH_GOAL"), operations: Type.Array(unboundGoalOperationSchema, { minItems: 1, maxItems: 12 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("UNDO"), revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("SET_COMPARISON"), offerRefs: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 2, maxItems: 4, uniqueItems: true }) }, { additionalProperties: false }),
]);

export function createConversationApp(options: ConversationAppOptions) {
  const app = Fastify({ logger: false });
  const ssePollMs = options.ssePollMs ?? 250;
  const sseMaxDurationMs = options.sseMaxDurationMs ?? 25_000;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({ error: { code: error.code } });
      return;
    }
    if (error instanceof ConversationRepositoryError) {
      void reply.status(statusForRepositoryError(error.code)).send({ error: { code: error.code } });
      return;
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    void reply.status(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({
      error: { code: statusCode >= 400 && statusCode < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR" },
    });
  });

  app.get("/health/live", async () => ({ status: "ok", service: "interec-conversation-api" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await options.readiness?.();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });

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
        const body = request.body as { clientTurnId: string; expectedRevision?: number; input: ConversationTurnInput };
        const turn = await options.repository.acceptTurn({ conversationId, owner, ...body });
        outcome = turn.idempotentReplay ? "idempotent_replay" : "accepted";
        return reply.status(202).send({ turn });
      } finally {
        runtimeMetrics.apiEnqueueDuration.record((performance.now() - startedAt) / 1000, { operation: "accept_turn", outcome });
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
      runtimeMetrics.apiProjectionDuration.record((performance.now() - startedAt) / 1000, { outcome });
    }
  });

  app.get("/api/conversations/:conversationId/messages", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await options.repository.getConversation(conversationId, owner);
    if (!conversation) return reply.status(404).send({ error: { code: "CONVERSATION_NOT_FOUND" } });
    const query = request.query as { afterSeq?: string };
    const afterSeq = Number(query.afterSeq ?? "0");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ApiError("INVALID_MESSAGE_CURSOR", 400);
    return { messages: await options.repository.listMessages(conversationId, owner, afterSeq) };
  });

  app.post("/api/conversations/:conversationId/turns/:turnId/cancel", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const { conversationId, turnId } = request.params as { conversationId: string; turnId: string };
    const turn = await options.repository.getTurn(turnId, owner);
    if (!turn || turn.conversationId !== conversationId) return reply.status(404).send({ error: { code: "TURN_NOT_FOUND" } });
    const cancelled = await options.repository.cancelTurn(turnId, owner);
    return cancelled
      ? reply.status(202).send({ cancelled: true })
      : reply.status(409).send({ error: { code: "TURN_NOT_CANCELLABLE" } });
  });

  app.post(
    "/api/conversations/:conversationId/turns/:turnId/retry",
    {
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }), turnId: Type.String({ format: "uuid" }) }),
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
        const { conversationId, turnId } = request.params as { conversationId: string; turnId: string };
        const body = request.body as { clientTurnId: string; expectedRevision?: number };
        const turn = await options.repository.retryTurn({ conversationId, turnId, owner, ...body });
        outcome = turn.idempotentReplay ? "idempotent_replay" : "accepted";
        return reply.status(202).send({ turn });
      } finally {
        runtimeMetrics.apiEnqueueDuration.record((performance.now() - startedAt) / 1000, { operation: "retry_turn", outcome });
      }
    },
  );

  app.get("/api/conversations/:conversationId/events", async (request, reply) => {
    const owner = await ownerFor(request, options.identityVerifier);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await options.repository.getConversation(conversationId, owner);
    if (!conversation) return reply.status(404).send({ error: { code: "CONVERSATION_NOT_FOUND" } });
    const query = request.query as { afterSeq?: string };
    const lastEventId = request.headers["last-event-id"];
    let afterSeq = Number(query.afterSeq ?? (typeof lastEventId === "string" ? lastEventId : "0"));
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ApiError("INVALID_EVENT_CURSOR", 400);
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
      while (!reply.raw.destroyed && Date.now() - startedAt < sseMaxDurationMs) {
        const events = await options.repository.listEvents(conversationId, owner, afterSeq);
        for (const event of events) {
          afterSeq = event.seq;
          lastWriteAt = Date.now();
          const createdAt = Date.parse(event.createdAt);
          if (Number.isFinite(createdAt)) runtimeMetrics.sseLag.record(Math.max(0, lastWriteAt - createdAt) / 1000, { event_type: event.eventType });
          reply.raw.write(`id: ${event.seq}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        if (Date.now() - lastWriteAt >= 10_000) {
          reply.raw.write(": heartbeat\n\n");
          lastWriteAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, ssePollMs));
      }
    } finally {
      runtimeMetrics.sseConnections.add(-1);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  if (options.closeRepository) app.addHook("onClose", async () => options.repository.close());
  return app;
}
