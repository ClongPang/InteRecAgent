import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ApprovedPlanReview,
  AssistantBlock,
  AssistantEnvelope,
  ClarificationIntent,
  ConversationRoute,
  OperationSource,
  TurnOperation,
  TurnPlan,
  UnapprovedPlanReview,
} from "@interec/domain";

import { assistantEnvelopeSchema, turnPlanSchema } from "./schemas.js";

export type TurnAgentPhase = "CONTEXT_READY" | "EXECUTING_PLAN" | "ANSWER_REQUIRED" | "COMPLETED" | "FALLBACK";

export type AgentInferencePhase = "PLAN" | "FINALIZE" | "REPAIR_PLAN" | "REPAIR_FINALIZE";

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

export interface OperationReceipt {
  opId: string;
  toolName: string;
  status: "APPLIED" | "BLOCKED" | "FAILED";
  claimIds: string[];
  questionClarifications: ClarificationIntent[];
  disclosureCodes: string[];
  uncertaintyType?: "INTENT_AMBIGUITY" | "MISSING_USER_INFORMATION";
  publicResult: Record<string, unknown>;
}

export interface CommittedTurnPlan {
  plan: TurnPlan;
  route: ConversationRoute;
  maxModelInferences: 2 | 4;
  review: ApprovedPlanReview;
}

export class PlanReviewError extends Error {
  public readonly code: string;

  public constructor(public readonly review: UnapprovedPlanReview) {
    super(review.violations[0]?.code ?? review.decision);
    this.name = "PlanReviewError";
    this.code = review.violations[0]?.code ?? review.decision;
  }
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

export type TransitionCode = "STATE_UPDATED" | "EVIDENCE_SUMMARY" | "EVIDENCE_COMPARISON" | "SEARCH_COMPLETED" | "CHECKED_PREMISE";

type AssistantBlockProposal =
  | Exclude<AssistantBlock, { type: "QUESTION" | "TRANSITION" }>
  | { type: "QUESTION"; clarification: ClarificationIntent }
  | { type: "TRANSITION"; transitionCode: TransitionCode };

export type AssistantEnvelopeProposal = Omit<AssistantEnvelope, "addressedOpIds" | "blocks" | "nextMoves"> & {
  blocks: AssistantBlockProposal[];
  nextMoves: Array<{ id: string; label: string; operation: ProposedTurnOperation }>;
};

export interface TurnExecutionController {
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
    case "INSPECT_SEARCH_COVERAGE": return "inspect_search_coverage";
    case "REFILTER_WORKING_SET": return "refilter_working_set";
    case "SORT_WORKING_SET_BY_PRICE": return "rerank_working_set";
    case "SEARCH_OFFERS": return "search_offers";
    case "REQUEST_CLARIFICATION": return "request_clarification";
    case "RESOLVE_CLARIFICATION": return "resolve_clarification";
  }
  throw new Error(`UNSUPPORTED_TURN_OPERATION:${(operation as TurnOperation).kind}`);
}

function textResult(details: Record<string, unknown>, terminate = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(terminate ? { terminate: true } : {}) };
}

export interface ConversationToolProtocolOptions {
  observeToolCall?: ObserveAgentToolCall;
  currentInference?: () => AgentInferenceContext;
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

  public constructor(
    private readonly controller: TurnExecutionController,
    private readonly options: ConversationToolProtocolOptions = {},
  ) {}

