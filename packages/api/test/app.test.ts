import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { emptyQuoteConversationState, type ConversationState } from "@interec/domain";
import type {
  AcceptedConversationTurn,
  ConversationEventRecord,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationRepository,
  ConversationTurnRecord,
  OwnerClaims,
} from "@interec/runtime";

import { createConversationApp } from "../src/app.js";
import {
  HmacJwtIdentityVerifier,
  issueHmacJwt,
  type HmacJwtOptions,
  type IdentityVerifier,
} from "../src/auth.js";
import { developmentAuthFromEnvironment } from "../src/development-auth.js";

const owner: OwnerClaims = { tenantId: "tenant-a", ownerId: "owner-a" };
const other: OwnerClaims = { tenantId: "tenant-a", ownerId: "owner-b" };
const jwt: HmacJwtOptions = {
  secret: "a-secure-test-secret-with-at-least-32-bytes",
  issuer: "issuer",
  audience: "audience",
};

class ApiRepositoryStub {
  public conversation: ConversationRecord | null = null;
  public messages: ConversationMessageRecord[] = [];
  public events: ConversationEventRecord[] = [];
  public turn: ConversationTurnRecord | null = null;
  public readonly state: ConversationState = { revision: 0, status: "OPEN", quote: emptyQuoteConversationState() };

  public async createConversation(claims: OwnerClaims): Promise<ConversationRecord> {
    const now = new Date().toISOString();
    this.conversation = { id: randomUUID(), owner: claims, status: "OPEN", contractVersion: "quote-leads-sg-v1", currentRevision: 0, messageCursor: 0, eventCursor: 0, activeTurnId: null, createdAt: now, updatedAt: now };
    return this.conversation;
  }

  public async getConversation(id: string, claims: OwnerClaims) {
    return this.conversation?.id === id && this.conversation.owner.tenantId === claims.tenantId && this.conversation.owner.ownerId === claims.ownerId
      ? this.conversation
      : null;
  }

  public async getProjection(id: string, claims: OwnerClaims) {
    const conversation = await this.getConversation(id, claims);
    if (!conversation) return null;
    return {
      conversation,
      state: this.state,
      messages: this.messages,
      activeTurn: conversation.activeTurnId ? this.turn : null,
      latestTurn: this.turn,
    };
  }

  public async acceptTurn(input: { conversationId: string; owner: OwnerClaims; clientTurnId: string; input: { type: string; content?: string } }): Promise<AcceptedConversationTurn> {
    if (!await this.getConversation(input.conversationId, input.owner)) throw new Error("CONVERSATION_NOT_FOUND");
    const now = new Date().toISOString();
    const turnId = randomUUID();
    const messageId = randomUUID();
    this.messages.push({ id: messageId, conversationId: input.conversationId, seq: this.messages.length + 1, role: "USER", payload: input.input, consumedByTurnId: null, createdAt: now });
    this.turn = { id: turnId, conversationId: input.conversationId, clientTurnId: input.clientTurnId, baseRevision: 0, status: "ACCEPTED", attempt: 0, fenceToken: "0", workerId: null, leaseExpiresAt: null, deadlineAt: now, errorCode: null, createdAt: now, completedAt: null };
    this.conversation = { ...this.conversation!, activeTurnId: turnId, messageCursor: this.messages.length, eventCursor: this.events.length + 1 };
    this.events.push({ id: randomUUID(), conversationId: input.conversationId, turnId, seq: this.events.length + 1, eventType: "turn.accepted", publicPayload: {}, createdAt: now });
    return { ...this.turn, inputMessageIds: [messageId], idempotentReplay: false };
  }

