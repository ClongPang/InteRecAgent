import { randomUUID } from "node:crypto";

import type { FxSnapshot } from "@interec/domain";

import { observeTool, runtimeMetrics } from "./telemetry.js";

export interface FxPort {
  getRate(base: string, signal?: AbortSignal): Promise<FxSnapshot>;
}

type FetchLike = typeof fetch;

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
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
      return await observeTool("resolve-exchange-rate", {
        provider: "fxratesapi",
        base: base.toUpperCase(),
        quote: "CNY",
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
        const rates = payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)["rates"]
          : undefined;
        const rate = rates && typeof rates === "object" ? (rates as Record<string, unknown>)["CNY"] : undefined;
        if (typeof rate !== "number" && typeof rate !== "string") throw new Error("FX_CONTRACT_DRIFT");
        const numericRate = String(rate);
        if (!Number.isFinite(Number(numericRate)) || Number(numericRate) <= 0) throw new Error("FX_INVALID_RATE");
        const observed = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>)["date"] === "string"
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
      }, (result) => ({
        provider: result.provider,
        base: result.base,
        quote: result.quote,
        observedAt: result.observedAt,
      }), { provider: "fxratesapi", base: base.toUpperCase(), quote: "CNY" });
    } catch (error) {
      runtimeMetrics.providerErrors.add(1, { provider: "fxratesapi" });
      throw error;
    } finally {
      runtimeMetrics.providerDuration.record((performance.now() - startedAt) / 1000, { provider: "fxratesapi" });
    }
  }
}
