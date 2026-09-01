import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type AgentInferencePhase = "PLAN" | "REPAIR_PLAN";

export interface AgentInferenceContext {
  inferenceIndex: number;
  phase: AgentInferencePhase;
}

export interface AgentToolCallObservation extends AgentInferenceContext {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export type ObserveAgentToolCall = <T>(
  call: AgentToolCallObservation,
  operation: () => Promise<T>,
) => Promise<T>;

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