  public async getSnapshot(conversationId: string, claims: OwnerClaims) {
    return await this.getConversation(conversationId, claims) ? this.state : null;
  }
  public async getRevision(conversationId: string, claims: OwnerClaims) { return this.getSnapshot(conversationId, claims); }
  public async getTurn(turnId: string, claims: OwnerClaims) {
    return this.turn?.id === turnId && await this.getConversation(this.turn.conversationId, claims) ? this.turn : null;
  }
  public async getLatestTurn(conversationId: string, claims: OwnerClaims) {
    return this.turn?.conversationId === conversationId && await this.getConversation(conversationId, claims) ? this.turn : null;
  }
  public async listMessages(conversationId: string, claims: OwnerClaims, afterSeq: number) {
    return await this.getConversation(conversationId, claims) ? this.messages.filter((message) => message.seq > afterSeq) : [];
  }
  public async listEvents(conversationId: string, claims: OwnerClaims, afterSeq: number) {
    return await this.getConversation(conversationId, claims) ? this.events.filter((event) => event.seq > afterSeq) : [];
  }
  public async cancelTurn(turnId: string, claims: OwnerClaims) {
    if (!await this.getTurn(turnId, claims) || !this.turn) return false;
    this.turn = { ...this.turn, status: "CANCELLED" };
    this.conversation = { ...this.conversation!, activeTurnId: null };
    return true;
  }
  public async retryTurn() { throw new Error("TURN_NOT_RETRYABLE"); }
  public async close() {}
}

const verifier: IdentityVerifier = {
  verify: async (request) => request.headers.authorization === "Bearer owner" ? owner : request.headers.authorization === "Bearer other" ? other : null,
};

