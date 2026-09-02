import { TraceFlags, trace } from "@opentelemetry/api";
import {
  getActiveSpanId,
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";

import { TELEMETRY_SERVICE_VERSION as SERVICE_VERSION } from "./runtime-metrics.js";
import {
  pseudonymousSessionId,
  pseudonymousUserId,
  redactTelemetryData,
  resolveTelemetryConfig,
  telemetryContent,
  telemetryErrorCode,
} from "./telemetry-safety.js";
import {
  assertDecisionProvenanceNonPii,
  decisionProvenanceMetadata,
  type TurnDecisionProvenance,
} from "./turn-decision-provenance.js";
import { projectTurnView } from "./turn-view-projection.js";

export interface TurnObservationOutcome {
  status: string;
  committed: boolean;
  errorCode?: string;
  /** Non-PII decision provenance ("why"), captured regardless of the content gate. */
  decision?: TurnDecisionProvenance;
  /** Assistant reply text. Content gate applied by the view projection. */
  replyText?: string;
}

export interface ConversationTurnObservation {
  turnId: string;
  conversationId: string;
  tenantId: string;
  ownerId: string;
  attempt: number;
  currentUserMessages: string[];
  causedByTraceId?: string;
  causedByObservationId?: string;
  correlation?: {
    datasetRunId?: string;
    datasetRunName?: string;
    datasetItemId?: string;
    experimentWrapperTraceId?: string;
    trialId?: string;
    taskId?: string;
    runIndex?: number;
    turnIndex?: number;
  };
}

export interface ActiveTurnObservation {
  traceId?: string;
  rootObservationId?: string;
}

function traceCorrelationMetadata(
  correlation: ConversationTurnObservation["correlation"],
): Record<string, string> {
  return Object.fromEntries(Object.entries(correlation ?? {}).flatMap(([key, value]) => (
    value === undefined ? [] : [[key, String(value)]]
  )));
}

function linkEnqueueCause(causedByTraceId?: string, causedByObservationId?: string): void {
  if (!causedByTraceId || !causedByObservationId) return;
  if (!/^[0-9a-f]{32}$/i.test(causedByTraceId) || !/^[0-9a-f]{16}$/i.test(causedByObservationId)) return;
  trace.getActiveSpan()?.addLink({
    context: {
      traceId: causedByTraceId.toLowerCase(),
      spanId: causedByObservationId.toLowerCase(),
      traceFlags: TraceFlags.SAMPLED,
    },
    attributes: { "retail_price.causality": "enqueue_to_attempt" },
  });
}

export async function observeTurnAttempt(
  turn: ConversationTurnObservation,
  operation: (active: ActiveTurnObservation) => Promise<TurnObservationOutcome>,
): Promise<TurnObservationOutcome> {
  const config = resolveTelemetryConfig();
  return propagateAttributes(
    {
      traceName: "conversation-turn-attempt",
      ...(config.pseudonymKey
        ? { userId: pseudonymousUserId(turn.tenantId, turn.ownerId, config.pseudonymKey) }
        : {}),
      ...(config.pseudonymKey
        ? { sessionId: pseudonymousSessionId(turn.conversationId, config.pseudonymKey) }
        : {}),
      version: SERVICE_VERSION,
      environment: config.environment,
      tags: ["conversation-agent", "pi-agent", "turn-attempt"],
      metadata: {
        turnId: turn.turnId,
        attempt: String(turn.attempt),
        engine: "pi-agent",
        projection: "turn-view-v1",
        ...(turn.causedByTraceId ? { causedByTraceId: turn.causedByTraceId } : {}),
        ...(turn.causedByObservationId ? { causedByObservationId: turn.causedByObservationId } : {}),
        ...traceCorrelationMetadata(turn.correlation),
      },
    },
    () => startActiveObservation(
      "execute-turn-attempt",
      async (observation) => {
        linkEnqueueCause(turn.causedByTraceId, turn.causedByObservationId);
        const activeTraceId = getActiveTraceId();
        const activeSpanId = getActiveSpanId();
        const active: ActiveTurnObservation = {
          ...(activeTraceId ? { traceId: activeTraceId } : {}),
          ...(activeSpanId ? { rootObservationId: activeSpanId } : {}),
        };
        const opening = projectTurnView({
          userMessages: turn.currentUserMessages,
          status: "STARTED",
        });
        observation.update({
          input: opening.input,
          metadata: {
            turnId: turn.turnId,
            attempt: turn.attempt,
            contentCaptureEnabled: config.captureContent,
            projection: "turn-view-v1",
            ...(turn.causedByTraceId ? { causedByTraceId: turn.causedByTraceId } : {}),
            ...(turn.causedByObservationId ? { causedByObservationId: turn.causedByObservationId } : {}),
            ...traceCorrelationMetadata(turn.correlation),
          },
        });
        try {
          const outcome = await operation(active);
          const decision = outcome.decision
            ? assertDecisionProvenanceNonPii(outcome.decision)
            : undefined;
          const view = projectTurnView({
            userMessages: turn.currentUserMessages,
            ...(outcome.replyText ? { replyText: outcome.replyText } : {}),
            status: outcome.status,
            ...(decision ? { decision } : {}),
          });
          observation.update({
            input: view.input,
            output: view.output,
            metadata: {
              turnId: turn.turnId,
              attempt: turn.attempt,
              contentCaptureEnabled: config.captureContent,
              projection: "turn-view-v1",
              scanLine: view.scanLine,
              ...(turn.causedByTraceId ? { causedByTraceId: turn.causedByTraceId } : {}),
              ...(turn.causedByObservationId ? { causedByObservationId: turn.causedByObservationId } : {}),
              ...traceCorrelationMetadata(turn.correlation),
              ...(decision ? decisionProvenanceMetadata(decision) : {}),
            },
            ...(outcome.status === "COMPLETED"
              ? {}
              : { level: "ERROR" as const, statusMessage: outcome.errorCode ?? outcome.status }),
          });
          return outcome;
        } catch (error) {
          observation.update({
            level: "ERROR",
            statusMessage: telemetryErrorCode(error),
            output: projectTurnView({
              userMessages: turn.currentUserMessages,
              status: "FAILED",
            }).output,
          });
          throw error;
        }
      },
      { asType: "agent" },
    ),
  );
}

export interface TurnEnqueueObservation {
  conversationId: string;
  tenantId: string;
  ownerId: string;
  operation: "accept_turn" | "retry_turn";
  inputType: string;
}

export interface ActiveTurnEnqueueObservation {
  traceId?: string;
  rootObservationId?: string;
}

export async function observeTurnEnqueue<T>(
  turn: TurnEnqueueObservation,
  operation: (active: ActiveTurnEnqueueObservation) => Promise<T>,
): Promise<T> {
  const config = resolveTelemetryConfig();
  return propagateAttributes({
    traceName: "conversation-turn-enqueue",
    ...(config.pseudonymKey
      ? { userId: pseudonymousUserId(turn.tenantId, turn.ownerId, config.pseudonymKey) }
      : {}),
    ...(config.pseudonymKey
      ? { sessionId: pseudonymousSessionId(turn.conversationId, config.pseudonymKey) }
      : {}),
    version: SERVICE_VERSION,
    environment: config.environment,
    tags: ["conversation-agent", "api", "turn-enqueue"],
    metadata: { operation: turn.operation, projection: "enqueue-accept" },
  }, () => startActiveObservation("conversation-turn-enqueue", async (root) => {
    const activeTraceId = getActiveTraceId();
    const rootObservationId = getActiveSpanId();
    const active: ActiveTurnEnqueueObservation = {
      ...(activeTraceId ? { traceId: activeTraceId } : {}),
      ...(rootObservationId ? { rootObservationId } : {}),
    };
    root.update({
      input: { operation: turn.operation, inputType: turn.inputType },
      metadata: { operation: turn.operation, asynchronous: true },
    });
    try {
      const result = await startActiveObservation("enqueue-turn", async (observation) => {
        observation.update({ input: { operation: turn.operation, inputType: turn.inputType } });
        try {
          const accepted = await operation(active);
          observation.update({ output: { accepted: true } });
          return accepted;
        } catch (error) {
          observation.update({
            level: "ERROR",
            statusMessage: telemetryErrorCode(error),
            output: { accepted: false },
          });
          throw error;
        }
      });
      const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const turnId = typeof resultRecord["id"] === "string" ? resultRecord["id"] : undefined;
      root.update({
        output: { accepted: true, ...(turnId ? { turnId } : {}) },
        ...(turnId ? { metadata: { operation: turn.operation, asynchronous: true, turnId } } : {}),
      });
      return result;
    } catch (error) {
      root.update({
        level: "ERROR",
        statusMessage: telemetryErrorCode(error),
        output: { accepted: false },
      });
      throw error;
    }
  }, { asType: "chain" }));
}

export async function observeTool<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  summarizeOutput: (result: T) => unknown,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  return startActiveObservation(
    `tool.${name}`,
    async (observation) => {
      observation.update({
        input: telemetryContent(input),
        metadata: { toolName: name, ...redactTelemetryData(metadata) as Record<string, unknown> },
      });
      try {
        const result = await operation();
        observation.update({ output: redactTelemetryData(summarizeOutput(result)) });
        return result;
      } catch (error) {
        const errorCode = telemetryErrorCode(error);
        observation.update({ level: "ERROR", statusMessage: errorCode, output: { errorCode } });
        throw error;
      }
    },
    { asType: "tool" },
  );
}

export async function observeTurnExecutorStep<T>(
  name: string,
  input: unknown,
  operation: () => Promise<T>,
  summarizeOutput: (result: T) => unknown,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  return startActiveObservation(
    `turn_executor.${name}`,
    async (observation) => {
      observation.update({
        input: telemetryContent(input),
        metadata: {
          turnExecutorStep: name,
          ...redactTelemetryData(metadata) as Record<string, unknown>,
        },
      });
      try {
        const result = await operation();
        observation.update({ output: redactTelemetryData(summarizeOutput(result)) });
        return result;
      } catch (error) {
        const errorCode = telemetryErrorCode(error);
        observation.update({ level: "ERROR", statusMessage: errorCode, output: { errorCode } });
        throw error;
      }
    },
    { asType: "span" },
  );
}
