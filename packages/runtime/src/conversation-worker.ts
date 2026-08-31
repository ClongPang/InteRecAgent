import { randomUUID } from "node:crypto";

import {
  CONVERSATION_PROMPT_NAME,
  CONVERSATION_PROMPT_SHA256,
  CONVERSATION_PROMPT_VERSION,
  executeConversationTurn,
  type AssistantEnvelopeProposal,
  type TurnPlanProposal,
} from "@interec/agent";
import { validateClarificationAnswer, type ConversationState, type SearchNeed } from "@interec/domain";

import { ConversationOfferSearchService } from "./conversation-offer-search-service.js";
import { PostgresConversationSearchRepository } from "./conversation-search-repository.js";
import type { ClaimedConversationTurn, ConversationMessageRecord, ConversationRepository, ConversationTurnInput } from "./conversation-repository-types.js";
import type { PiModelRuntime } from "./model-factory.js";
import { PiSemanticRelevanceClassifier } from "./semantic-relevance-classifier.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";
import type { FxPort, ProductSearchPort } from "./providers.js";
import { createRepositoryTurnSession } from "./repository-turn-session.js";
import { createAgentEventObserver, observeConversationTurn, recordSafetyBoundary, runtimeMetrics, telemetryErrorCode, type TurnObservationOutcome } from "./telemetry.js";
import type { LangfusePromptLink } from "./langfuse-prompt.js";

export interface ConversationWorkerOptions {
  workerId?: string;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  promptLink?: LangfusePromptLink;
  traceCorrelation?: AgentTraceCorrelation | ((turn: ClaimedConversationTurn) => AgentTraceCorrelation);
}

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

function inputText(input: ConversationTurnInput): string {
  if (input.type === "MESSAGE") return input.content;
  if (input.type === "PATCH_GOAL") return JSON.stringify({ action: "PATCH_GOAL", operations: input.operations });
  if (input.type === "UNDO") return JSON.stringify({ action: "UNDO", revision: input.revision });
  if (input.type === "SET_COMPARISON") return JSON.stringify({ action: "SET_COMPARISON", offerRefs: input.offerRefs });
  if (input.answer.type === "TEXT") return input.answer.text;
  return JSON.stringify({ action: "ANSWER_CLARIFICATION", clarificationId: input.clarificationId, answer: input.answer });
}

export function directPlanForTypedInputs(inputs: Array<Exclude<ConversationTurnInput, { type: "MESSAGE" }>>, state: ConversationState): TurnPlanProposal {
  const ops: TurnPlanProposal["ops"] = [];
  const canContinueInitialSearch = state.workingSet === null
    && Boolean(state.goalRevision?.goal.target)
    && (state.goalRevision?.goal.unresolved.length ?? 0) === 0;
  inputs.forEach((input, sourceMessageOrdinal) => {
    if (input.type === "PATCH_GOAL") {
      for (const operation of input.operations) ops.push({ ...operation, sourceMessageOrdinal } as TurnPlanProposal["ops"][number]);
    } else if (input.type === "UNDO") {
      ops.push({ opId: `typed-undo-${sourceMessageOrdinal}`, kind: "UNDO_REVISION", revision: input.revision });
    } else if (input.type === "SET_COMPARISON") {
      ops.push({
        opId: `typed-comparison-${sourceMessageOrdinal}`,
        kind: "SET_COMPARISON",
        referents: input.offerRefs.map((offerRef) => ({ kind: "OFFER_REF", offerRef })),
      });
    } else if (input.type === "ANSWER_CLARIFICATION") {
      const validated = validateClarificationAnswer(state.dialogue, input.clarificationId, input.answer);
      if (validated.answer.type === "OPTION" && validated.clarification.kind === "PURCHASE_MARKET") {
        ops.push({
          opId: `typed-clarification-market-${sourceMessageOrdinal}`,
          kind: "GOAL_SET_RETRIEVAL_MARKETS",
          sourceMessageOrdinal,
          markets: validated.goalValue as string[],
        });
        if (canContinueInitialSearch) {
          ops.push({
            opId: `typed-clarification-search-${sourceMessageOrdinal}`,
            kind: "SEARCH_OFFERS",
            reasonCode: "GOAL_BECAME_SEARCH_READY",
          });
        }
      } else if (validated.answer.type === "OPTION" && validated.clarification.kind === "CONDITION" && state.goalRevision?.goal.target) {
        ops.push({
          opId: `typed-clarification-condition-${sourceMessageOrdinal}`,
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal,
          target: { ...state.goalRevision.goal.target, condition: validated.goalValue as "NEW" | "ANY" },
        });
        if (canContinueInitialSearch && state.goalRevision.goal.retrievalMarkets.length > 0) {
          ops.push({
            opId: `typed-clarification-search-${sourceMessageOrdinal}`,
            kind: "SEARCH_OFFERS",
            reasonCode: "GOAL_BECAME_SEARCH_READY",
          });
        }
      } else if (validated.answer.type === "SKIP" && validated.clarification.kind === "PURCHASE_MARKET" && state.goalRevision?.goal.target) {
        ops.push({
          opId: `typed-clarification-search-${sourceMessageOrdinal}`,
          kind: "SEARCH_OFFERS",
          reasonCode: "INSUFFICIENT_COVERAGE",
          marketScope: ["US", "SG"],
          assumptionDisclosureCodes: ["PURCHASE_MARKET_SCOPE_ASSUMED"],
        });
      }
    }
  });
  return { userIntentSummary: "apply the complete ordered typed input batch", ops, leftover: [] };
}

