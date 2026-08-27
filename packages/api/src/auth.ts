import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { OwnerClaims } from "@interec/runtime";

export interface IdentityVerifier {
  verify(request: FastifyRequest): Promise<OwnerClaims | null>;
}

export interface HmacJwtIdentityVerifierOptions {
  secret: string;
  issuer: string;
  audience: string;
  clockSkewSeconds?: number;
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
  private readonly secret: string;
  private readonly clockSkewSeconds: number;

  public constructor(private readonly options: HmacJwtIdentityVerifierOptions) {
    this.secret = options.secret.trim();
    if (this.secret.length < 32) throw new Error("INTEREC_AUTH_HMAC_SECRET_TOO_SHORT");
    if (!options.issuer.trim()) throw new Error("INTEREC_AUTH_ISSUER_REQUIRED");
    if (!options.audience.trim()) throw new Error("INTEREC_AUTH_AUDIENCE_REQUIRED");
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
    const expected = createHmac("sha256", this.secret).update(`${encodedHeader}.${encodedPayload}`).digest();
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
