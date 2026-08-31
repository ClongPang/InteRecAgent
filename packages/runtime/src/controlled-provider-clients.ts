import { createHash } from "node:crypto";

import type { FxSnapshot, Market } from "@interec/domain";

import type { ConversationRepository } from "./conversation-repository-types.js";
import type { FxPort, MarketSearchResult, ProductSearchPort } from "./providers.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";

export interface ProviderCallExecutionContext {
  tenantId: string;
  turnId: string;
  attempt: number;
  fenceToken: string;
  operationId: string;
  attemptNo: number;
}

function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.match(/[A-Z][A-Z0-9_]{2,99}/)?.[0] ?? "PROVIDER_FAILED" : "PROVIDER_FAILED";
}

function retryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { retryable?: unknown }).retryable === true);
}

export class ControlledProductSearchClient implements ProductSearchPort {
  public constructor(
    private readonly source: ProductSearchPort,
    private readonly repository: ConversationRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly context: ProviderCallExecutionContext,
  ) {}

  public async search(query: string, market: Market, limit: number, signal?: AbortSignal): Promise<MarketSearchResult> {
    let lastError: unknown = new Error("PROVIDER_FAILED");
    for (let retry = 0; retry <= 1; retry += 1) {
      const stepKey = `search:${this.context.operationId}:attempt:${this.context.attemptNo}:market:${market}:retry:${retry}`;
      const request = { provider: "buywhere", market, limit, queryHash: queryHash(query) };
      const reservation = await this.repository.reserveToolExecution(
        this.context.turnId,
        this.context.attempt,
        this.context.fenceToken,
        stepKey,
        request,
      );
      if (!reservation) throw new Error("PROVIDER_TOOL_FENCE_REJECTED");
      if (reservation.action === "REUSE") return reservation.execution.result as unknown as MarketSearchResult;
      if (reservation.action === "WAIT") throw Object.assign(new Error("PROVIDER_TOOL_IN_PROGRESS"), { retryable: true });
      let permitId: string | null = null;
      try {
        permitId = await this.callController.acquire({
          tenantId: this.context.tenantId,
          turnId: this.context.turnId,
          attempt: this.context.attempt,
          fenceToken: this.context.fenceToken,
          stepKey,
          provider: "buywhere",
          isRetry: retry > 0,
        });
        const result = await this.source.search(query, market, limit, signal);
        const completed = await this.repository.completeToolExecution(
          this.context.turnId,
          this.context.attempt,
          this.context.fenceToken,
          stepKey,
          reservation.execution.requestHash,
          result as unknown as Record<string, unknown>,
        );
        if (!completed) throw new Error("PROVIDER_TOOL_RESULT_FENCE_REJECTED");
        await this.callController.release(permitId, { success: true });
        return result;
      } catch (error) {
        lastError = error;
        const code = errorCode(error);
        await this.repository.failToolExecution(
          this.context.turnId,
          this.context.attempt,
          this.context.fenceToken,
          stepKey,
          reservation.execution.requestHash,
          code,
        );
        if (permitId) await this.callController.release(permitId, { success: false, errorCode: code });
        if (retry === 1 || !retryable(error)) break;
      }
    }
    throw lastError;
  }
}

export class ControlledFxClient implements FxPort {
  public constructor(
    private readonly source: FxPort,
    private readonly repository: ConversationRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly context: Omit<ProviderCallExecutionContext, "attemptNo">,
  ) {}

  public async getRate(base: string, signal?: AbortSignal): Promise<FxSnapshot> {
    const normalized = base.toUpperCase();
    const stepKey = `search:${this.context.operationId}:fx:${normalized}`;
    const request = { provider: "fxratesapi", base: normalized, quote: "CNY" };
    const reservation = await this.repository.reserveToolExecution(this.context.turnId, this.context.attempt, this.context.fenceToken, stepKey, request);
    if (!reservation) throw new Error("FX_TOOL_FENCE_REJECTED");
    if (reservation.action === "REUSE") return reservation.execution.result as unknown as FxSnapshot;
    if (reservation.action === "WAIT") throw Object.assign(new Error("FX_TOOL_IN_PROGRESS"), { retryable: true });
    let permitId: string | null = null;
    try {
      permitId = await this.callController.acquire({ ...this.context, stepKey, provider: "fxratesapi", isRetry: false });
      const result = await this.source.getRate(normalized, signal);
      const completed = await this.repository.completeToolExecution(
        this.context.turnId,
        this.context.attempt,
        this.context.fenceToken,
        stepKey,
        reservation.execution.requestHash,
        result as unknown as Record<string, unknown>,
      );
      if (!completed) throw new Error("FX_TOOL_RESULT_FENCE_REJECTED");
      await this.callController.release(permitId, { success: true });
      return result;
    } catch (error) {
      const code = errorCode(error);
      await this.repository.failToolExecution(this.context.turnId, this.context.attempt, this.context.fenceToken, stepKey, reservation.execution.requestHash, code);
      if (permitId) await this.callController.release(permitId, { success: false, errorCode: code });
      throw error;
    }
  }
}
