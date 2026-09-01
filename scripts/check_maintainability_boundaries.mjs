import { existsSync, readFileSync } from "node:fs";

const boundaries = [
  { file: "packages/domain/src/quote-conversation-types.ts", maxLines: 150, requires: ["QuoteConversationState", "QuoteTurnOperation"] },
  { file: "packages/domain/src/quote-validation.ts", maxLines: 80, requires: ["assertNoForbiddenPublicKey", "uniqueRefs"] },
  { file: "packages/domain/src/quote-publication.ts", maxLines: 180, requires: ["validatePublishedQuoteLeadSet", "validateQuoteAssistantPublication"] },
  { file: "packages/domain/src/quote-conversation-state.ts", maxLines: 120, requires: ["validateQuoteConversationState", "resolveQuoteLeadReferents"] },
  { file: "packages/domain/src/quote-admission.ts", maxLines: 190, requires: ["createQuoteObservation", "admitQuoteObservation"] },
  { file: "packages/domain/src/quote-grouping.ts", maxLines: 220, requires: ["groupQuoteObservations", "normalizeMerchantTargetUrl"] },
  { file: "packages/domain/src/quote-plan-policy.ts", maxLines: 220, requires: ["reviewQuoteTurnPlan"] },
  { file: "packages/agent/src/quote-turn-executor.ts", maxLines: 320, requires: ["./quote-reply-renderer.js", "QuoteConversationTurnExecutor"] },
  { file: "packages/agent/src/quote-reply-renderer.ts", maxLines: 220, requires: ["renderQuoteAssistantPublication"] },
  { file: "packages/agent/src/quote-planner-prompt.ts", maxLines: 60, requires: ["QUOTE_CONVERSATION_SYSTEM_PROMPT", "find_best_price_v2"] },
  { file: "packages/agent/src/quote-tool-protocol.ts", maxLines: 130, requires: ["QuoteToolProtocol", "./schemas.js"] },
  { file: "packages/agent/src/quote-turn-agent.ts", maxLines: 160, requires: ["./quote-context.js", "./quote-tool-protocol.js"] },
  { file: "packages/runtime/src/conversation-worker.ts", maxLines: 140, requires: ["runQuoteWorkerTurn", "heartbeatTurn"] },
  { file: "packages/runtime/src/quote-worker-turn-runner.ts", maxLines: 210, requires: ["executeQuoteConversationTurn", "QuoteTurnDataService"] },
  { file: "packages/runtime/src/postgres-conversation-repository.ts", maxLines: 270, requires: ["./postgres-conversation-store.js", "./postgres-turn-lifecycle.js", "./postgres-quote-turn-commit.js"] },
  { file: "packages/runtime/src/postgres-conversation-store.ts", maxLines: 240, requires: ["getPostgresConversationProjection", "listPostgresEvents"] },
  { file: "packages/runtime/src/postgres-conversation-storage.ts", maxLines: 310, requires: ["hydrateSnapshot", "LEGACY_CONVERSATION_RETIRED"] },
  { file: "packages/runtime/src/postgres-turn-submission.ts", maxLines: 360, requires: ["acceptPostgresTurn", "retryPostgresTurn", "ACTIVE_TURN_STATUSES"] },
  { file: "packages/runtime/src/postgres-turn-lifecycle.ts", maxLines: 380, requires: ["claimPostgresTurn", "markPostgresTurnRunning", "expireDuePostgresTurns"] },
  { file: "packages/runtime/src/postgres-turn-attempt-store.ts", maxLines: 110, requires: ["stagePostgresAttemptDraft", "recordPostgresPlanReview"] },
  { file: "packages/runtime/src/postgres-tool-execution-store.ts", maxLines: 150, requires: ["reservePostgresToolExecution", "completePostgresToolExecution"] },
  { file: "packages/runtime/src/postgres-quote-turn-commit.ts", maxLines: 290, requires: ["commitPostgresQuoteConversationTurn"] },
  { file: "packages/runtime/src/quote-turn-data-service.ts", maxLines: 140, requires: ["./quote-lookup-service.js", "./quote-lookup-repository.js", "./provider-call-controller.js"] },
  { file: "packages/runtime/src/quote-lookup-service.ts", maxLines: 230, requires: ["QuoteLookupService", "collectFx"] },
  { file: "packages/runtime/src/quote-lookup-repository.ts", maxLines: 280, requires: ["PostgresQuoteLookupRepository"] },
  { file: "packages/runtime/src/telemetry.ts", maxLines: 60, requires: ["./telemetry-runtime.js", "./turn-observability.js"] },
  { file: "packages/runtime/src/telemetry-runtime.ts", maxLines: 160, requires: ["startTelemetry", "NodeSDK"] },
  { file: "packages/runtime/src/turn-observability.ts", maxLines: 300, requires: ["observeConversationTurn", "observeTurnEnqueue", "observeTool"] },
  { file: "packages/runtime/src/agent-telemetry.ts", maxLines: 330, requires: ["createAgentEventObserver"] },
  { file: "packages/api/src/app.ts", maxLines: 70, requires: ["registerConversationRoutes", "registerConversationEventRoutes"] },
  { file: "packages/api/src/api-errors.ts", maxLines: 80, requires: ["installApiErrorHandler", "ConversationRepositoryError"] },
  { file: "packages/api/src/conversation-routes.ts", maxLines: 230, requires: ["registerConversationRoutes", "observeTurnEnqueue"] },
  { file: "packages/api/src/conversation-event-routes.ts", maxLines: 100, requires: ["registerConversationEventRoutes", "text/event-stream"] },
  { file: "frontend/src/App.tsx", maxLines: 80, requires: ["useQuoteConversation", "ConversationPane", "QuotePane"] },
  { file: "frontend/src/conversation/use-quote-conversation.ts", maxLines: 280, requires: ["streamConversation", "sendMessage", "retryFailed"] },
  { file: "frontend/src/conversation/presentation.ts", maxLines: 90, requires: ["displayError", "formatObservedAt"] },
  { file: "frontend/src/components/ConversationPane.tsx", maxLines: 170, requires: ["messageText", "submitComposer"] },
  { file: "frontend/src/components/QuoteCard.tsx", maxLines: 80, requires: ["打开商家页确认", "outboundUrl"] },
  { file: "frontend/src/components/QuotePane.tsx", maxLines: 120, requires: ["QuoteCard", "报价是线索"] },
  { file: "scripts/quote_live_acceptance_support.ts", maxLines: 400, requires: ["evaluateProviderResult", "runSonyReplayCase"] },
  { file: "scripts/quote_live_acceptance_controlled.ts", maxLines: 260, requires: ["runControlledAcceptanceCases", "ProviderCallControlError"] },
  { file: "scripts/quote_live_acceptance_history.ts", maxLines: 180, requires: ["loadHistoricalLiveAttempts", "selectLiveEvidence"] },
  { file: "scripts/run_quote_live_acceptance.ts", maxLines: 430, requires: ["runLiveCase", "overallDecision"] },
];

const failures = [];
for (const boundary of boundaries) {
  if (!existsSync(boundary.file)) {
    failures.push(`${boundary.file}: missing responsibility module`);
    continue;
  }
  const content = readFileSync(boundary.file, "utf8");
  const lineCount = content.split(/\r?\n/u).length;
  if (lineCount > boundary.maxLines) {
    failures.push(`${boundary.file}: ${lineCount} lines exceeds responsibility budget ${boundary.maxLines}`);
  }
  for (const marker of boundary.requires) {
    if (!content.includes(marker)) failures.push(`${boundary.file}: missing responsibility marker ${marker}`);
  }
}

if (failures.length > 0) {
  throw new Error(`maintainability boundaries:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`maintainability boundaries: ${boundaries.length} quote-only responsibility modules valid`);
