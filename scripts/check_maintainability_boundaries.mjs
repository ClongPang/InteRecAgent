import { existsSync, readFileSync } from "node:fs";

const boundaries = [
  { file: "packages/domain/src/quote-conversation-types.ts", maxLines: 150, requires: ["QuoteConversationState", "QuoteTurnOperation"] },
  { file: "packages/domain/src/product-identity.ts", maxLines: 260, requires: ["ProductIdentitySnapshot", "validateProductIdentitySnapshot", "QuoteTargetIdentityBinding"] },
  { file: "packages/domain/src/product-identity-registry.ts", maxLines: 250, requires: ["ProductIdentityRegistry", "resolveProductIdentity", "USER_CONFIRMED_LITERAL"] },
  { file: "packages/domain/src/quote-command-decision.ts", maxLines: 180, requires: ["decideQuoteCommand", "EFFECT_REQUIRED", "validateQuoteConversationState"] },
  { file: "packages/domain/src/quote-effects.ts", maxLines: 150, requires: ["QuoteEffect", "applyQuoteEffectResult", "QuoteProviderInvocation", "pre-effect state"] },
  { file: "packages/domain/src/quote-validation.ts", maxLines: 80, requires: ["assertNoForbiddenPublicKey", "uniqueRefs"] },
  { file: "packages/domain/src/quote-publication.ts", maxLines: 180, requires: ["validatePublishedQuoteLeadSet", "validateQuoteAssistantPublication"] },
  { file: "packages/domain/src/quote-conversation-state.ts", maxLines: 120, requires: ["validateQuoteConversationState", "resolveQuoteLeadReferents"] },
  { file: "packages/domain/src/quote-admission.ts", maxLines: 190, requires: ["createQuoteObservation", "admitQuoteObservation"] },
  { file: "packages/domain/src/offer-identity.ts", maxLines: 190, requires: ["resolveOfferIdentity", "PROBABILISTIC_CANDIDATE", "STRONG_IDENTIFIER_MATCH"] },
  { file: "packages/domain/src/quote-target.ts", maxLines: 160, requires: ["resolveQuoteTarget", "Host-bound resolver output", "identityBindingFromResolution"] },
  { file: "packages/domain/src/quote-grouping.ts", maxLines: 220, requires: ["groupQuoteObservations", "normalizeMerchantTargetUrl"] },
  { file: "packages/domain/src/quote-plan-policy.ts", maxLines: 220, requires: ["reviewQuoteTurnPlan"] },
  { file: "packages/agent/src/identity-hypothesis.ts", maxLines: 210, requires: ["reviewIdentityHypothesis", "IDENTITY_CANDIDATE_NOT_ALLOWED", "confidence"] },
  { file: "packages/agent/src/quote-plan-binding.ts", maxLines: 90, requires: ["bindQuotePlan", "resolveProductIdentity", "identityResolution"] },
  { file: "packages/agent/src/quote-turn-executor.ts", maxLines: 230, requires: ["./quote-reply-renderer.js", "QuoteConversationTurnExecutor", "decideQuoteCommand", "applyQuoteEffectResult"] },
  { file: "packages/agent/src/quote-reply-renderer.ts", maxLines: 220, requires: ["renderQuoteAssistantPublication"] },
  { file: "packages/agent/src/quote-planner-prompt.ts", maxLines: 60, requires: ["QUOTE_CONVERSATION_SYSTEM_PROMPT", "find_best_price_v2"] },
  { file: "packages/agent/src/quote-tool-protocol.ts", maxLines: 130, requires: ["QuoteToolProtocol", "./schemas.js"] },
  { file: "packages/agent/src/quote-turn-agent.ts", maxLines: 160, requires: ["./quote-context.js", "./quote-tool-protocol.js"] },
  { file: "packages/runtime/src/conversation-worker.ts", maxLines: 140, requires: ["runQuoteWorkerTurn", "heartbeatTurn"] },
  { file: "packages/runtime/src/quote-worker-turn-runner.ts", maxLines: 250, requires: ["executeQuoteConversationTurn", "QuoteTurnDataService", "assembleQuoteTurnDecision"] },
  { file: "packages/runtime/src/postgres-conversation-repository.ts", maxLines: 270, requires: ["./postgres-conversation-store.js", "./postgres-turn-lifecycle.js", "./postgres-quote-turn-commit.js"] },
  { file: "packages/runtime/src/postgres-conversation-store.ts", maxLines: 240, requires: ["getPostgresConversationProjection", "listPostgresEvents"] },
  { file: "packages/runtime/src/postgres-conversation-storage.ts", maxLines: 310, requires: ["hydrateSnapshot", "LEGACY_CONVERSATION_RETIRED"] },
  { file: "packages/runtime/src/postgres-turn-submission.ts", maxLines: 360, requires: ["acceptPostgresTurn", "retryPostgresTurn", "ACTIVE_TURN_STATUSES"] },
  { file: "packages/runtime/src/postgres-turn-lifecycle.ts", maxLines: 380, requires: ["claimPostgresTurn", "markPostgresTurnRunning", "expireDuePostgresTurns"] },
  { file: "packages/runtime/src/postgres-turn-attempt-store.ts", maxLines: 110, requires: ["stagePostgresAttemptDraft", "recordPostgresPlanReview"] },
  { file: "packages/runtime/src/postgres-tool-execution-store.ts", maxLines: 150, requires: ["reservePostgresToolExecution", "completePostgresToolExecution"] },
  { file: "packages/runtime/src/postgres-quote-turn-commit.ts", maxLines: 290, requires: ["commitPostgresQuoteConversationTurn"] },
  { file: "packages/runtime/src/quote-turn-data-service.ts", maxLines: 140, requires: ["./quote-lookup-service.js", "./quote-lookup-repository.js", "./provider-call-controller.js"] },
  { file: "packages/runtime/src/quote-lookup-observability.ts", maxLines: 50, requires: ["observeQuoteLookupHost", "providerFailureCode", "cacheHit", "ATTEMPT_REPLAY"] },
  { file: "packages/runtime/src/buywhere-mcp-quote-client.ts", maxLines: 120, requires: ["observeBuyWhereProviderCall", "find_best_price_v2", "BUYWHERE_TIMEOUT"] },
  { file: "packages/runtime/src/buywhere-provider-observability.ts", maxLines: 130, requires: ["tool.provider.buywhere.find_best_price_v2", "providerFailureCode", "providerRequestId", "providerErrors"] },
  { file: "packages/runtime/src/postgres-product-identity-registry.ts", maxLines: 230, requires: ["PostgresProductIdentityRegistry", "REPEATABLE READ", "validateProductIdentitySnapshot"] },
  { file: "packages/runtime/src/identity-resolution-observability.ts", maxLines: 90, requires: ["compareIdentityResolutionShadow", "identityShadowDisagreements", "no second production resolver"] },
  { file: "packages/runtime/src/quote-lookup-service.ts", maxLines: 230, requires: ["QuoteLookupService", "collectFx"] },
  { file: "packages/runtime/src/quote-lookup-repository.ts", maxLines: 280, requires: ["PostgresQuoteLookupRepository"] },
  { file: "packages/runtime/src/telemetry.ts", maxLines: 90, requires: ["./telemetry-runtime.js", "./turn-observability.js", "./turn-decision-provenance.js", "./quote-turn-decision-provenance.js", "./turn-view-projection.js", "./quote-turn-decision-score.js"] },
  { file: "packages/runtime/src/telemetry-runtime.ts", maxLines: 160, requires: ["startTelemetry", "NodeSDK"] },
  { file: "packages/runtime/src/process-lifecycle.ts", maxLines: 45, requires: ["waitForTerminationSignal", "SIGINT", "SIGTERM"] },
  { file: "packages/runtime/src/turn-observability.ts", maxLines: 320, requires: ["observeTurnAttempt", "observeTurnEnqueue", "observeTool", "projectTurnView"] },
  { file: "packages/runtime/src/agent-trace-model.ts", maxLines: 320, requires: ["AgentCausalityLedger", "buildAgentModelBoundaryManifest", "canonicalTraceJson"] },
  { file: "packages/runtime/src/agent-trace-rendering.ts", maxLines: 120, requires: ["telemetryModelInput", "tool_calls", "tool_call_id"] },
  { file: "packages/runtime/src/turn-decision-provenance.ts", maxLines: 150, requires: ["TurnDecisionProvenance", "assertDecisionProvenanceNonPii", "DecisionStateSnapshot", "catalogIdentityCode"] },
  { file: "packages/runtime/src/turn-view-projection.ts", maxLines: 80, requires: ["projectTurnView", "CONTENT_NOT_CAPTURED"] },
  { file: "packages/runtime/src/quote-turn-decision-score.ts", maxLines: 70, requires: ["scoreQuoteTurnDecision"] },
  { file: "packages/runtime/src/quote-turn-decision-provenance.ts", maxLines: 220, requires: ["buildQuoteTurnDecisionProvenance", "deriveTargetLifecycle", "assembleQuoteTurnDecision", "appliedProviderObservation"] },
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
  { file: "scripts/quote_live_acceptance_identity.ts", maxLines: 40, requires: ["summarizeAdmissionIdentity", "PUBLISHABLE_IDENTITY_STRENGTHS"] },
  { file: "scripts/run_quote_live_acceptance.ts", maxLines: 430, requires: ["runLiveCase", "overallDecision"] },
  { file: "scripts/run_identity_grounded_trajectories.ts", maxLines: 380, requires: ["validateSpec", "runSuccessfulTrajectories", "runRejectedPlans", "scoreQuoteTurnDecision"] },
  { file: "scripts/run_identity_resolution_shadow_replay.ts", maxLines: 120, requires: ["compareIdentityResolutionShadow", "unapproved recall expansion", "STRONG_IDENTIFIER_MATCH"] },
  { file: "scripts/run_identity_mutations.ts", maxLines: 260, requires: ["critical mutants killed", "provider_call_budget_allows_two", "probabilistic_offer_becomes_publishable"] },
  { file: "scripts/identity-grounded-trajectory-fixtures.ts", maxLines: 100, requires: ["ProviderFixture", "providerResult", "resolveFixtureTarget"] },
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
