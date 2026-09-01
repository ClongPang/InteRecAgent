import type { ConversationTurnStatus } from "./conversation-repository-types.js";
import { runtimeMetrics } from "./telemetry.js";

export function recordTerminalTurn(status: ConversationTurnStatus, route = "unknown"): void {
  try {
    runtimeMetrics.terminalTurns.add(1, { status, route, committed: status === "COMPLETED" });
  } catch {
    // Observability cannot change an authoritative transition.
  }
}
