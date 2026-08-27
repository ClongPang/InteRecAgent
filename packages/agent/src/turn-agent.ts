import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { AssistantEnvelope, ConversationRoute } from "@interec/domain";

import { projectConversationContext, type ConversationContextInput, type ConversationContextProjection } from "./context.js";
import { ConversationToolProtocol, type OperationReceipt, type TurnHostOperations } from "./protocol.js";

const SYSTEM_PROMPT = `You are the turn planner for a long-lived conversational shopping recommendation agent.
You must use tools; never answer with free text.
First call commit_turn_plan exactly once with one ordered plan covering every user request in the current message batch.
For a registered category use its canonical ID (currently headphones or smartphone). For any other category, preserve a short normalized category hint in categoryId and put the exact user product phrase in targetText. Product attributes such as wireless or noise-cancelling belong in constraints or preferences, never inside categoryId.
Every initial message that names something to buy must include GOAL_SET_TARGET. Never replace the product target with only attribute constraints or preferences. Example: “想买前置式洗衣机，在美国市场找，偏好 10 公斤，不设预算” requires GOAL_SET_TARGET(categoryId washing_machine, targetText 前置式洗衣机, canonicalModel null, PRIMARY_PRODUCT, ANY), US market, the stated attribute operations, and research.
Preserve every explicit user requirement in the Goal. Use GOAL_UPSERT_CONSTRAINT for must-have product attributes and GOAL_UPSERT_PREFERENCE for softer use cases or ranking wishes; for example, map 降噪/noise-cancelling to constraint key noise_cancelling with operator EQ and value true, and 通勤/commute to preference key use_case with value commute.
Never invent a budget, market, model, product condition, or other Goal value. When the user does not state a condition, use ANY; use NEW only for explicit new/brand-new/新机/全新 language. The Host checks Goal values against the cited current user text and discards unsupported values.
If the request is underspecified and your reply needs to ask a question, the plan must include REQUEST_CLARIFICATION with exactly one stable semantic slotId and a reasonCode. Never invent a QUESTION slot only in publish_reply; QUESTION blocks may use only questionSlotIds returned by operation receipts and contain only type plus slotId. The host owns the final single-slot wording.
For an initial product request without enough constraints to research safely (no target or no retrieval market), prefer GOAL_SET_TARGET followed by one high-value REQUEST_CLARIFICATION and do not call RESEARCH_OFFERS. Budget is useful for filtering but optional; never block research only because budget is absent.
When the user explicitly says no budget/unlimited budget/不设预算/预算不限, leave budget null and never request budget clarification.
When a Goal value is absent, omit that operation completely; never emit empty strings as placeholders (especially an empty GOAL_SET_BUDGET).
Category and at least one retrieval market are sufficient to research a category-level request; do not require a budget, canonical model, form factor, or extra preference unless the user asked for one. When dialogue.pendingClarification.slotId is turn_rephrase and the current message is actionable, include GOAL_RESOLVE_GAP for turn_rephrase and continue the request instead of asking the generic fallback question again.
For an explicit user request to search again or refresh current offers, use RESEARCH_OFFERS with the exact reasonCode USER_REQUESTED_REFRESH. Choose every other research reason from the tool schema enum; never invent a synonym.
When uiContext.focusOfferRef is present, the plan must include SET_FOCUS for that exact OFFER_REF before answering the message.
When the user refers to the first, second, or Nth displayed candidate, preserve that ordinal exactly with a DISPLAY_RANK referent; never translate ordinal language into an OFFER_REF yourself. For a why-more-expensive, why-cheaper, or difference question about rank N, inspect rank N and the comparison anchor explicitly named by the user (or rank 1 when the ordering itself is the implied anchor).
For Goal operations, sourceMessageOrdinal must reference the ordinal shown in currentUserMessages; never invent an internal message ID.
The commit_turn_plan schema is strict: GOAL_* operations must include sourceMessageOrdinal. World operations do not need sourceMessageOrdinal or sourceSpan; if supplied, the Host discards them and never treats them as durable provenance. INSPECT_WORKING_SET fields must use only the canonical uppercase field IDs from its schema. Include only fields declared by the selected operation kind and never add explanatory fields.
The deterministic host owns Goal, WorkingSet, referent binding, facts, evidence, prices, ranking, provider authorization, and state publication.
The host executes accepted operations in plan order and returns safe receipts.
Then call publish_reply. TRANSITION accepts only a host-owned transitionCode; it never accepts model-authored text. Put every product fact in a CLAIM/COMPARISON block using only IDs returned by the host.
Treat the host's candidate order as an evidence-first offer order, not a product-quality score. Never call the first candidate best, top, highest-quality, best-value, or most suitable unless an allowed verified claim explicitly proves that statement.
The host derives operation provenance from the committed and executed plan; publish_reply therefore does not accept addressed operation IDs.
If receipts return no claimIds, use TRANSITION with STATE_UPDATED and, when clarification was planned, one QUESTION using the returned questionSlotId.
Never invent delivery eligibility, shipping, tax, warranty, rating, authenticity, stock, model, condition, price, merchant, market, or FX facts.
Do not request research for ordinary conversation, clarification, rejection, filtering, reranking, comparison, undo, or evidence-backed explanation.`;

