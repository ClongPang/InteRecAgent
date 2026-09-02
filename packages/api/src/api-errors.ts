import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ConversationRepositoryError,
  type OwnerClaims,
} from "@retail-price/runtime";

import type { IdentityVerifier } from "./auth.js";

export class ApiError extends Error {
  public constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = "ApiError";
  }
}

export async function ownerFor(
  request: FastifyRequest,
  verifier: IdentityVerifier,
): Promise<OwnerClaims> {
  const owner = await verifier.verify(request);
  if (!owner) throw new ApiError("AUTHENTICATION_REQUIRED", 401);
  return owner;
}

function statusForRepositoryError(code: string): number {
  if (code === "CONVERSATION_NOT_FOUND") return 404;
  if (code === "LEGACY_CONVERSATION_RETIRED") return 410;
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

export function installApiErrorHandler(app: FastifyInstance): void {
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
}