describe("Conversation API", () => {
  const apps: Array<ReturnType<typeof createConversationApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("rejects browser self-reported identity and accepts only verified bearer claims", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({ repository: repository as unknown as ConversationRepository, identityVerifier: verifier });
    apps.push(app);
    const rejected = await app.inject({ method: "POST", url: "/api/conversations", headers: { "x-tenant-id": "tenant-a", "x-actor-id": "owner-a" } });
    expect(rejected).toMatchObject({ statusCode: 401 });
    const accepted = await app.inject({ method: "POST", url: "/api/conversations", headers: { authorization: "Bearer owner" } });
    expect(accepted.statusCode).toBe(201);
  });

  it("accepts a durable Turn and returns one owner-scoped ConversationProjection", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({ repository: repository as unknown as ConversationRepository, identityVerifier: verifier });
    apps.push(app);
    const headers = { authorization: "Bearer owner" };
    const created = await app.inject({ method: "POST", url: "/api/conversations", headers });
    const conversationId = created.json().conversation.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/turns`,
      headers,
      payload: { clientTurnId: "turn-1", expectedRevision: 0, input: { type: "MESSAGE", content: "查 Sony WH-1000XM5 报价" } },
    });
    expect(accepted).toMatchObject({ statusCode: 202 });
    const projection = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers });
    expect(projection.json().projection).toMatchObject({
      conversation: { id: conversationId, currentRevision: 0 },
      activeTurn: { status: "ACCEPTED" },
      messages: [{ role: "USER", payload: { type: "MESSAGE" } }],
      eventCursor: 1,
    });
    const hidden = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers: { authorization: "Bearer other" } });
    expect(hidden.statusCode).toBe(404);
  });

  it("rejects every retired structured shopping input at the HTTP schema boundary", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({ repository: repository as unknown as ConversationRepository, identityVerifier: verifier });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/conversations", headers: { authorization: "Bearer owner" } });
    const conversationId = created.json().conversation.id as string;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/turns`,
      headers: { authorization: "Bearer owner" },
      payload: { clientTurnId: "legacy-turn", input: { type: "SET_COMPARISON", offerRefs: ["a", "b"] } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("resumes the Conversation event stream strictly after Last-Event-ID", async () => {
    const repository = new ApiRepositoryStub();
    const conversation = await repository.createConversation(owner);
    const now = new Date().toISOString();
    repository.events.push(
      { id: randomUUID(), conversationId: conversation.id, turnId: null, seq: 1, eventType: "turn.accepted", publicPayload: {}, createdAt: now },
      { id: randomUUID(), conversationId: conversation.id, turnId: null, seq: 2, eventType: "turn.started", publicPayload: {}, createdAt: now },
      { id: randomUUID(), conversationId: conversation.id, turnId: null, seq: 3, eventType: "turn.completed", publicPayload: {}, createdAt: now },
    );
    const app = createConversationApp({ repository: repository as unknown as ConversationRepository, identityVerifier: verifier, ssePollMs: 1, sseMaxDurationMs: 5 });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/events`, headers: { authorization: "Bearer owner", "last-event-id": "1" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("id: 1\n");
    expect(response.body).toContain("id: 2\nevent: turn.started");
    expect(response.body).toContain("id: 3\nevent: turn.completed");
  });

  it("distinguishes liveness from dependency readiness", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({ repository: repository as unknown as ConversationRepository, identityVerifier: verifier, readiness: async () => { throw new Error("DB_DOWN"); } });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
  });
});

describe("HMAC JWT identity verifier", () => {
  it("binds tenant and owner only after signature, issuer, audience and expiry verification", async () => {
    const issued = issueHmacJwt(jwt, { owner, lifetimeSeconds: 60 });
    const authorization = `Bearer ${issued.accessToken}`;
    const verifier = new HmacJwtIdentityVerifier(jwt);
    expect(await verifier.verify({ headers: { authorization } } as never)).toEqual(owner);
    expect(await verifier.verify({ headers: { authorization: `${authorization}x` } } as never)).toBeNull();
  });

  it("issues deterministic expiry metadata from the shared JWT contract", () => {
    const issued = issueHmacJwt(jwt, { owner, lifetimeSeconds: 60, nowSeconds: 1_700_000_000 });
    expect(issued.expiresAt).toBe("2023-11-14T22:14:20.000Z");
    expect(issued.accessToken.split(".")).toHaveLength(3);
  });
});

describe("development authentication", () => {
  const apps: Array<ReturnType<typeof createConversationApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("does not register the development route unless explicitly configured", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({ repository: repository as unknown as ConversationRepository, identityVerifier: verifier });
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/dev/auth" })).statusCode).toBe(404);
  });

  it("issues a verifier-compatible local token without caching it", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({
      repository: repository as unknown as ConversationRepository,
      identityVerifier: verifier,
      developmentAuth: { jwt },
    });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/dev/auth" });
    expect(response).toMatchObject({ statusCode: 200, headers: { "cache-control": "no-store" } });
    const session = response.json().session as { accessToken: string; expiresAt: string };
    const identity = await new HmacJwtIdentityVerifier(jwt).verify({
      headers: { authorization: `Bearer ${session.accessToken}` },
    } as never);
    expect(identity).toEqual({ tenantId: "local-dev", ownerId: "local-user" });
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("hides the configured route from non-loopback clients", async () => {
    const repository = new ApiRepositoryStub();
    const app = createConversationApp({
      repository: repository as unknown as ConversationRepository,
      identityVerifier: verifier,
      developmentAuth: { jwt },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/dev/auth",
      remoteAddress: "203.0.113.10",
    });
    expect(response.statusCode).toBe(404);
  });

  it("fails closed for production or non-loopback startup configuration", () => {
    expect(developmentAuthFromEnvironment({}, jwt)).toBeUndefined();
    expect(() => developmentAuthFromEnvironment({
      INTEREC_ENABLE_DEV_AUTH: "true",
      NODE_ENV: "production",
      INTEREC_API_HOST: "127.0.0.1",
    }, jwt)).toThrow("INTEREC_DEV_AUTH_FORBIDDEN_IN_PRODUCTION");
    expect(() => developmentAuthFromEnvironment({
      INTEREC_ENABLE_DEV_AUTH: "true",
      NODE_ENV: "development",
      INTEREC_API_HOST: "0.0.0.0",
    }, jwt)).toThrow("INTEREC_DEV_AUTH_REQUIRES_LOOPBACK_HOST");
  });
});
