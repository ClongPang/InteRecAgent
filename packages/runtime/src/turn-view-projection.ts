import { telemetryContent } from "./telemetry-safety.js";
import type { TurnDecisionProvenance } from "./turn-decision-provenance.js";

export const CONTENT_NOT_CAPTURED = "[CONTENT_NOT_CAPTURED]";

export interface TurnViewMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TurnViewProjection {
  input: TurnViewMessage[];
  output: TurnViewMessage[];
  scanLine: string;
}

function capturedText(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  const captured = telemetryContent(value, environment);
  if (typeof captured === "string") return captured;
  if (
    captured
    && typeof captured === "object"
    && !Array.isArray(captured)
    && (captured as Record<string, unknown>)["contentCaptured"] === false
  ) {
    return CONTENT_NOT_CAPTURED;
  }
  return JSON.stringify(captured);
}

export function decisionScanLine(decision: TurnDecisionProvenance | undefined, status: string): string {
  if (!decision) return status;
  const identity = decision.after.canonicalModel
    ?? decision.after.modelKey
    ?? decision.after.pendingModelKey
    ?? "NONE";
  return [decision.outcome, decision.route ?? "none", decision.targetLifecycle, identity].join(" | ");
}

/**
 * Always-on Langfuse root I/O. Content-gated text is replaced, never the whole object.
 * Langfuse list/session/eval read this shape; decision identity stays in metadata.
 */
export function projectTurnView(input: {
  userMessages: readonly string[];
  replyText?: string;
  status: string;
  decision?: TurnDecisionProvenance;
  environment?: NodeJS.ProcessEnv;
}): TurnViewProjection {
  const environment = input.environment ?? process.env;
  const scanLine = decisionScanLine(input.decision, input.status);
  const userSource = input.userMessages.join("\n");
  const userContent = userSource
    ? capturedText(userSource, environment)
    : CONTENT_NOT_CAPTURED;
  const assistantContent = input.replyText
    ? capturedText(input.replyText, environment)
    : scanLine;
  return {
    input: [{ role: "user", content: userContent === CONTENT_NOT_CAPTURED && input.userMessages.length > 1
      ? `${CONTENT_NOT_CAPTURED} x${input.userMessages.length}`
      : userContent }],
    output: [{ role: "assistant", content: assistantContent === CONTENT_NOT_CAPTURED ? scanLine : assistantContent }],
    scanLine,
  };
}
