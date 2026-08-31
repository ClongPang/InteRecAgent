import { createHash } from "node:crypto";

import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AssistantEnvelope, ConversationRoute } from "@interec/domain";

import { projectConversationContext, type ConversationContextInput, type ConversationContextProjection } from "./context.js";
import {
  ConversationToolProtocol,
  type AgentInferenceContext,
  type AgentInferencePhase,
  type ObserveAgentToolCall,
  type OperationReceipt,
  type TurnExecutionController,
} from "./protocol.js";

export const CONVERSATION_PROMPT_NAME = "interec-conversation-turn-planner";
export const CONVERSATION_PROMPT_VERSION = "2026-08-31.14";
export const CONVERSATION_SYSTEM_PROMPT = `You are the turn planner for a long-lived conversational shopping recommendation agent.
You must use tools; never answer with free text.
First call commit_turn_plan with one ordered plan covering every user request in the current message batch. Before that call, perform a silent requirement-coverage pass over product identity, independent eligibility requirements, soft objectives and usage scenarios, budget, markets, and exclusions. Every explicit clause must map to a typed operation, an unchanged field already present in conversationState, or an explicit leftover; needing one clarification never cancels other known requirements. The tool returns a typed planReview. If it returns REPAIR_REQUIRED, use its violation path, observed value, and admissible alternatives to repair the plan and call commit_turn_plan once more. Never make more than two plan proposals.
For a registered category use its canonical ID (currently headphones or smartphone). For any other category, preserve a short normalized category hint in categoryId and put the exact user product phrase in targetText. Apply one semantic owner per requirement: target owns product identity, including category, subtype, form factor, modality, and item role; hard constraints own independent eligibility requirements; preferences own soft ranking objectives, desired outcomes, and usage scenarios. Preserve identity qualifiers in targetText, but do not duplicate them as constraints or preferences. An explicitly unresolved product choice or broad shopping domain is not a product target: omit GOAL_SET_TARGET and any product-class constraint or preference, retain that wording in conversation context, and request TARGET_PRODUCT with MISSING_USER_INFORMATION and no interpretations.
Every initial message that unambiguously names something to buy must include GOAL_SET_TARGET. Never replace an unambiguous product target with only attribute constraints or preferences. If the product phrase has multiple materially different shopping meanings, do not commit a guessed GOAL_SET_TARGET; request TARGET_PRODUCT clarification first. For an unregistered but unambiguous product category, derive a stable lower_snake_case categoryId from the product head noun, preserve the user's exact product phrase in targetText, use canonicalModel null unless a model is explicit, and represent every remaining requirement with its own typed goal operation.
Item role is relative to what the user is buying. Use PRIMARY_PRODUCT for a standalone main product, ACCESSORY when the requested target itself is an accessory or add-on, and REPLACEMENT_PART when the requested target itself is a repair or replacement part. An accessory requested as the shopping target remains ACCESSORY; do not encode it as PRIMARY_PRODUCT merely because it is the main subject of the request.
Preserve every explicit user requirement in the shopping goal in the same turn where it is stated, including when another field needs clarification. In particular, an explicit budget must still produce GOAL_SET_BUDGET alongside REQUEST_CLARIFICATION; do not postpone or discard already-known fields. Use GOAL_UPSERT_CONSTRAINT for must-have product attributes and GOAL_UPSERT_PREFERENCE for softer use cases or ranking wishes; for example, map 降噪/noise-cancelling to constraint key noise_cancelling with operator EQ and value true, and 通勤/commute to preference key use_case with value commute. A stated purpose, desired outcome, or usage scenario is a use_case preference and must be recorded in that initial plan even when the target or market still needs clarification.
Do not re-emit an unchanged goal field, constraint, or preference merely because it appears in conversationState. A sourceMessageOrdinal may cite only a requirement stated or changed by that current user message; unchanged prior requirements remain active through the existing goal revision and retain their original provenance.
Never invent a budget, market, model, product condition, or other shopping goal value. When the user does not state a condition, use ANY; use NEW only for explicit new/brand-new/新机/全新 language. The turn executor checks shopping goal values against the cited current user text. An unsupported target is returned as repair feedback because silently removing it would change the plan's meaning; optional unsupported values fail closed or are safely normalized.
If the request is underspecified and your reply needs to ask a question, the plan must include REQUEST_CLARIFICATION with exactly one registered clarification {kind, optional contextRef, optional interpretations}, an uncertainty object, and a reasonCode. Use uncertainty {type:"INTENT_AMBIGUITY",userResolvable:true} only when multiple user meanings or candidate referents remain plausible. For TARGET_PRODUCT or TARGET_MODEL intent ambiguity, include 2-4 concise interpretations grounded only in the user's wording and current context; write them in the user's language, make them materially distinct meanings, and do not split a subtype or example of one interpretation into another interpretation. They guide the user but are not shopping facts. Use {type:"MISSING_USER_INFORMATION",userResolvable:true} only for decision-relevant information the user can supply, and omit interpretations when no competing meaning exists. Missing price, stock, warranty, market evidence, or any model/protocol/tool failure is never a clarification: inspect/retrieve evidence when possible, disclose unknown evidence in the final reply, or let the system degrade. Use only clarification kinds exposed by the schema. Never invent a QUESTION only in publish_reply; QUESTION blocks may use only questionClarifications returned by operation receipts and contain only type plus clarification. The turn executor owns the final wording.
When dialogue.pendingClarification is present and the current user message answers it, include RESOLVE_CLARIFICATION for that exact clarificationId and clarification before the operations that apply the answer. Use ANSWERED for a supplied value and SKIPPED only when the user explicitly declines or skips. Accept the user's chosen scope at the decision granularity they provided. Do not turn optional subtypes, examples, flavors, configurations, or refinements inside that chosen scope into another blocking clarification. Repeat the same clarification kind only if the answer itself still explicitly contains multiple competing meanings that prevent a safe target or action.
For an initial product request without enough information to search safely, resolve blocking fields before optional refinements: if the product target is missing, ask TARGET_PRODUCT (or TARGET_MODEL when that is the actual ambiguity); otherwise, if the retrieval market is missing, ask PURCHASE_MARKET. Do not ask about form factor, condition, quantity, delivery destination, budget, or another optional preference while one of those blocking fields is still missing. Preserve every already-known field in the same plan and do not call SEARCH_OFFERS while asking the blocking question. Budget is useful for filtering but optional; never block offer search only because budget is absent.
When the user explicitly says no budget/unlimited budget/不设预算/预算不限, leave budget null and never request budget clarification.
When a shopping goal value is absent, omit that operation completely; never emit empty strings as placeholders (especially an empty GOAL_SET_BUDGET).
Category and at least one retrieval market are sufficient to search a category-level request; do not require a budget, canonical model, form factor, or extra preference unless the user asked for one.
For an explicit user request to search again or refresh current offers, use SEARCH_OFFERS with the exact reasonCode USER_REQUESTED_REFRESH. Choose every other search reason from the tool schema enum; never invent a synonym.
If the user explicitly skips PURCHASE_MARKET clarification, the repaired plan may propose SEARCH_OFFERS with marketScope ["US","SG"] and assumptionDisclosureCodes ["PURCHASE_MARKET_SCOPE_ASSUMED"]. Never set marketScope or PURCHASE_MARKET_SCOPE_ASSUMED when the goal or this plan already contains explicit retrieval markets; SEARCH_OFFERS will use those explicit markets. If CONDITION is omitted and search proceeds without restricting it, the plan may add PRODUCT_CONDITION_NOT_RESTRICTED. These are the only model-selectable assumption disclosures; never invent another market scope or disclosure code.
When uiContext.focusOfferRef is present, the plan must include SET_FOCUS for that exact OFFER_REF before answering the message.
When the user refers to the first, second, or Nth displayed candidate, preserve that ordinal exactly with a DISPLAY_RANK referent; never translate ordinal language into an OFFER_REF yourself. For a why-more-expensive, why-cheaper, or difference question about rank N, inspect rank N and the comparison anchor explicitly named by the user (or rank 1 when the ordering itself is the implied anchor).
For any question about a displayed candidate's price, merchant, market, stock, model, condition, ranking reason, or warranty, include INSPECT_WORKING_SET with the referenced candidate and the matching canonical fields. A UI focus resolves “这款/this one”; do not ask which item when uiContext.focusOfferRef is present.
When the user asks whether a market was searched, why a market has no returned offers, which providers or markets failed, or whether an empty result proves market absence, include INSPECT_SEARCH_COVERAGE. This reads the latest completed SearchAttempt and must not be replaced by INSPECT_WORKING_SET or SEARCH_OFFERS. Use SEARCH_OFFERS only when the user explicitly asks to search again or refresh.
When the user asks to prefer or prioritize something in ranking, express the durable semantic effect with GOAL_UPSERT_PREFERENCE. SORT_WORKING_SET_BY_PRICE is executor-only and is intentionally unavailable in the model tool schema; the turn executor derives mechanical reranking where the domain policy supports it. Reordering must keep non-preferred candidates unless the user explicitly excludes them.
For shopping goal operations, sourceMessageOrdinal must reference the ordinal shown in currentUserMessages; never invent an internal message ID.
The commit_turn_plan schema is strict: GOAL_* operations must include sourceMessageOrdinal. Turn actions do not need sourceMessageOrdinal or sourceSpan; if supplied, the turn executor discards them and never treats them as durable provenance. INSPECT_WORKING_SET fields must use only the canonical uppercase field IDs from its schema. Include only fields declared by the selected operation kind and never add explanatory fields. leftover is optional; omit it when there are no deferred operations.
The turn executor owns shopping goal, WorkingSet, referent binding, facts, evidence, prices, ranking, provider authorization, and state publication.
The turn executor executes accepted operations in plan order and returns safe receipts.
Then call publish_reply. TRANSITION accepts only a executor-owned transitionCode; it never accepts model-authored text. Select at most 12 relevant claim IDs from the receipts, prioritizing the user's requested fields and currently displayed candidates; mandatory disclosures are appended by the turn executor. Never attempt to enumerate every available claim.
Treat the turn executor's candidate order as an evidence-first offer order, not a product-quality score. Never call the first candidate best, top, highest-quality, best-value, or most suitable unless an allowed grounded claim explicitly proves that statement.
The turn executor derives operation provenance from the committed and executed plan; publish_reply therefore does not accept addressed operation IDs.
nextMoves is intentionally disabled in the model protocol and must always be an empty array; typed suggestions are a separate executor-owned product surface.
If receipts return no claimIds, use TRANSITION with CHECKED_PREMISE for INSPECT_SEARCH_COVERAGE, otherwise STATE_UPDATED; when clarification was planned, include one QUESTION using exactly one clarification returned in questionClarifications.
Never invent delivery eligibility, shipping, tax, warranty, rating, authenticity, stock, model, condition, price, merchant, market, or FX facts.
Do not request offer search for ordinary conversation, clarification, rejection, filtering, reranking, comparison, undo, or evidence-backed explanation.`;

