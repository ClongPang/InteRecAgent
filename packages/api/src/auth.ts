import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { OwnerClaims } from "@interec/runtime";

export interface IdentityVerifier {
  verify(request: FastifyRequest): Promise<OwnerClaims | null>;
}

export interface HmacJwtOptions {
  secret: string;
  issuer: string;
  audience: string;
}

export interface HmacJwtIdentityVerifierOptions extends HmacJwtOptions {
  clockSkewSeconds?: number;
}

export interface HmacJwtIssueOptions {
  owner: OwnerClaims;
  lifetimeSeconds: number;
  nowSeconds?: number;
}

export interface IssuedHmacJwt {
  accessToken: string;
  expiresAt: string;
}

interface NormalizedHmacJwtOptions {
  secret: string;
  issuer: string;
  audience: string;
}

function normalizeHmacJwtOptions(options: HmacJwtOptions): NormalizedHmacJwtOptions {
  const secret = options.secret.trim();
  const issuer = options.issuer.trim();
  const audience = options.audience.trim();
  if (secret.length < 32) throw new Error("INTEREC_AUTH_HMAC_SECRET_TOO_SHORT");
  if (!issuer) throw new Error("INTEREC_AUTH_ISSUER_REQUIRED");
  if (!audience) throw new Error("INTEREC_AUTH_AUDIENCE_REQUIRED");
  return { secret, issuer, audience };
}

/** Issues the same HS256 contract consumed by HmacJwtIdentityVerifier. */
export function issueHmacJwt(
  options: HmacJwtOptions,
  issue: HmacJwtIssueOptions,
): IssuedHmacJwt {
  const normalized = normalizeHmacJwtOptions(options);
  if (!Number.isSafeInteger(issue.lifetimeSeconds) || issue.lifetimeSeconds < 1) {
    throw new Error("INTEREC_AUTH_TOKEN_LIFETIME_INVALID");
  }
  const now = issue.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INTEREC_AUTH_TOKEN_TIME_INVALID");
  const expiresAtSeconds = now + issue.lifetimeSeconds;
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    iss: normalized.issuer,
    aud: normalized.audience,
    tenant_id: issue.owner.tenantId,
    sub: issue.owner.ownerId,
    iat: now,
    exp: expiresAtSeconds,
  })).toString("base64url");
  const signature = createHmac("sha256", normalized.secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return {
    accessToken: `${encodedHeader}.${encodedPayload}.${signature}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export class HmacJwtIdentityVerifier implements IdentityVerifier {
  private readonly options: NormalizedHmacJwtOptions;
  private readonly clockSkewSeconds: number;

  public constructor(options: HmacJwtIdentityVerifierOptions) {
    this.options = normalizeHmacJwtOptions(options);
    this.clockSkewSeconds = options.clockSkewSeconds ?? 30;
  }

  public async verify(request: FastifyRequest): Promise<OwnerClaims | null> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
    const token = authorization.slice(7).trim();
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = parseJsonSegment(encodedHeader);
    const payload = parseJsonSegment(encodedPayload);
    if (!header || !payload || header["alg"] !== "HS256") return null;
    const expected = createHmac("sha256", this.options.secret).update(`${encodedHeader}.${encodedPayload}`).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(encodedSignature, "base64url");
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const now = Math.floor(Date.now() / 1000);
    const exp = payload["exp"];
    const nbf = payload["nbf"];
    const audience = payload["aud"];
    const audienceMatches = audience === this.options.audience || (Array.isArray(audience) && audience.includes(this.options.audience));
    if (payload["iss"] !== this.options.issuer || !audienceMatches) return null;
    if (typeof exp !== "number" || exp + this.clockSkewSeconds < now) return null;
    if (typeof nbf === "number" && nbf - this.clockSkewSeconds > now) return null;
    const tenantId = payload["tenant_id"];
    const ownerId = payload["sub"];
    if (typeof tenantId !== "string" || !tenantId.trim() || typeof ownerId !== "string" || !ownerId.trim()) return null;
    return { tenantId: tenantId.trim(), ownerId: ownerId.trim() };
  }
}
