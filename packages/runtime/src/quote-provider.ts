export const QUOTE_PROVIDER_CONTRACT_VERSION = "buywhere-mcp-v2-quote-records-v1" as const;

export interface QuoteLookupRequest {
  /** Confirmed, deterministic query derived from the durable quote target. */
  canonicalQuery: string;
}

export interface QuoteProviderMeta {
  status: string | null;
  emptinessReason: string | null;
  confidence: string | null;
  engineStatus: string | null;
  raw: Record<string, unknown>;
}

export interface QuoteProviderFailure {
  code: string;
  retryable: boolean;
}

export type QuoteProviderStatus = "OK_RESULTS" | "OK_EMPTY" | "DEGRADED" | "FAILED";

export interface QuoteProviderResult {
  status: QuoteProviderStatus;
  records: Record<string, unknown>[];
  meta: QuoteProviderMeta;
  failure: QuoteProviderFailure | null;
  rawPayload: unknown;
  artifactRef: string | null;
  observedAt: string;
  providerContractVersion: typeof QUOTE_PROVIDER_CONTRACT_VERSION;
}

export interface QuoteProvider {
  lookup(request: QuoteLookupRequest, signal?: AbortSignal): Promise<QuoteProviderResult>;
}