  private observe<T>(toolCallId: string, toolName: string, args: unknown, operation: () => Promise<T>): Promise<T> {
    const observer = this.options.observeToolCall;
    if (!observer) return operation();
    const inference = this.options.currentInference?.() ?? { inferenceIndex: 0, phase: "PLAN" as const };
    return observer({ toolCallId, toolName, arguments: args, ...inference }, operation);
  }

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
    const envelope = await this.controller.fallbackReply(errorCode, this.plan, this.receipts);
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
      description: "Submit one ordered TurnPlan. The turn executor validates it and executes each authorized operation in order.",
      parameters: turnPlanSchema,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => this.observe(toolCallId, "commit_turn_plan", params, async () => {
        this.phase = "EXECUTING_PLAN";
        try {
          const proposal = params as Omit<TurnPlanProposal, "leftover"> & { leftover?: TurnPlanProposal["leftover"] };
          const committed = await this.controller.commitPlan({ ...proposal, leftover: proposal.leftover ?? [] }, signal);
          this.lastErrorCode = null;
          this.plan = committed.plan;
          this.route = committed.route;
          this.maxModelInferences = this.maxModelInferences === 4 ? 4 : committed.maxModelInferences;
          for (const operation of committed.plan.ops) {
            if (signal?.aborted) throw new Error("TURN_ABORTED");
            const receipt = await this.controller.executeOperation(operation, signal);
            if (receipt.opId !== operation.opId || receipt.toolName !== toolNameForOperation(operation)) {
              throw new Error(`OPERATION_RECEIPT_MISMATCH:${operation.opId}`);
            }
            this.receipts.push(receipt);
          }
          this.phase = "ANSWER_REQUIRED";
          return textResult({
            planReview: committed.review,
            acceptedPlan: { userIntentSummary: committed.plan.userIntentSummary, opIds: committed.plan.ops.map((operation) => operation.opId) },
            operationReceipts: this.receipts.map(({ publicResult, ...receipt }) => ({ ...receipt, publicResult })),
            instruction: "Call publish_reply using only allowed claim/question/disclosure IDs from these receipts.",
          });
        } catch (error) {
          if (error instanceof PlanReviewError) {
            this.lastErrorCode = error.review.violations[0]?.code ?? error.review.decision;
            if (error.review.decision === "REPAIR_REQUIRED") {
              this.phase = "CONTEXT_READY";
              this.allowProtocolRepair();
              return textResult({
                planReview: error.review,
                instruction: "Repair the proposed TurnPlan using the structured violations and call commit_turn_plan again.",
              });
            }
            this.phase = "FALLBACK";
            return textResult({
              planReview: error.review,
              instruction: "The plan proposal budget is exhausted. Do not attempt another plan.",
            }, true);
          }
          if (this.plan) {
            this.phase = "FALLBACK";
          } else {
            this.phase = "CONTEXT_READY";
            this.allowProtocolRepair();
          }
          this.lastErrorCode = error instanceof Error ? error.message.slice(0, 160) : "TURN_PLAN_FAILED";
          throw error;
        }
      }),
    };
  }

  private publishReplyTool(): AgentTool<typeof assistantEnvelopeSchema> {
    return {
      name: "publish_reply",
      label: "Publish verified reply",
      description: "Submit the conversational reply body. Facts must be referenced only through claim blocks returned by the turn executor; operation provenance is attached by the turn executor.",
      parameters: assistantEnvelopeSchema,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => this.observe(toolCallId, "publish_reply", params, async () => {
        try {
          const explicitlyRenderedClaimIds = new Set(params.blocks.flatMap((block) => block.type === "CLAIM"
            ? [block.claimId]
            : block.type === "COMPARISON"
              ? block.claimIds
              : []));
          const normalizedBlocks: AssistantEnvelopeProposal["blocks"] = [];
          for (const block of params.blocks) {
            if (block.type !== "TRANSITION") {
              normalizedBlocks.push(block);
              continue;
            }
            normalizedBlocks.push({ type: block.type, transitionCode: block.transitionCode });
            for (const claimId of block.claimIds ?? []) {
              if (!explicitlyRenderedClaimIds.has(claimId)) normalizedBlocks.push({ type: "CLAIM", claimId });
            }
          }
          const proposal: AssistantEnvelopeProposal = {
            outcome: params.outcome,
            blocks: normalizedBlocks,
            nextMoves: [],
          };
          const envelope = await this.controller.publishReply(proposal, signal);
          this.lastErrorCode = null;
          this.envelope = envelope;
          this.phase = "COMPLETED";
          return textResult({ outcome: envelope.outcome, addressedOpIds: envelope.addressedOpIds }, true);
        } catch (error) {
          this.lastErrorCode = error instanceof Error ? error.message.slice(0, 160) : "ASSISTANT_ENVELOPE_FAILED";
          this.phase = "ANSWER_REQUIRED";
          this.allowProtocolRepair();
          throw error;
        }
      }),
    };
  }
}
