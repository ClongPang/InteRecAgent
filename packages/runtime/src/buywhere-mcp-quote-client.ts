import { randomUUID } from "node:crypto";

import { observeBuyWhereProviderCall } from "./buywhere-provider-observability.js";
import { failedQuoteProviderResult, parseBuyWhereMcpToolResponse } from "./buywhere-mcp-quote-parser.js";
import type { QuoteLookupRequest, QuoteProvider, QuoteProviderResult } from "./quote-provider.js";

type FetchLike = typeof fetch;

export interface BuyWhereMcpQuoteClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
  requestId?: () => string;
}

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class BuyWhereMcpQuoteClient implements QuoteProvider {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly requestId: () => string;

  public constructor(private readonly apiKey: string, options: BuyWhereMcpQuoteClientOptions = {}) {
    if (!apiKey.trim()) throw new Error("BUYWHERE_API_KEY_REQUIRED");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.buywhere.ai";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? randomUUID;
  }

  public async lookup(request: QuoteLookupRequest, signal?: AbortSignal): Promise<QuoteProviderResult> {
    const canonicalQuery = request.canonicalQuery.normalize("NFKC").trim();
    if (!canonicalQuery) throw new Error("QUOTE_QUERY_REQUIRED");
    const requestId = this.requestId();
    return observeBuyWhereProviderCall(canonicalQuery, requestId, async () => {
      const observedAt = this.now().toISOString();
      let response: Response;
      try {
        response = await this.fetchImpl(new URL("/mcp", this.baseUrl), {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/call",
            params: {
              name: "find_best_price_v2",
              arguments: {
                product_name: canonicalQuery,
                deliver_to: "SG",
              },
            },
          }),
          signal: timeoutSignal(this.timeoutMs, signal),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return failedQuoteProviderResult({ code: timeout ? "BUYWHERE_TIMEOUT" : "BUYWHERE_NETWORK_ERROR", retryable: true, observedAt });
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return failedQuoteProviderResult({
          code: response.ok ? "BUYWHERE_CONTRACT_DRIFT" : `BUYWHERE_HTTP_${response.status}`,
          retryable: !response.ok && retryableHttpStatus(response.status),
          observedAt,
        });
      }
      if (!response.ok) {
        return failedQuoteProviderResult({
          code: `BUYWHERE_HTTP_${response.status}`,
          retryable: retryableHttpStatus(response.status),
          observedAt,
          rawPayload: raw,
        });
      }
      return parseBuyWhereMcpToolResponse(raw, observedAt);
    });
  }
}
