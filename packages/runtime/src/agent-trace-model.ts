import { createHash, createHmac } from "node:crypto";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  AgentModelCallObservation,
  AgentToolCallObservation,
} from "@retail-price/agent";

type JsonScalar = boolean | number | string | null;
type CanonicalValue = JsonScalar | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return String(value);
}

export function canonicalTraceJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function traceValueSha256(value: unknown, key?: string): string {
  const canonical = canonicalTraceJson(value);
  return key
    ? `hmac-sha256:${createHmac("sha256", key).update(canonical).digest("hex")}`
    : `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Provider-semantic message projection. Local timestamps, usage accounting and
 * tool details that pi-ai does not send back to the model are intentionally absent.
 */
export function semanticModelMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      ...(message.addedToolNames?.length ? { addedToolNames: [...message.addedToolNames].sort() } : {}),
    };
  }
  return {
    role: "assistant",
    content: message.content,
  };
}

function semanticTool(
  tool: NonNullable<AgentModelCallObservation["context"]["tools"]>[number],
): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

export interface AgentModelBoundaryManifest {
  contextSha256: string;
  toolSchemaSha256: string;
  systemInstructionSha256: string;
  messageCount: number;
  toolDefinitionCount: number;
  toolResultCount: number;
  toolResultRefs: Array<{
    toolCallId: string;
    resultSha256: string;
  }>;
}

export function buildAgentModelBoundaryManifest(
  call: AgentModelCallObservation,
  digestKey?: string,
): AgentModelBoundaryManifest {
  const messages = call.context.messages.map((message) => semanticModelMessage(message));
  const tools = (call.context.tools ?? []).map((tool) => semanticTool(tool));
  const systemInstruction = call.context.systemPrompt ?? "";
  const toolResultRefs = call.context.messages.flatMap((message) => message.role === "toolResult"
    ? [{ toolCallId: message.toolCallId, resultSha256: traceValueSha256(message.content, digestKey) }]
    : []);
  return {
    contextSha256: traceValueSha256({ systemInstruction, messages, tools }, digestKey),
    toolSchemaSha256: traceValueSha256(tools, digestKey),
    systemInstructionSha256: traceValueSha256(systemInstruction, digestKey),
    messageCount: messages.length,
    toolDefinitionCount: tools.length,
    toolResultCount: toolResultRefs.length,
    toolResultRefs,
  };
}

interface ToolCausalityRecord {
  toolCallId: string;
  requested?: { toolName: string; inferenceIndex: number };
  starts: string[];
  observations: string[];
  ends: string[];
  observedResultSha256?: string;
  endedResultSha256?: string;
  terminal: boolean;
  consumed: Array<{ inferenceIndex: number; resultSha256: string }>;
}

export interface AgentCausalityReport {
  passed: boolean;
  requestedToolCalls: number;
  startedToolCalls: number;
  observedToolCalls: number;
  endedToolCalls: number;
  consumedToolResults: number;
  duplicateToolCallIds: string[];
  orphanToolCallIds: string[];
  lifecycleMismatchToolCallIds: string[];
  resultMismatchToolCallIds: string[];
  unconsumedToolResultIds: string[];
}

function toolCallsFromAssistant(message: AssistantMessage): Array<{ id: string; name: string }> {
  return (message.content as unknown as Array<Record<string, unknown>>).flatMap((item) => (
    item["type"] === "toolCall"
      ? [{ id: String(item["id"] ?? ""), name: String(item["name"] ?? "") }]
      : []
  ));
}

/**
 * Attempt-local causal ledger. It validates the observable agent protocol, not
 * hidden reasoning: request identity, execution lifecycle, model-visible result,
 * and consumption by a later inference.
 */
export class AgentCausalityLedger {
  private readonly records = new Map<string, ToolCausalityRecord>();
  private readonly duplicateIds = new Set<string>();

  public constructor(private readonly digestKey?: string) {}

  private digest(value: unknown): string {
    return traceValueSha256(value, this.digestKey);
  }

  private record(toolCallId: string): ToolCausalityRecord {
    const existing = this.records.get(toolCallId);
    if (existing) return existing;
    const created: ToolCausalityRecord = {
      toolCallId,
      starts: [],
      observations: [],
      ends: [],
      terminal: false,
      consumed: [],
    };
    this.records.set(toolCallId, created);
    return created;
  }

  public recordModelInput(call: AgentModelCallObservation): void {
    for (const message of call.context.messages) {
      if (message.role !== "toolResult") continue;
      const record = this.record(message.toolCallId);
      record.consumed.push({
        inferenceIndex: call.inferenceIndex,
        resultSha256: this.digest(message.content),
      });
    }
  }

  public recordModelOutput(message: AssistantMessage, inferenceIndex: number): void {
    for (const toolCall of toolCallsFromAssistant(message)) {
      const record = this.record(toolCall.id);
      if (record.requested) this.duplicateIds.add(toolCall.id);
      record.requested = { toolName: toolCall.name, inferenceIndex };
    }
  }

  public recordToolStart(toolCallId: string, toolName: string): void {
    const record = this.record(toolCallId);
    if (record.starts.length > 0) this.duplicateIds.add(toolCallId);
    record.starts.push(toolName);
  }

  public recordToolObservation(call: AgentToolCallObservation, result?: unknown): void {
    const record = this.record(call.toolCallId);
    if (record.observations.length > 0) this.duplicateIds.add(call.toolCallId);
    record.observations.push(call.toolName);
    if (result !== undefined) {
      const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
      record.observedResultSha256 = this.digest(resultRecord["content"] ?? []);
      record.terminal = resultRecord["terminate"] === true;
    }
  }

  public recordToolEnd(input: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }): void {
    const record = this.record(input.toolCallId);
    if (record.ends.length > 0) this.duplicateIds.add(input.toolCallId);
    record.ends.push(input.toolName);
    const resultRecord = input.result && typeof input.result === "object"
      ? input.result as Record<string, unknown>
      : {};
    record.endedResultSha256 = this.digest(resultRecord["content"] ?? []);
    record.terminal ||= input.isError || resultRecord["terminate"] === true;
  }

  public report(): AgentCausalityReport {
    const records = [...this.records.values()];
    const orphan = records.filter((record) => !record.requested);
    const lifecycleMismatch = records.filter((record) => {
      if (!record.requested) return true;
      const expected = record.requested.toolName;
      return record.starts.length !== 1
        || record.observations.length !== 1
        || record.ends.length !== 1
        || record.starts[0] !== expected
        || record.observations[0] !== expected
        || record.ends[0] !== expected;
    });
    const resultMismatch = records.filter((record) => {
      if (!record.observedResultSha256 || !record.endedResultSha256) return false;
      if (record.observedResultSha256 !== record.endedResultSha256) return true;
      return record.consumed.some((consumption) => (
        record.requested !== undefined
        && consumption.inferenceIndex > record.requested.inferenceIndex
        && consumption.resultSha256 !== record.observedResultSha256
      ));
    });
    const unconsumed = records.filter((record) => (
      record.requested
      && record.observedResultSha256
      && !record.terminal
      && !record.consumed.some((consumption) => (
        consumption.inferenceIndex > record.requested!.inferenceIndex
        && consumption.resultSha256 === record.observedResultSha256
      ))
    ));
    const duplicateToolCallIds = [...this.duplicateIds].sort();
    const orphanToolCallIds = orphan.map((record) => record.toolCallId).sort();
    const lifecycleMismatchToolCallIds = lifecycleMismatch.map((record) => record.toolCallId).sort();
    const resultMismatchToolCallIds = resultMismatch.map((record) => record.toolCallId).sort();
    const unconsumedToolResultIds = unconsumed.map((record) => record.toolCallId).sort();
    return {
      passed: duplicateToolCallIds.length === 0
        && orphanToolCallIds.length === 0
        && lifecycleMismatchToolCallIds.length === 0
        && resultMismatchToolCallIds.length === 0
        && unconsumedToolResultIds.length === 0,
      requestedToolCalls: records.filter((record) => record.requested).length,
      startedToolCalls: records.filter((record) => record.starts.length > 0).length,
      observedToolCalls: records.filter((record) => record.observations.length > 0).length,
      endedToolCalls: records.filter((record) => record.ends.length > 0).length,
      consumedToolResults: records.filter((record) => record.consumed.length > 0).length,
      duplicateToolCallIds,
      orphanToolCallIds,
      lifecycleMismatchToolCallIds,
      resultMismatchToolCallIds,
      unconsumedToolResultIds,
    };
  }
}