export const CONVERSATION_PROMPT_SHA256 = `sha256:${createHash("sha256").update(CONVERSATION_SYSTEM_PROMPT).digest("hex")}`;

export interface ConversationTurnAgentOptions {
  model: Model<any>;
  streamFn: StreamFn;
  controller: TurnExecutionController;
  context: ConversationContextInput;
  sessionId: string;
  apiKey?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onModelCall?: (call: AgentModelCallObservation) => void;
  observeToolCall?: ObserveAgentToolCall;
}

export interface AgentModelCallObservation extends AgentInferenceContext {
  model: Model<any>;
  context: Context;
  options?: SimpleStreamOptions;
}

export interface AgentModelUsage {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface ConversationTurnAgentResult {
  envelope: AssistantEnvelope;
  plan: NonNullable<ConversationToolProtocol["plan"]> | null;
  route: ConversationRoute | null;
  receipts: OperationReceipt[];
  modelInferences: number;
  toolCalls: number;
  usedFallback: boolean;
  fallbackReasonCode: string | null;
  context: ConversationContextProjection;
  modelUsage: AgentModelUsage;
}

function requiredToolStream(
  streamFn: StreamFn,
  currentInference: () => AgentInferenceContext,
  onModelCall?: (call: AgentModelCallObservation) => void,
): StreamFn {
  return async (model, context: Context, options) => {
    const api = String(model.api);
    const toolChoice = api === "anthropic-messages" || api === "bedrock-converse-stream" || api === "google-generative-ai" || api === "google-vertex" ? "any" : "required";
    const effectiveOptions = { ...options, temperature: 0, toolChoice } as unknown as SimpleStreamOptions;
    onModelCall?.({ model, context, options: effectiveOptions, ...currentInference() });
    return streamFn(model, context, effectiveOptions as never);
  };
}

function inferencePhase(protocol: ConversationToolProtocol, inferenceIndex: number): AgentInferencePhase {
  if (protocol.phase === "ANSWER_REQUIRED") return protocol.lastErrorCode ? "REPAIR_FINALIZE" : "FINALIZE";
  if (protocol.phase === "CONTEXT_READY") return inferenceIndex === 1 && !protocol.lastErrorCode ? "PLAN" : "REPAIR_PLAN";
  return protocol.lastErrorCode ? "REPAIR_FINALIZE" : "FINALIZE";
}

function enrichLowInformationProtocolError(primary: string, phase: string, assistantDiagnostic: string | null): string {
  if (!/^\s*\{\s*"kind"\s*:/u.test(primary) || !assistantDiagnostic) return primary;
  return JSON.stringify({
    code: "MODEL_PROTOCOL_INVALID_TOOL_ARGUMENTS",
    phase,
    validationDetail: primary,
    assistant: assistantDiagnostic,
  }).slice(0, 3000);
}

export async function executeConversationTurn(options: ConversationTurnAgentOptions): Promise<ConversationTurnAgentResult> {
  const context = projectConversationContext(options.context);
  let modelInferences = 0;
  let currentInference: AgentInferenceContext = { inferenceIndex: 0, phase: "PLAN" };
  const protocol = new ConversationToolProtocol(options.controller, {
    ...(options.observeToolCall ? { observeToolCall: options.observeToolCall } : {}),
    currentInference: () => currentInference,
  });
  let blockedCode: string | null = null;
  let lastAssistantDiagnostic: string | null = null;
  const modelUsage: AgentModelUsage = {
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: CONVERSATION_SYSTEM_PROMPT,
      model: options.model,
      thinkingLevel: "off",
      tools: protocol.toolsForPhase(),
      messages: [],
    },
    streamFn: requiredToolStream(options.streamFn, () => currentInference, options.onModelCall),
    ...(options.apiKey ? { getApiKey: () => options.apiKey } : {}),
    sessionId: options.sessionId,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      protocol.toolCalls += 1;
      if (options.signal?.aborted) return { block: true, reason: "TURN_ABORTED", terminate: true };
      if (protocol.toolCalls > 5) return { block: true, reason: "TOOL_CALL_BUDGET_EXCEEDED", terminate: true };
      if (!protocol.isAllowed(toolCall.name)) return { block: true, reason: "TOOL_NOT_ALLOWED_IN_PHASE", terminate: true };
      return undefined;
    },
    prepareNextTurnWithContext: ({ context: current }) => ({ context: { ...current, tools: protocol.toolsForPhase() } }),
    shouldStopAfterTurn: () => protocol.phase === "COMPLETED" || protocol.phase === "FALLBACK" || modelInferences >= protocol.maxModelInferences,
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  agent.subscribe((event) => {
    if (event.type === "turn_start") {
      modelInferences += 1;
      currentInference = { inferenceIndex: modelInferences, phase: inferencePhase(protocol, modelInferences) };
    }
    if (event.type === "turn_end" && event.message.role === "assistant") {
      const message = event.message;
      lastAssistantDiagnostic = JSON.stringify({
        stopReason: message.stopReason,
        rawStopReason: message.rawStopReason ?? null,
        errorMessage: message.errorMessage?.slice(0, 300) ?? null,
        content: message.content.slice(0, 4).map((item) => item.type === "text"
          ? { type: item.type, text: item.text.slice(0, 500) }
          : item.type === "toolCall"
            ? { type: item.type, name: item.name, arguments: item.arguments }
            : { type: item.type }),
      }).slice(0, 1200);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      modelUsage.responses += 1;
      modelUsage.inputTokens += usage.input;
      modelUsage.outputTokens += usage.output;
      modelUsage.cacheReadTokens += usage.cacheRead;
      modelUsage.cacheWriteTokens += usage.cacheWrite;
      modelUsage.totalTokens += usage.totalTokens;
    }
    if (event.type === "tool_execution_end" && event.isError) {
      const detail = event.result?.content?.find((item: { type?: string }) => item.type === "text")?.text;
      blockedCode = typeof detail === "string" && detail.trim()
        ? detail.trim().slice(0, 1200)
        : "TOOL_EXECUTION_FAILED";
    }
    options.onEvent?.(event);
  });
  let usedFallback = false;
  let fallbackReasonCode: string | null = null;
  try {
    await agent.prompt(JSON.stringify(context));
    if (!protocol.plan && !protocol.envelope && protocol.phase !== "FALLBACK" && modelInferences < protocol.maxModelInferences && !options.signal?.aborted) {
      protocol.allowProtocolRepair();
      await agent.prompt(JSON.stringify({
        protocolRepair: true,
        instruction: "Your previous response did not complete the required tool protocol. Use the only currently available tool and continue from the current protocol phase; do not answer with free text.",
      }));
    }
  } catch (error) {
    blockedCode = error instanceof Error ? error.message.slice(0, 160) : "PI_AGENT_FAILED";
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  if (!protocol.envelope) {
    usedFallback = true;
    const primaryReason = protocol.lastErrorCode ?? blockedCode ?? lastAssistantDiagnostic ?? "PI_AGENT_INCOMPLETE";
    fallbackReasonCode = enrichLowInformationProtocolError(primaryReason, protocol.phase, lastAssistantDiagnostic);
    await protocol.fallback(fallbackReasonCode);
  }
  return {
    envelope: protocol.envelope!,
    plan: protocol.plan,
    route: protocol.route,
    receipts: [...protocol.receipts],
    modelInferences,
    toolCalls: protocol.toolCalls,
    usedFallback,
    fallbackReasonCode,
    context,
    modelUsage,
  };
}
