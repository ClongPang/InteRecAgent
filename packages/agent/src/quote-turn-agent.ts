import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { QuoteAssistantPublication, QuoteConversationState, QuotePlanReview } from "@interec/domain";

import type {
  AgentInferenceContext,
  AgentModelCallObservation,
  AgentModelUsage,
  ObserveAgentToolCall,
} from "./agent-observation.js";
import { projectQuoteConversationContext, type QuoteConversationContextInput, type QuoteConversationContextProjection } from "./quote-context.js";
import { QUOTE_CONVERSATION_SYSTEM_PROMPT } from "./quote-planner-prompt.js";
import { QuoteToolProtocol } from "./quote-tool-protocol.js";
import { QuoteConversationTurnExecutor, type QuoteOperationReceipt, type QuoteTurnExecutionResult } from "./quote-turn-executor.js";

export interface QuoteConversationTurnAgentOptions {
  model: Model<any>;
  streamFn: StreamFn;
  executor: QuoteConversationTurnExecutor;
  context: QuoteConversationContextInput;
  sessionId: string;
  apiKey?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onModelCall?: (call: AgentModelCallObservation) => void;
  observeToolCall?: ObserveAgentToolCall;
}

export interface QuoteConversationTurnAgentResult {
  reply: QuoteAssistantPublication;
  plan: QuoteTurnExecutionResult["plan"] | null;
  review: QuotePlanReview | null;
  state: QuoteConversationState | null;
  route: QuoteTurnExecutionResult["review"]["route"] | null;
  receipts: QuoteOperationReceipt[];
  modelInferences: number;
  toolCalls: number;
  usedFallback: boolean;
  fallbackReasonCode: string | null;
  context: QuoteConversationContextProjection;
  modelUsage: AgentModelUsage;
}

function requiredToolStream(streamFn: StreamFn, onModelCall: QuoteConversationTurnAgentOptions["onModelCall"], inference: () => AgentInferenceContext): StreamFn {
  return async (model, context: Context, options) => {
    const api = String(model.api);
    const toolChoice = ["anthropic-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex"].includes(api) ? "any" : "required";
    const effectiveOptions = { ...options, temperature: 0, toolChoice } as unknown as SimpleStreamOptions;
    onModelCall?.({ model, context, options: effectiveOptions, ...inference() });
    return streamFn(model, context, effectiveOptions as never);
  };
}

export async function executeQuoteConversationTurn(options: QuoteConversationTurnAgentOptions): Promise<QuoteConversationTurnAgentResult> {
  const context = projectQuoteConversationContext(options.context);
  let modelInferences = 0;
  let currentInference: AgentInferenceContext = { inferenceIndex: 0, phase: "PLAN" };
  const protocol = new QuoteToolProtocol(options.executor, options.observeToolCall, () => currentInference);
  let blockedCode: string | null = null;
  const modelUsage: AgentModelUsage = { responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const agent = new Agent({
    initialState: {
      systemPrompt: QUOTE_CONVERSATION_SYSTEM_PROMPT,
      model: options.model,
      thinkingLevel: "off",
      tools: protocol.tools(),
      messages: [],
    },
    streamFn: requiredToolStream(options.streamFn, options.onModelCall, () => currentInference),
    ...(options.apiKey ? { getApiKey: () => options.apiKey } : {}),
    sessionId: options.sessionId,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      protocol.toolCalls += 1;
      if (options.signal?.aborted) return { block: true, reason: "TURN_ABORTED", terminate: true };
      if (protocol.toolCalls > 2) return { block: true, reason: "QUOTE_TOOL_CALL_BUDGET_EXCEEDED", terminate: true };
      if (!protocol.isAllowed(toolCall.name)) return { block: true, reason: "QUOTE_TOOL_NOT_ALLOWED", terminate: true };
      return undefined;
    },
    prepareNextTurnWithContext: ({ context: current }) => ({ context: { ...current, tools: protocol.tools() } }),
    shouldStopAfterTurn: () => protocol.phase === "COMPLETED" || protocol.phase === "FALLBACK" || modelInferences >= 2,
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  agent.subscribe((event) => {
    if (event.type === "turn_start") {
      modelInferences += 1;
      currentInference = { inferenceIndex: modelInferences, phase: modelInferences === 1 ? "PLAN" : "REPAIR_PLAN" };
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
      blockedCode = typeof detail === "string" && detail.trim() ? detail.trim().slice(0, 500) : "QUOTE_TOOL_EXECUTION_FAILED";
    }
    options.onEvent?.(event);
  });
  try {
    await agent.prompt(JSON.stringify(context));
  } catch (error) {
    blockedCode = error instanceof Error ? error.message.slice(0, 160) : "QUOTE_AGENT_FAILED";
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  let usedFallback = false;
  let fallbackReasonCode: string | null = null;
  let reply = protocol.result?.reply ?? null;
  let state = protocol.result?.state ?? null;
  if (!reply) {
    usedFallback = true;
    fallbackReasonCode = protocol.lastErrorCode ?? blockedCode ?? "QUOTE_AGENT_INCOMPLETE";
    const fallback = await protocol.fallback(fallbackReasonCode);
    reply = fallback.reply;
    state = fallback.state;
  }
  return {
    reply,
    plan: protocol.result?.plan ?? null,
    review: protocol.result?.review ?? null,
    state,
    route: protocol.result?.review.route ?? null,
    receipts: protocol.result?.receipts ?? [],
    modelInferences,
    toolCalls: protocol.toolCalls,
    usedFallback,
    fallbackReasonCode,
    context,
    modelUsage,
  };
}