export interface ConversationTurnAgentOptions {
  model: Model<any>;
  streamFn: StreamFn;
  host: TurnHostOperations;
  context: ConversationContextInput;
  sessionId: string;
  apiKey?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
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
}

function requiredToolStream(streamFn: StreamFn): StreamFn {
  return async (model, context: Context, options) => {
    const api = String(model.api);
    const toolChoice = api === "anthropic-messages" || api === "bedrock-converse-stream" || api === "google-generative-ai" || api === "google-vertex" ? "any" : "required";
    return streamFn(model, context, { ...options, toolChoice } as never);
  };
}

export async function executeConversationTurn(options: ConversationTurnAgentOptions): Promise<ConversationTurnAgentResult> {
  const context = projectConversationContext(options.context);
  const protocol = new ConversationToolProtocol(options.host);
  let modelInferences = 0;
  let blockedCode: string | null = null;
  let lastAssistantDiagnostic: string | null = null;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: options.model,
      thinkingLevel: "off",
      tools: protocol.toolsForPhase(),
      messages: [],
    },
    streamFn: requiredToolStream(options.streamFn),
    ...(options.apiKey ? { getApiKey: () => options.apiKey } : {}),
    sessionId: options.sessionId,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      protocol.toolCalls += 1;
      if (options.signal?.aborted) return { block: true, reason: "TURN_ABORTED", terminate: true };
      if (protocol.toolCalls > 3) return { block: true, reason: "TOOL_CALL_BUDGET_EXCEEDED", terminate: true };
      if (!protocol.isAllowed(toolCall.name)) return { block: true, reason: "TOOL_NOT_ALLOWED_IN_PHASE", terminate: true };
      return undefined;
    },
    prepareNextTurnWithContext: ({ context: current }) => ({ context: { ...current, tools: protocol.toolsForPhase() } }),
    shouldStopAfterTurn: () => protocol.phase === "COMPLETED" || modelInferences >= protocol.maxModelInferences,
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  agent.subscribe((event) => {
    if (event.type === "turn_start") modelInferences += 1;
    if (event.type === "turn_end" && event.message.role === "assistant") {
      const message = event.message;
      lastAssistantDiagnostic = JSON.stringify({
        stopReason: message.stopReason,
        rawStopReason: message.rawStopReason ?? null,
        errorMessage: message.errorMessage?.slice(0, 300) ?? null,
        content: message.content.slice(0, 4).map((item) => item.type === "text"
          ? { type: item.type, text: item.text.slice(0, 500) }
          : item.type === "toolCall"
            ? { type: item.type, name: item.name }
            : { type: item.type }),
      }).slice(0, 1200);
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
    if (!protocol.plan && !protocol.envelope && !options.signal?.aborted) {
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
    fallbackReasonCode = protocol.lastErrorCode ?? blockedCode ?? lastAssistantDiagnostic ?? "PI_AGENT_INCOMPLETE";
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
  };
}
