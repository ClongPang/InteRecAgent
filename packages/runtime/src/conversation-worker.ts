import { randomUUID } from "node:crypto";

import { QUOTE_LEAD_CONTRACT_VERSION } from "@retail-price/domain";

import type { ClaimedConversationTurn, ConversationRepository } from "./conversation-repository-types.js";
import type { FxPort } from "./fx-provider.js";
import type { PiModelRuntime } from "./model-factory.js";
import type { PostgresProviderCallController } from "./provider-call-controller.js";
import {
  runQuoteWorkerTurn,
  type AgentTraceCorrelation,
} from "./quote-worker-turn-runner.js";
import type { QuoteProvider } from "./quote-provider.js";
import { runtimeMetrics, type TurnObservationOutcome } from "./telemetry.js";

export type { AgentTraceCorrelation } from "./quote-worker-turn-runner.js";

export interface ConversationWorkerOptions {
  workerId?: string;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  traceCorrelation?: AgentTraceCorrelation | ((turn: ClaimedConversationTurn) => AgentTraceCorrelation);
}

/** Queue/lease loop for the sole active quote-lead worker. */
export class ConversationWorker {
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly traceCorrelation: ConversationWorkerOptions["traceCorrelation"];

  public constructor(
    private readonly repository: ConversationRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly fxSource: FxPort,
    private readonly quoteProvider: QuoteProvider,
    private readonly pi: PiModelRuntime,
    options: ConversationWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `quote-worker-${randomUUID()}`;
    this.leaseSeconds = options.leaseSeconds ?? 20;
    this.heartbeatSeconds = options.heartbeatSeconds ?? 5;
    this.traceCorrelation = options.traceCorrelation;
  }

  public async runOnce(turnId?: string): Promise<boolean> {
    const claimed = await this.repository.claimTurn(this.workerId, this.leaseSeconds, turnId);
    if (!claimed) return false;
    if (claimed.contractVersion !== QUOTE_LEAD_CONTRACT_VERSION) {
      throw new Error("LEGACY_CONVERSATION_RETIRED");
    }
    const traceCorrelation = typeof this.traceCorrelation === "function"
      ? this.traceCorrelation(claimed)
      : this.traceCorrelation;
    const processingStartedAt = performance.now();
    const createdAt = Date.parse(claimed.createdAt);
    if (Number.isFinite(createdAt)) {
      runtimeMetrics.queueWait.record(
        Math.max(0, Date.now() - createdAt) / 1000,
        { attempt: claimed.attempt },
      );
    }
    if (!await this.repository.markTurnRunning(claimed.id, claimed.attempt, claimed.fenceToken)) {
      runtimeMetrics.fenceRejectedWrites.add(1, { operation: "mark_turn_running" });
      return true;
    }

    const controller = new AbortController();
    const deadlineMs = Math.max(0, Date.parse(claimed.deadlineAt) - Date.now());
    const deadline = setTimeout(
      () => controller.abort(new Error("TURN_DEADLINE_EXCEEDED")),
      deadlineMs,
    );
    const heartbeat = setInterval(() => {
      void this.repository.heartbeatTurn(
        claimed.id,
        claimed.attempt,
        claimed.fenceToken,
        this.leaseSeconds,
      )
        .then((valid) => {
          if (!valid) controller.abort(new Error("TURN_FENCE_REJECTED"));
        })
        .catch(() => controller.abort(new Error("TURN_HEARTBEAT_FAILED")));
    }, this.heartbeatSeconds * 1000);
    heartbeat.unref();

    let outcome: TurnObservationOutcome = {
      status: "FAILED",
      committed: false,
      errorCode: "TURN_OBSERVATION_FAILED",
    };
    let route = "unknown";
    try {
      const result = await runQuoteWorkerTurn(claimed, {
        repository: this.repository,
        callController: this.callController,
        fxSource: this.fxSource,
        quoteProvider: this.quoteProvider,
        pi: this.pi,
        signal: controller.signal,
        ...(traceCorrelation ? { traceCorrelation } : {}),
      });
      outcome = result.outcome;
      route = result.route;
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      runtimeMetrics.turnDuration.record(
        (performance.now() - processingStartedAt) / 1000,
        { status: outcome.status, route },
      );
    }
    return true;
  }
}
