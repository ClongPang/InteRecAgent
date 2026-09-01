import type { FxSnapshot } from "@interec/domain";

import type { ConversationRepository } from "./conversation-repository-types.js";
import type { FxPort } from "./fx-provider.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";

export interface ProviderCallExecutionContext {
  tenantId: string;
  turnId: string;
  attempt: number;
  fenceToken: string;
  operationId: string;
}

function errorCode(error: unknown): string {
  return error instanceof Error
    ? error.message.match(/[A-Z][A-Z0-9_]{2,99}/u)?.[0] ?? "PROVIDER_FAILED"
    : "PROVIDER_FAILED";
}

export class ControlledFxClient implements FxPort {
  public constructor(
    private readonly source: FxPort,
    private readonly repository: ConversationRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly context: ProviderCallExecutionContext,
  ) {}

  public async getRate(base: string, signal?: AbortSignal): Promise<FxSnapshot> {
    const normalized = base.toUpperCase();
    const stepKey = `quote:${this.context.operationId}:fx:${normalized}`;
    const request = { provider: "fxratesapi", base: normalized, quote: "CNY" };
    const reservation = await this.repository.reserveToolExecution(
      this.context.turnId,
      this.context.attempt,
      this.context.fenceToken,
      stepKey,
      request,
    );
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
      await this.repository.failToolExecution(
        this.context.turnId,
        this.context.attempt,
        this.context.fenceToken,
        stepKey,
        reservation.execution.requestHash,
        code,
      );
      if (permitId) await this.callController.release(permitId, { success: false, errorCode: code });
      throw error;
    }
  }
}
