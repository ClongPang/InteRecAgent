import { createHash } from "node:crypto";

import {
  QUOTE_PROVIDER_CONTRACT_VERSION,
  type QuoteProviderFailure,
  type QuoteProviderMeta,
  type QuoteProviderResult,
} from "./quote-provider.js";

const EMPTY_META: QuoteProviderMeta = {
  status: null,
  emptinessReason: null,
  confidence: null,
  engineStatus: null,
  raw: {},
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function artifactRef(payload: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function failedQuoteProviderResult(input: {
  code: string;
  retryable: boolean;
  observedAt: string;
  rawPayload?: unknown;
  meta?: QuoteProviderMeta;
}): QuoteProviderResult {
  const rawPayload = input.rawPayload ?? null;
  return {
    status: "FAILED",
    records: [],
    meta: input.meta ?? structuredClone(EMPTY_META),
    failure: { code: input.code, retryable: input.retryable },
    rawPayload,
    artifactRef: rawPayload === null ? null : artifactRef(rawPayload),
    observedAt: input.observedAt,
    providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
  };
}

function parseJsonText(value: unknown): unknown | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function unwrapMcpPayload(raw: unknown): { payload: Record<string, unknown> | null; error: QuoteProviderFailure | null } {
  const root = record(raw);
  if (!root) return { payload: null, error: { code: "BUYWHERE_CONTRACT_DRIFT", retryable: false } };
  const jsonRpcError = record(root["error"]);
  if (jsonRpcError) {
    const code = typeof jsonRpcError["code"] === "number" || typeof jsonRpcError["code"] === "string"
      ? String(jsonRpcError["code"]).replace(/[^A-Za-z0-9_-]/gu, "_")
      : "UNKNOWN";
    return { payload: null, error: { code: `BUYWHERE_MCP_${code}`, retryable: code === "-32603" } };
  }
  const result = record(root["result"]);
  if (!result) return { payload: null, error: { code: "BUYWHERE_CONTRACT_DRIFT", retryable: false } };
  if (result["isError"] === true) return { payload: null, error: { code: "BUYWHERE_MCP_TOOL_ERROR", retryable: true } };

  const structured = record(result["structuredContent"]);
  if (structured) return { payload: structured, error: null };

  const content = Array.isArray(result["content"]) ? result["content"] : [];
  for (const block of content) {
    const item = record(block);
    if (!item || item["type"] !== "text") continue;
    const parsed = parseJsonText(item["text"]);
    const parsedRecord = record(parsed);
    if (parsedRecord) return { payload: parsedRecord, error: null };
  }

  if (["data", "products", "results", "items", "best_price", "alternatives", "meta"].some((key) => Object.hasOwn(result, key))) {
    return { payload: result, error: null };
  }
  return { payload: null, error: { code: "BUYWHERE_CONTRACT_DRIFT", retryable: false } };
}

function quoteRecords(payload: Record<string, unknown>): Record<string, unknown>[] | null {
  if (Object.hasOwn(payload, "best_price") || Object.hasOwn(payload, "alternatives")) {
    const best = payload["best_price"];
    const alternatives = payload["alternatives"];
    if (best !== null && best !== undefined && record(best) === null) return null;
    if (alternatives !== undefined && !Array.isArray(alternatives)) return null;
    if (Array.isArray(alternatives) && alternatives.some((item) => record(item) === null)) return null;
    return [
      ...(record(best) ? [structuredClone(best as Record<string, unknown>)] : []),
      ...((alternatives ?? []) as Record<string, unknown>[]).map((item) => structuredClone(item)),
    ];
  }
  for (const key of ["data", "products", "results", "items"] as const) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = payload[key];
    if (!Array.isArray(value)) return null;
    if (value.some((item) => record(item) === null)) return null;
    return value.map((item) => structuredClone(item as Record<string, unknown>));
  }
  return null;
}

function providerMeta(payload: Record<string, unknown>): QuoteProviderMeta {
  const raw = record(payload["meta"]) ?? {};
  const diagnostic = record(raw["diagnostic"]);
  return {
    status: text(raw["status"]),
    emptinessReason: text(raw["emptiness_reason"] ?? raw["emptinessReason"]),
    confidence: text(raw["confidence"]),
    engineStatus: text(raw["engine_status"] ?? raw["engineStatus"] ?? diagnostic?.["engine_status"] ?? diagnostic?.["engineStatus"]),
    raw: structuredClone(raw),
  };
}

function degraded(meta: QuoteProviderMeta): boolean {
  const status = meta.status?.toLocaleLowerCase("en-US") ?? "";
  const engine = meta.engineStatus?.toLocaleLowerCase("en-US") ?? "";
  return meta.raw["degraded"] === true
    || status === "degraded"
    || ["degraded", "timeout", "circuit_open", "unavailable", "error"].includes(engine);
}

function degradationCode(meta: QuoteProviderMeta): string {
  const reason = meta.emptinessReason ?? meta.engineStatus ?? meta.status ?? "UNKNOWN";
  const normalized = reason.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return `BUYWHERE_DEGRADED_${normalized || "UNKNOWN"}`;
}

export function parseBuyWhereMcpToolResponse(raw: unknown, observedAt: string): QuoteProviderResult {
  const unwrapped = unwrapMcpPayload(raw);
  if (unwrapped.error || !unwrapped.payload) {
    return failedQuoteProviderResult({
      code: unwrapped.error?.code ?? "BUYWHERE_CONTRACT_DRIFT",
      retryable: unwrapped.error?.retryable ?? false,
      observedAt,
      rawPayload: raw,
    });
  }
  const meta = providerMeta(unwrapped.payload);
  const records = quoteRecords(unwrapped.payload);
  if (records === null && degraded(meta)) {
    return {
      status: "DEGRADED",
      records: [],
      meta,
      failure: { code: degradationCode(meta), retryable: true },
      rawPayload: raw,
      artifactRef: artifactRef(raw),
      observedAt,
      providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
    };
  }
  if (records === null) {
    return failedQuoteProviderResult({ code: "BUYWHERE_CONTRACT_DRIFT", retryable: false, observedAt, rawPayload: raw, meta });
  }
  const rawArtifactRef = artifactRef(raw);
  if (degraded(meta)) {
    return {
      status: "DEGRADED",
      records,
      meta,
      failure: { code: degradationCode(meta), retryable: true },
      rawPayload: raw,
      artifactRef: rawArtifactRef,
      observedAt,
      providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
    };
  }
  return {
    status: records.length > 0 ? "OK_RESULTS" : "OK_EMPTY",
    records,
    meta,
    failure: null,
    rawPayload: raw,
    artifactRef: rawArtifactRef,
    observedAt,
    providerContractVersion: QUOTE_PROVIDER_CONTRACT_VERSION,
  };
}
