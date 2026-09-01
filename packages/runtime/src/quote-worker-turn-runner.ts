import {
  QUOTE_CONVERSATION_PROMPT_NAME,
  QUOTE_CONVERSATION_PROMPT_SHA256,
  QUOTE_CONVERSATION_PROMPT_VERSION,
  executeQuoteConversationTurn,
} from "@interec/agent";

import type {
  ClaimedConversationTurn,
  ConversationMessageRecord,
  ConversationRepository,
  ConversationTurnInput,
} from "./conversation-repository-types.js";
import type { FxPort } from "./fx-provider.js";
import type { PiModelRuntime } from "./model-factory.js";
import type { PostgresProviderCallController } from "./provider-call-controller.js";
import { createQuoteRepositoryTurnSession } from "./quote-repository-turn-session.js";
import { QuoteTurnDataService } from "./quote-turn-data-service.js";
import type { QuoteProvider } from "./quote-provider.js";
import {
  createAgentEventObserver,
  observeConversationTurn,
  recordSafetyBoundary,
  runtimeMetrics,
  telemetryErrorCode,
  type TurnObservationOutcome,
} from "./telemetry.js";

export interface AgentTraceCorrelation {
  datasetRunId?: string;
  datasetRunName?: string;
  datasetItemId?: string;
  experimentWrapperTraceId?: string;
  trialId?: string;
  taskId?: string;
  runIndex?: number;
  turnIndex?: number;
}

export interface QuoteWorkerTurnRunnerOptions {
  repository: ConversationRepository;
  callController: PostgresProviderCallController;
  fxSource: FxPort;
  quoteProvider: QuoteProvider;
  pi: PiModelRuntime;
  signal: AbortSignal;
  traceCorrelation?: AgentTraceCorrelation;
}

function inputText(input: ConversationTurnInput): string {
  if (input.type !== "MESSAGE") throw new Error("QUOTE_MESSAGE_INPUT_REQUIRED");
  return input.content;
}

function isDegradedAssistantMessage(message: ConversationMessageRecord): boolean {
  if (message.role !== "ASSISTANT") return false;
  const envelope = message.payload["envelope"];
  return Boolean(
    envelope
    && typeof envelope === "object"
    && (envelope as Record<string, unknown>)["outcome"] === "DEGRADED",
  );
}

export function latestCompletedUserAssistantExchange(
  timeline: ConversationMessageRecord[],
  currentMessageIds: ReadonlySet<string>,
): Array<{ role: "USER" | "ASSISTANT"; content: string }> {
  const history = timeline.filter((message) => !currentMessageIds.has(message.id));
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const assistant = history[index];
    if (!assistant || assistant.role !== "ASSISTANT" || isDegradedAssistantMessage(assistant)) continue;
    const user = history[index - 1];
    if (!user || user.role !== "USER") continue;
    return [user, assistant].map((message) => ({
      role: message.role,
      content: String(message.payload["content"] ?? message.payload["text"] ?? ""),
    }));
  }
  return [];
}

export async function runQuoteWorkerTurn(
  claimed: ClaimedConversationTurn,
  options: QuoteWorkerTurnRunnerOptions,
): Promise<{ outcome: TurnObservationOutcome; route: string }> {
  let route = "unknown";
  const currentUserMessages = claimed.inputMessages.map((message) => (
    inputText(message.payload as unknown as ConversationTurnInput)
  ));
  const outcome = await observeConversationTurn({
    turnId: claimed.id,
    conversationId: claimed.conversationId,
    tenantId: claimed.owner.tenantId,
    ownerId: claimed.owner.ownerId,
    attempt: claimed.attempt,
    currentUserMessages,
    traceId: claimed.telemetryTraceId,
    ...(claimed.telemetryRootObservationId
      ? { traceRootObservationId: claimed.telemetryRootObservationId }
      : {}),
    ...(options.traceCorrelation ? { correlation: options.traceCorrelation } : {}),
  }, async (activeObservation) => {
    if (activeObservation.traceId && activeObservation.rootObservationId) {
      try {
        const linked = await options.repository.recordAttemptTelemetryLink(
          claimed.id,
          claimed.attempt,
          claimed.fenceToken,
          activeObservation.traceId,
          activeObservation.rootObservationId,
        );
        if (!linked) runtimeMetrics.telemetryLinkFailures.add(1, { operation: "record_attempt_link" });
      } catch {
        runtimeMetrics.telemetryLinkFailures.add(1, { operation: "record_attempt_link" });
      }
    }
    try {
      const timeline = await options.repository.listMessages(claimed.conversationId, claimed.owner, 0);
      const currentIds = new Set(claimed.inputMessages.map((message) => message.id));
      const adjacent = latestCompletedUserAssistantExchange(timeline, currentIds);
      const quoteData = new QuoteTurnDataService(
        claimed,
        options.repository,
        options.callController,
        options.quoteProvider,
        options.fxSource,
      );
      const session = createQuoteRepositoryTurnSession(options.repository, claimed, quoteData);
      const agentEventObserver = createAgentEventObserver({
        promptName: QUOTE_CONVERSATION_PROMPT_NAME,
        promptVersion: QUOTE_CONVERSATION_PROMPT_VERSION,
        promptSha256: QUOTE_CONVERSATION_PROMPT_SHA256,
      });
      const agentStartedAt = performance.now();
      let agentResult;
      try {
        agentResult = await executeQuoteConversationTurn({
          model: options.pi.model,
          streamFn: options.pi.streamFn,
          apiKey: options.pi.apiKey,
          executor: session.executor,
          context: {
            state: claimed.snapshot.quote,
            currentUserMessages,
            recentAdjacentPair: adjacent,
            now: new Date().toISOString(),
            modelId: String(options.pi.model.id),
            providerCallBudget: 1,
          },
          sessionId: `${claimed.id}:${claimed.attempt}:quote`,
          signal: options.signal,
          onEvent: agentEventObserver.onEvent,
          onModelCall: agentEventObserver.onModelCall,
          observeToolCall: agentEventObserver.observeToolCall,
        });
      } finally {
        agentEventObserver.finish();
      }
      route = agentResult.route ?? "quote_fallback";
      runtimeMetrics.invokeAgentDuration.record((performance.now() - agentStartedAt) / 1000, { route });
      runtimeMetrics.inferenceCalls.record(agentResult.modelInferences, { route });
      runtimeMetrics.toolCalls.record(agentResult.toolCalls, { route, fallback: agentResult.usedFallback });
      if (agentResult.fallbackReasonCode) {
        recordSafetyBoundary(
          telemetryErrorCode(new Error(agentResult.fallbackReasonCode), "QUOTE_AGENT_INCOMPLETE"),
        );
      }
      if (!session.getCommitResult()) throw new Error("QUOTE_TURN_DID_NOT_PUBLISH");
      return { status: "COMPLETED", committed: true };
    } catch (error) {
      const code = telemetryErrorCode(error, "TURN_EXECUTION_FAILED");
      recordSafetyBoundary(code);
      const failed = await options.repository.failTurn(
        claimed.id,
        claimed.attempt,
        claimed.fenceToken,
        code,
      );
      if (!failed) runtimeMetrics.fenceRejectedWrites.add(1, { operation: "fail_turn" });
      return { status: "FAILED", committed: false, errorCode: code };
    }
  });
  return { outcome, route };
}
