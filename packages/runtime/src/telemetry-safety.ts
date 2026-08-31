import { createHash, createHmac } from "node:crypto";

import { startObservation } from "@langfuse/tracing";

import { runtimeMetrics } from "./runtime-metrics.js";

const MAX_CAPTURED_CONTENT_CHARS = 20_000;

export interface TelemetryConfig {
  langfuseEnabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment: string;
  release?: string;
  captureContent: boolean;
  pseudonymKey?: string;
  metricsEndpoint?: string;
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEnvironment(value: string | undefined): string {
  const normalized = (value ?? "development")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!normalized) return "development";
  return normalized.startsWith("langfuse") ? `app-${normalized}`.slice(0, 40) : normalized;
}

function contentCaptureAuthorized(environment: NodeJS.ProcessEnv): boolean {
  return environment["INTEREC_LANGFUSE_CAPTURE_CONTENT"]?.toLowerCase() === "true"
    && environment["INTEREC_LANGFUSE_CAPTURE_CONSENT"] === "authorized-redacted-content";
}

export function resolveTelemetryConfig(environment: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const publicKey = optionalValue(environment["LANGFUSE_PUBLIC_KEY"]);
  const secretKey = optionalValue(environment["LANGFUSE_SECRET_KEY"]);
  if (Boolean(publicKey) !== Boolean(secretKey)) throw new Error("LANGFUSE_CREDENTIALS_INCOMPLETE");
  const baseUrl = optionalValue(environment["LANGFUSE_BASE_URL"]);
  const release = optionalValue(environment["LANGFUSE_RELEASE"]);
  const metricsEndpoint = optionalValue(environment["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]);
  const pseudonymKey = optionalValue(environment["INTEREC_TELEMETRY_PSEUDONYM_KEY"]);
  if (publicKey && secretKey && !pseudonymKey) throw new Error("INTEREC_TELEMETRY_PSEUDONYM_KEY_REQUIRED");
  if (environment["INTEREC_LANGFUSE_CAPTURE_CONTENT"]?.toLowerCase() === "true" && !contentCaptureAuthorized(environment)) {
    throw new Error("INTEREC_LANGFUSE_CAPTURE_CONSENT_REQUIRED");
  }
  return {
    langfuseEnabled: Boolean(publicKey && secretKey),
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    environment: normalizeEnvironment(environment["LANGFUSE_TRACING_ENVIRONMENT"]),
    ...(release ? { release } : {}),
    captureContent: contentCaptureAuthorized(environment),
    ...(pseudonymKey ? { pseudonymKey } : {}),
    ...(metricsEndpoint ? { metricsEndpoint } : {}),
  };
}

const SENSITIVE_KEY = /(?:api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|cookie)/i;

function redactString(value: string): string {
  return value
    .replace(/("(?:api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)-(?:lf-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]");
}

export function redactTelemetryData(data: unknown): unknown {
  if (typeof data === "string") return redactString(data);
  if (Array.isArray(data)) return data.map((item) => redactTelemetryData(item));
  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactTelemetryData(value),
      ]),
    );
  }
  return data;
}

export function telemetryContent(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!contentCaptureAuthorized(environment)) {
    return { contentCaptured: false };
  }
  const redacted = redactTelemetryData(value);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= MAX_CAPTURED_CONTENT_CHARS) return redacted;
    return {
      contentCaptured: true,
      truncated: true,
      json: serialized.slice(0, MAX_CAPTURED_CONTENT_CHARS),
    };
  } catch {
    return { contentCaptured: true, serializationFailed: true };
  }
}

export function pseudonymousUserId(tenantId: string, ownerId: string, key: string): string {
  if (key.length < 32) throw new Error("INTEREC_TELEMETRY_PSEUDONYM_KEY_INVALID");
  return createHmac("sha256", key).update(tenantId).update("\0").update(ownerId).digest("hex").slice(0, 32);
}

export function telemetryTraceIdForTurn(conversationId: string, clientTurnId: string): string {
  return createHash("sha256")
    .update("interec-turn-trace-v1")
    .update("\0")
    .update(conversationId)
    .update("\0")
    .update(clientTurnId)
    .digest("hex")
    .slice(0, 32);
}

export function validTraceId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{32}$/.test(value) && value !== "0".repeat(32));
}

export function validSpanId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{16}$/.test(value) && value !== "0".repeat(16));
}

export function parentSpanIdForTrace(traceId: string): string {
  const spanId = createHash("sha256").update("interec-turn-parent-v1").update("\0").update(traceId).digest("hex").slice(0, 16);
  return spanId === "0".repeat(16) ? `1${spanId.slice(1)}` : spanId;
}

export function pseudonymousSessionId(conversationId: string, key: string): string {
  return createHmac("sha256", key).update("session").update("\0").update(conversationId).digest("hex").slice(0, 32);
}

export function telemetryErrorCode(error: unknown, fallback = "UNEXPECTED_ERROR"): string {
  if (!(error instanceof Error)) return fallback;
  const coded = (error as Error & { code?: unknown }).code;
  if (typeof coded === "string" && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(coded)) return coded.slice(0, 100);
  const explicit = error.message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
  if (explicit) return explicit.slice(0, 100);
  const named = error.name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
  return named && named !== "ERROR" ? named.slice(0, 100) : fallback;
}

export interface SafetyBoundaryClassification {
  claimValidation: boolean;
  evidence: boolean;
  safety: boolean;
}

export function classifySafetyBoundary(errorCode: string): SafetyBoundaryClassification {
  const code = errorCode.toUpperCase();
  const claimValidation = /CLAIM|ASSISTANT_ENVELOPE/.test(code);
  const evidence = /EVIDENCE|SOURCE|ELIGIBILITY|ARTIFACT|FX_|MARKET_CONFLICT|PRODUCT_IDENTITY/.test(code);
  const safety = claimValidation || evidence || /HARD_CONSTRAINT|WORKING_SET|REFERENT|OFFER_|UNNECESSARY_PROVIDER_SEARCH|SEARCH_BEFORE_CLARIFICATION|SEARCH_BLOCKED|UI_FOCUS/.test(code);
  return { claimValidation, evidence, safety };
}

export function recordSafetyBoundary(errorCode: string): void {
  const classification = classifySafetyBoundary(errorCode);
  if (classification.claimValidation) runtimeMetrics.claimValidationFailures.add(1);
  if (classification.evidence) runtimeMetrics.evidenceBlocks.add(1);
  if (classification.safety) runtimeMetrics.safetyBlocks.add(1);
  if (classification.safety) recordGuardrailDecision("enforce-safety-boundary", false, {
    errorCode,
    claimValidation: classification.claimValidation,
    evidence: classification.evidence,
  });
}

export function recordGuardrailDecision(
  name: string,
  passed: boolean,
  metadata: Record<string, unknown> = {},
): void {
  try {
    const observation = startObservation(name, {
      input: { check: name },
      output: { passed },
      metadata: redactTelemetryData(metadata) as Record<string, unknown>,
      ...(!passed ? { level: "WARNING" as const, statusMessage: "BLOCKED" } : {}),
    }, { asType: "guardrail" });
    observation.end();
  } catch {
    // Guardrail observability must never change the guarded business outcome.
  }
}


