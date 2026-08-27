import { createHash, randomUUID } from "node:crypto";

import type { BuyWhereRawProduct, FxSnapshot, Market } from "@interec/domain";

import { inSpan, runtimeMetrics } from "./telemetry.js";

export interface MarketSearchResult {
  market: Market;
  products: BuyWhereRawProduct[];
  artifactRef: string;
  rawPayload: unknown;
  observedAt: string;
}

export interface ProductSearchPort {
  search(query: string, market: Market, limit: number, signal?: AbortSignal): Promise<MarketSearchResult>;
}

export interface FxPort {
  getRate(base: string, signal?: AbortSignal): Promise<FxSnapshot>;
}

type FetchLike = typeof fetch;

export interface BuyWhereClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function normalizeBuyWhereFailure(error: unknown, externalSignal?: AbortSignal): Error {
  if (externalSignal?.aborted) {
    return externalSignal.reason instanceof Error ? externalSignal.reason : new Error("RUN_ABORTED");
  }
  if (error instanceof Error && /\bBUYWHERE_[A-Z0-9_]+\b/.test(error.message)) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return Object.assign(new Error("BUYWHERE_TIMEOUT"), { retryable: true });
  }
  return Object.assign(new Error("BUYWHERE_NETWORK_ERROR"), { retryable: true });
}

export class BuyWhereClient implements ProductSearchPort {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  public constructor(private readonly apiKey: string, options: BuyWhereClientOptions = {}) {
    if (!apiKey) throw new Error("BUYWHERE_API_KEY_REQUIRED");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.buywhere.ai";
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public async search(query: string, market: Market, limit: number, signal?: AbortSignal): Promise<MarketSearchResult> {
    const startedAt = performance.now();
    try {
      return await inSpan("buywhere.search", {
        "server.address": new URL(this.baseUrl).hostname,
        "rec_agent.market": market,
        "langfuse.observation.metadata.provider": "buywhere",
        "langfuse.observation.metadata.market": market,
      }, async () => {
    const url = new URL("/v1/products/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("country_code", market);
    url.searchParams.set("mode", "keyword");
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 8)));
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "x-api-key": this.apiKey, accept: "application/json" },
        signal: timeoutSignal(this.timeoutMs, signal),
      });
    } catch (error) {
      throw normalizeBuyWhereFailure(error, signal);
    }
    if (!response.ok) {
      const error = new Error(`BUYWHERE_HTTP_${response.status}`);
      Object.assign(error, { retryable: response.status === 429 || response.status >= 500 });
      throw error;
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>)["data"])) {
      throw new Error("BUYWHERE_CONTRACT_DRIFT");
    }
    const observedAt = new Date().toISOString();
    const artifactRef = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
    return {
      market,
      products: (payload as { data: BuyWhereRawProduct[] }).data.slice(0, 8),
      artifactRef,
      rawPayload: payload,
      observedAt,
    };
      });
    } catch (error) {
      runtimeMetrics.providerErrors.add(1, { provider: "buywhere", market });
      throw error;
    } finally {
      runtimeMetrics.providerDuration.record((performance.now() - startedAt) / 1000, { provider: "buywhere", market });
    }
  }
}

export class FxRatesClient implements FxPort {
  public constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = "https://api.fxratesapi.com",
    private readonly timeoutMs = 3_000,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  public async getRate(base: string, signal?: AbortSignal): Promise<FxSnapshot> {
    const startedAt = performance.now();
    try {
      return await inSpan("fx.resolve", {
        "rec_agent.fx.base": base.toUpperCase(),
        "rec_agent.fx.quote": "CNY",
        "langfuse.observation.metadata.provider": "fxratesapi",
        "langfuse.observation.metadata.base": base.toUpperCase(),
        "langfuse.observation.metadata.quote": "CNY",
      }, async () => {
    const normalizedBase = base.toUpperCase();
    const now = new Date();
    if (normalizedBase === "CNY") {
      return {
        id: randomUUID(),
        base: "CNY",
        quote: "CNY",
        rate: "1",
        provider: "identity",
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      };
    }
    const url = new URL("/latest", this.baseUrl);
    url.searchParams.set("base", normalizedBase);
    url.searchParams.set("currencies", "CNY");
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!response.ok) throw new Error(`FX_HTTP_${response.status}`);
    const payload: unknown = await response.json();
    const rates =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)["rates"]
        : undefined;
    const rate = rates && typeof rates === "object" ? (rates as Record<string, unknown>)["CNY"] : undefined;
    if (typeof rate !== "number" && typeof rate !== "string") throw new Error("FX_CONTRACT_DRIFT");
    const numericRate = String(rate);
    if (!Number.isFinite(Number(numericRate)) || Number(numericRate) <= 0) throw new Error("FX_INVALID_RATE");
    const observed =
      payload && typeof payload === "object" && typeof (payload as Record<string, unknown>)["date"] === "string"
        ? new Date(String((payload as Record<string, unknown>)["date"]))
        : now;
    const observedAt = Number.isNaN(observed.getTime()) ? now : observed;
    return {
      id: randomUUID(),
      base: normalizedBase,
      quote: "CNY",
      rate: numericRate,
      provider: "fxratesapi",
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + this.ttlMs).toISOString(),
    };
      });
    } catch (error) {
      runtimeMetrics.providerErrors.add(1, { provider: "fxratesapi" });
      throw error;
    } finally {
      runtimeMetrics.providerDuration.record((performance.now() - startedAt) / 1000, { provider: "fxratesapi" });
    }
  }
}