function directEnvelope(): AssistantEnvelopeProposal {
  return {
    outcome: "CHAT",
    blocks: [{ type: "TRANSITION", transitionCode: "STATE_UPDATED" }],
    nextMoves: [],
  };
}

export function searchNeedForState(state: ConversationState): SearchNeed {
  if (!state.workingSet || state.workingSet.pool.length === 0) return "INSUFFICIENT_COVERAGE";
  if (state.goalRevision && state.workingSet.boundGoalVersion !== state.goalRevision.version) return "STALE";
  return "NOT_NEEDED";
}

function searchNeedFor(claimed: ClaimedConversationTurn): SearchNeed {
  return searchNeedForState(claimed.snapshot);
}

function isDegradedAssistantMessage(message: Awaited<ReturnType<ConversationRepository["listMessages"]>>[number]): boolean {
  if (message.role !== "ASSISTANT") return false;
  const envelope = message.payload["envelope"];
  return Boolean(envelope && typeof envelope === "object" && (envelope as Record<string, unknown>)["outcome"] === "DEGRADED");
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

export class ConversationWorker {
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly promptLink: LangfusePromptLink | undefined;
  private readonly traceCorrelation: ConversationWorkerOptions["traceCorrelation"];

  public constructor(
    private readonly repository: ConversationRepository,
    private readonly searchRepository: PostgresConversationSearchRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly productSource: ProductSearchPort,
    private readonly fxSource: FxPort,
    private readonly pi: PiModelRuntime,
    options: ConversationWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `conversation-worker-${randomUUID()}`;
    this.leaseSeconds = options.leaseSeconds ?? 20;
    this.heartbeatSeconds = options.heartbeatSeconds ?? 5;
    this.promptLink = options.promptLink;
    this.traceCorrelation = options.traceCorrelation;
  }

  public async runOnce(turnId?: string): Promise<boolean> {
    const claimed = await this.repository.claimTurn(this.workerId, this.leaseSeconds, turnId);
    if (!claimed) return false;
    const traceCorrelation = typeof this.traceCorrelation === "function"
      ? this.traceCorrelation(claimed)
      : this.traceCorrelation;
    const processingStartedAt = performance.now();
    const createdAt = Date.parse(claimed.createdAt);
    if (Number.isFinite(createdAt)) {
      runtimeMetrics.queueWait.record(Math.max(0, Date.now() - createdAt) / 1000, { attempt: claimed.attempt });
    }
    if (!await this.repository.markTurnRunning(claimed.id, claimed.attempt, claimed.fenceToken)) {
      runtimeMetrics.fenceRejectedWrites.add(1, { operation: "mark_turn_running" });
      return true;
    }
    const controller = new AbortController();
    const deadlineMs = Math.max(0, Date.parse(claimed.deadlineAt) - Date.now());
    const deadline = setTimeout(() => controller.abort(new Error("TURN_DEADLINE_EXCEEDED")), deadlineMs);
    const heartbeat = setInterval(() => {
      void this.repository.heartbeatTurn(claimed.id, claimed.attempt, claimed.fenceToken, this.leaseSeconds)
        .then((valid) => { if (!valid) controller.abort(new Error("TURN_FENCE_REJECTED")); })
        .catch(() => controller.abort(new Error("TURN_HEARTBEAT_FAILED")));
    }, this.heartbeatSeconds * 1000);
    heartbeat.unref();
    let outcome: TurnObservationOutcome = { status: "FAILED", committed: false, errorCode: "TURN_OBSERVATION_FAILED" };
    let route = "unknown";
    try {
      outcome = await observeConversationTurn({
        turnId: claimed.id,
        conversationId: claimed.conversationId,
        tenantId: claimed.owner.tenantId,
        ownerId: claimed.owner.ownerId,
        attempt: claimed.attempt,
        currentUserMessages: claimed.inputMessages.map((message) => inputText(message.payload as ConversationTurnInput)),
        traceId: claimed.telemetryTraceId,
        ...(claimed.telemetryRootObservationId ? { traceRootObservationId: claimed.telemetryRootObservationId } : {}),
        ...(traceCorrelation ? { correlation: traceCorrelation } : {}),
      }, async (activeObservation) => {
        if (activeObservation.traceId && activeObservation.rootObservationId) {
          try {
            const linked = await this.repository.recordAttemptTelemetryLink(
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
          const searchNeed = searchNeedFor(claimed);
          const turnInputs = claimed.inputMessages.map((message) => message.payload as ConversationTurnInput);
          const uiFocusOfferRef = turnInputs.flatMap((input) => input.type === "MESSAGE" && input.focusOfferRef ? [input.focusOfferRef] : []).at(-1);
          const allTyped = turnInputs.length > 0 && turnInputs.every((input) => input.type !== "MESSAGE"
            && !(input.type === "ANSWER_CLARIFICATION" && input.answer.type === "TEXT"));
          const shoppingData = new ConversationOfferSearchService(
            claimed,
            this.repository,
            this.searchRepository,
            this.callController,
            this.productSource,
            this.fxSource,
            undefined,
            new PiSemanticRelevanceClassifier(this.pi),
          );
          const session = createRepositoryTurnSession(this.repository, claimed, {
            searchNeed,
            shoppingData,
            planAuthority: allTyped ? "STRUCTURED_INPUT" : "PI_AGENT",
            ...(uiFocusOfferRef ? { requiredFocusOfferRef: uiFocusOfferRef } : {}),
          });
          if (allTyped) {
            const proposal = directPlanForTypedInputs(turnInputs as Array<Exclude<ConversationTurnInput, { type: "MESSAGE" }>>, claimed.snapshot);
            const committed = await session.controller.commitPlan(proposal);
            route = committed.route;
            const receipts = [];
            for (const operation of committed.plan.ops) receipts.push(await session.controller.executeOperation(operation, controller.signal));
            if (committed.plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS")) {
              await session.controller.fallbackReply("DIRECT_TYPED_PUBLICATION", committed.plan, receipts);
            } else {
              await session.controller.publishReply(directEnvelope());
            }
          } else {
            const timeline = await this.repository.listMessages(claimed.conversationId, claimed.owner, 0);
            const currentIds = new Set(claimed.inputMessages.map((message) => message.id));
            const adjacent = latestCompletedUserAssistantExchange(timeline, currentIds);
            const agentStartedAt = performance.now();
            const currentUserMessages = claimed.inputMessages.map((message) => inputText(message.payload as ConversationTurnInput));
            const agentEventObserver = createAgentEventObserver({
              promptName: CONVERSATION_PROMPT_NAME,
              promptVersion: CONVERSATION_PROMPT_VERSION,
              promptSha256: CONVERSATION_PROMPT_SHA256,
              ...(this.promptLink ? { promptLink: this.promptLink } : {}),
            });
            let agentResult;
            try {
              agentResult = await executeConversationTurn({
                model: this.pi.model,
                streamFn: this.pi.streamFn,
                apiKey: this.pi.apiKey,
                controller: session.controller,
                context: {
                  state: claimed.snapshot,
                  currentUserMessages,
                  ...(uiFocusOfferRef ? { uiFocusOfferRef } : {}),
                  recentAdjacentPair: adjacent,
                  capabilities: ["conversation", "clarification", "goal", "working_set", "comparison", "search", "undo"],
                  now: new Date().toISOString(),
                  modelId: String(this.pi.model.id),
                  providerCallBudget: 1,
                },
                sessionId: `${claimed.id}:${claimed.attempt}`,
                signal: controller.signal,
                onEvent: agentEventObserver.onEvent,
                onModelCall: agentEventObserver.onModelCall,
                observeToolCall: agentEventObserver.observeToolCall,
              });
            } finally {
              agentEventObserver.finish();
            }
            route = agentResult.route ?? "unknown";
            runtimeMetrics.invokeAgentDuration.record((performance.now() - agentStartedAt) / 1000, { route });
            runtimeMetrics.inferenceCalls.record(agentResult.modelInferences, { route });
            runtimeMetrics.toolCalls.record(agentResult.toolCalls, { route, fallback: agentResult.usedFallback });
            if (agentResult.fallbackReasonCode) {
              recordSafetyBoundary(telemetryErrorCode(new Error(agentResult.fallbackReasonCode), "PI_AGENT_INCOMPLETE"));
            }
          }
          if (!session.getCommitResult()) throw new Error("TURN_DID_NOT_PUBLISH");
          return { status: "COMPLETED", committed: true };
        } catch (error) {
          const code = telemetryErrorCode(error, "TURN_EXECUTION_FAILED");
          recordSafetyBoundary(code);
          const failed = await this.repository.failTurn(claimed.id, claimed.attempt, claimed.fenceToken, code);
          if (!failed) runtimeMetrics.fenceRejectedWrites.add(1, { operation: "fail_turn" });
          return { status: "FAILED", committed: false, errorCode: code };
        }
      });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      runtimeMetrics.turnDuration.record((performance.now() - processingStartedAt) / 1000, { status: outcome.status, route });
    }
    return true;
  }
}
