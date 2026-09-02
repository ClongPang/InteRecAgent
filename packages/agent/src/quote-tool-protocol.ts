import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { QuoteAssistantPublication, QuoteConversationState } from "@retail-price/domain";

import type { AgentInferenceContext, ObserveAgentToolCall } from "./agent-observation.js";
import {
  QuoteConversationTurnExecutor,
  QuotePlanReviewError,
  type QuoteTurnExecutionResult,
  type QuoteTurnPlanProposal,
} from "./quote-turn-executor.js";
import { quoteTurnPlanSchema } from "./schemas.js";

type QuoteProtocolPhase = "CONTEXT_READY" | "EXECUTING" | "COMPLETED" | "FALLBACK";

function textResult(details: Record<string, unknown>, terminate = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}

/** Host-owned state machine for the model's only permitted tool. */
export class QuoteToolProtocol {
  public phase: QuoteProtocolPhase = "CONTEXT_READY";
  public toolCalls = 0;
  public result: QuoteTurnExecutionResult | null = null;
  public lastErrorCode: string | null = null;

  public constructor(
    private readonly executor: QuoteConversationTurnExecutor,
    private readonly observeToolCall?: ObserveAgentToolCall,
    private readonly currentInference?: () => AgentInferenceContext,
  ) {}

  public tools(): AgentTool[] {
    return this.phase === "CONTEXT_READY" ? [this.commitTool()] : [];
  }

  public isAllowed(name: string): boolean {
    return this.phase === "CONTEXT_READY" && name === "commit_quote_plan";
  }

  public async fallback(errorCode: string): Promise<{ state: QuoteConversationState; reply: QuoteAssistantPublication }> {
    this.phase = "FALLBACK";
    this.lastErrorCode = errorCode;
    const result = await this.executor.fallback(errorCode);
    this.phase = "COMPLETED";
    return result;
  }

  private commitTool(): AgentTool<typeof quoteTurnPlanSchema> {
    return {
      name: "commit_quote_plan",
      label: "Commit quote plan",
      description: "Submit one strict known-model quote plan. The host reviews, executes, grounds, renders, and publishes it.",
      parameters: quoteTurnPlanSchema,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => {
        const operation = async () => {
          this.phase = "EXECUTING";
          try {
            this.result = await this.executor.execute(params as QuoteTurnPlanProposal, signal);
            this.lastErrorCode = null;
            this.phase = "COMPLETED";
            return textResult({
              planReview: this.result.review,
              route: this.result.review.route,
              operationReceipts: this.result.receipts,
              publication: {
                outcome: this.result.reply.outcome,
                addressedOpIds: this.result.reply.addressedOpIds,
              },
            }, true);
          } catch (error) {
            if (error instanceof QuotePlanReviewError) {
              this.lastErrorCode = error.message;
              const proposalBudgetExhausted = this.toolCalls >= 2;
              this.phase = proposalBudgetExhausted ? "FALLBACK" : "CONTEXT_READY";
              return textResult({
                planReview: error.review,
                instruction: proposalBudgetExhausted
                  ? "The quote plan proposal budget is exhausted. Stop."
                  : "Repair the plan from the structured violation and call commit_quote_plan once more.",
              }, proposalBudgetExhausted);
            }
            this.lastErrorCode = error instanceof Error ? error.message.slice(0, 160) : "QUOTE_EXECUTION_FAILED";
            this.phase = "FALLBACK";
            throw error;
          }
        };
        if (!this.observeToolCall) return operation();
        return this.observeToolCall({
          toolCallId,
          toolName: "commit_quote_plan",
          arguments: params,
          ...(this.currentInference?.() ?? { inferenceIndex: 0, phase: "PLAN" as const }),
        }, operation);
      },
    };
  }
}
