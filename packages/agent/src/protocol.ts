import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantBlock, AssistantEnvelope, ConversationRoute, OperationSource, TurnOperation, TurnPlan } from "@interec/domain";

import { assistantEnvelopeSchema, turnPlanSchema } from "./schemas.js";

export type TurnAgentPhase = "CONTEXT_READY" | "EXECUTING_PLAN" | "ANSWER_REQUIRED" | "COMPLETED" | "FALLBACK";

export interface OperationReceipt {
  opId: string;
  toolName: string;
  status: "APPLIED" | "BLOCKED" | "FAILED";
  claimIds: string[];
  questionSlotIds: string[];
  disclosureCodes: string[];
  publicResult: Record<string, unknown>;
}

export interface CommittedTurnPlan {
  plan: TurnPlan;
  route: ConversationRoute;
  maxModelInferences: 2 | 4;
}

type ModelOperation<T> = T extends { source: OperationSource }
  ? Omit<T, "source"> & { sourceMessageOrdinal: number; sourceSpan?: OperationSource["span"] }
  : T & { sourceMessageOrdinal?: number; sourceSpan?: OperationSource["span"] };

export type ProposedTurnOperation = ModelOperation<TurnOperation>;

export interface TurnPlanProposal {
  ops: ProposedTurnOperation[];
  leftover: Array<{ operation: ProposedTurnOperation; conditionCode: string }>;
  userIntentSummary: string;
}

export type TransitionCode = "STATE_UPDATED" | "EVIDENCE_SUMMARY" | "EVIDENCE_COMPARISON" | "RESEARCH_COMPLETED" | "CHECKED_PREMISE";

type AssistantBlockProposal =
  | Exclude<AssistantBlock, { type: "QUESTION" | "TRANSITION" }>
  | { type: "QUESTION"; slotId: string }
  | { type: "TRANSITION"; transitionCode: TransitionCode };

export type AssistantEnvelopeProposal = Omit<AssistantEnvelope, "addressedOpIds" | "blocks" | "nextMoves"> & {
  blocks: AssistantBlockProposal[];
  nextMoves: Array<{ id: string; label: string; operation: ProposedTurnOperation }>;
};

export interface TurnHostOperations {
  commitPlan(plan: TurnPlanProposal, signal?: AbortSignal): Promise<CommittedTurnPlan>;
  executeOperation(operation: TurnOperation, signal?: AbortSignal): Promise<OperationReceipt>;
  publishReply(envelope: AssistantEnvelopeProposal, signal?: AbortSignal): Promise<AssistantEnvelope>;
  fallbackReply(errorCode: string, plan: TurnPlan | null, receipts: OperationReceipt[]): Promise<AssistantEnvelope>;
}

export function toolNameForOperation(operation: TurnOperation): string {
  if (operation.kind.startsWith("GOAL_")) return "patch_goal";
  switch (operation.kind) {
    case "UNDO_REVISION": return "undo_goal";
    case "REJECT_OFFERS": return "reject_offers";
    case "RESTORE_OFFERS": return "restore_offers";
    case "SET_COMPARISON": return "set_comparison";
    case "SET_FOCUS": return "set_focus";
    case "INSPECT_WORKING_SET": return "inspect_working_set";
    case "REFILTER_WORKING_SET": return "refilter_working_set";
    case "RERANK_WORKING_SET": return "rerank_working_set";
    case "RESEARCH_OFFERS": return "research_offers";
    case "REQUEST_CLARIFICATION": return "request_clarification";
  }
  throw new Error(`UNSUPPORTED_TURN_OPERATION:${(operation as TurnOperation).kind}`);
}

function textResult(details: Record<string, unknown>, terminate = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(terminate ? { terminate: true } : {}) };
}

export class ConversationToolProtocol {
  public phase: TurnAgentPhase = "CONTEXT_READY";
  public toolCalls = 0;
  public maxModelInferences: 2 | 4 = 2;
  public route: ConversationRoute | null = null;
  public plan: TurnPlan | null = null;
  public receipts: OperationReceipt[] = [];
  public envelope: AssistantEnvelope | null = null;
  public lastErrorCode: string | null = null;

  public constructor(private readonly host: TurnHostOperations) {}

  public toolsForPhase(): AgentTool[] {
    if (this.phase === "CONTEXT_READY") return [this.commitPlanTool()];
    if (this.phase === "ANSWER_REQUIRED") return [this.publishReplyTool()];
    return [];
  }

  public isAllowed(toolName: string): boolean {
    return this.toolsForPhase().some((tool) => tool.name === toolName);
  }

  public async fallback(errorCode: string): Promise<AssistantEnvelope> {
    this.phase = "FALLBACK";
    this.lastErrorCode = errorCode;
    const envelope = await this.host.fallbackReply(errorCode, this.plan, this.receipts);
    this.envelope = envelope;
    this.phase = "COMPLETED";
    return envelope;
  }

  public allowProtocolRepair(): void {
    this.maxModelInferences = 4;
  }

  private commitPlanTool(): AgentTool<typeof turnPlanSchema> {
    return {
      name: "commit_turn_plan",
      label: "Commit turn plan",
      description: "Submit one ordered TurnPlan. The deterministic host validates it and executes each authorized operation in order.",
      parameters: turnPlanSchema,
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        this.phase = "EXECUTING_PLAN";
        try {
          const committed = await this.host.commitPlan(params as TurnPlanProposal, signal);
          this.lastErrorCode = null;
          this.plan = committed.plan;
          this.route = committed.route;
          this.maxModelInferences = this.maxModelInferences === 4 ? 4 : committed.maxModelInferences;
          for (const operation of committed.plan.ops) {
            if (signal?.aborted) throw new Error("TURN_ABORTED");
            const receipt = await this.host.executeOperation(operation, signal);
            if (receipt.opId !== operation.opId || receipt.toolName !== toolNameForOperation(operation)) {
              throw new Error(`OPERATION_RECEIPT_MISMATCH:${operation.opId}`);
            }
            this.receipts.push(receipt);
          }
          this.phase = "ANSWER_REQUIRED";
          return textResult({
            acceptedPlan: { userIntentSummary: committed.plan.userIntentSummary, opIds: committed.plan.ops.map((operation) => operation.opId) },
            operationReceipts: this.receipts.map(({ publicResult, ...receipt }) => ({ ...receipt, publicResult })),
            instruction: "Call publish_reply using only allowed claim/question/disclosure IDs from these receipts.",
          });
        } catch (error) {
          this.phase = "CONTEXT_READY";
          this.lastErrorCode = error instanceof Error ? error.message.slice(0, 160) : "TURN_PLAN_FAILED";
          throw error;
        }
      },
    };
  }

  private publishReplyTool(): AgentTool<typeof assistantEnvelopeSchema> {
    return {
      name: "publish_reply",
      label: "Publish verified reply",
      description: "Submit the conversational reply body. Facts must be referenced only through claim blocks returned by the host; operation provenance is attached by the host.",
      parameters: assistantEnvelopeSchema,
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        try {
          const envelope = await this.host.publishReply(params as AssistantEnvelopeProposal, signal);
          this.lastErrorCode = null;
          this.envelope = envelope;
          this.phase = "COMPLETED";
          return textResult({ outcome: envelope.outcome, addressedOpIds: envelope.addressedOpIds }, true);
        } catch (error) {
          this.lastErrorCode = error instanceof Error ? error.message.slice(0, 160) : "ASSISTANT_ENVELOPE_FAILED";
          this.phase = "ANSWER_REQUIRED";
          throw error;
        }
      },
    };
  }
}
