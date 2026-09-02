import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentModelCallObservation } from "@retail-price/agent";

import { telemetryContent } from "./telemetry-safety.js";

export function safeTelemetryIdentifier(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 160);
  return normalized || fallback;
}

export function modelParameters(
  options: AgentModelCallObservation["options"],
): Record<string, string | number> {
  const source = (options ?? {}) as Record<string, unknown>;
  const allowed = ["toolChoice", "temperature", "maxTokens", "topP", "reasoningEffort"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") return [[key, value]];
    if (typeof value === "boolean") return [[key, String(value)]];
    return [];
  }));
}

function contentPlaceholder(value: unknown): unknown {
  const captured = telemetryContent(value);
  return captured && typeof captured === "object"
    && !Array.isArray(captured)
    && (captured as Record<string, unknown>)["contentCaptured"] === false
    ? "[CONTENT_NOT_CAPTURED]"
    : captured;
}

function stringContent(value: unknown): string {
  const captured = contentPlaceholder(value);
  return typeof captured === "string" ? captured : JSON.stringify(captured);
}

function telemetryAssistantMessage(message: AssistantMessage): Record<string, unknown> {
  const content = message.content as unknown as Array<Record<string, unknown>>;
  const textBlocks = content.flatMap((item) => item["type"] === "text"
    ? [stringContent(item["text"] ?? "")]
    : []);
  const toolCalls = content.flatMap((item) => item["type"] === "toolCall"
    ? [{
        id: safeTelemetryIdentifier(String(item["id"] ?? ""), "missing-tool-call-id"),
        type: "function",
        function: {
          name: safeTelemetryIdentifier(String(item["name"] ?? ""), "unknown-tool"),
          arguments: stringContent(item["arguments"] ?? {}),
        },
      }]
    : []);
  return {
    role: "assistant",
    content: textBlocks.length > 0 ? textBlocks.join("\n") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function telemetryChatMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: contentPlaceholder(message.content) };
  if (message.role === "toolResult") {
    return {
      role: "tool",
      tool_call_id: safeTelemetryIdentifier(message.toolCallId, "missing-tool-call-id"),
      name: safeTelemetryIdentifier(message.toolName, "unknown-tool"),
      isError: message.isError,
      content: stringContent(message.content),
    };
  }
  return telemetryAssistantMessage(message);
}

export function telemetryModelInput(
  call: AgentModelCallObservation,
): Array<Record<string, unknown>> {
  return [
    { role: "system", content: contentPlaceholder(call.context.systemPrompt ?? "") },
    ...call.context.messages.map((message) => telemetryChatMessage(message)),
  ];
}

export function precedingToolCallIds(call: AgentModelCallObservation): string[] {
  return call.context.messages.flatMap((message) => message.role === "toolResult"
    ? [safeTelemetryIdentifier(message.toolCallId, "missing-tool-call-id")]
    : []).slice(-8);
}
