import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { emptyDialogueState, validateTurnPlan, type AssistantEnvelope, type TurnOperation, type TurnPlan } from "@interec/domain";

import { executeConversationTurn } from "./turn-agent.js";
import type { AssistantEnvelopeProposal, OperationReceipt, ProposedTurnOperation, TurnHostOperations, TurnPlanProposal } from "./protocol.js";

export const PROTOCOL_ADVERSARIAL_FAMILIES = [
  "OUT_OF_PHASE_TOOL",
  "DUPLICATE_SUBMISSION",
  "SOURCE_ORDINAL",
  "UNSUPPORTED_GOAL_SOURCE",
  "NO_TOOL_RESPONSE",
  "INVALID_CLAIM_REFERENCE",
] as const;

export type ProtocolAdversarialFamily = typeof PROTOCOL_ADVERSARIAL_FAMILIES[number];

export interface ProtocolAdversarialCaseResult {
  caseId: string;
  family: ProtocolAdversarialFamily;
  passed: boolean;
  usedFallback: boolean;
  executedOperationCount: number;
  publishedReplyCount: number;
  fallbackCount: number;
  failure: string | null;
}

export interface ProtocolAdversarialReport {
  schemaVersion: "interec-protocol-adversarial-v1";
  passed: boolean;
  passedCases: number;
  totalCases: number;
  familyResults: Record<ProtocolAdversarialFamily, { passed: number; total: number }>;
  cases: ProtocolAdversarialCaseResult[];
  failures: string[];
}

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

interface AdversarialCase {
  caseId: string;
  family: ProtocolAdversarialFamily;
  responses: FauxMessage[];
  rejectCommit?: boolean;
  rejectClaim?: boolean;
  expectedExecuted: number;
}

function bindProposal(proposal: TurnPlanProposal): TurnPlan {
  const bind = (operation: ProposedTurnOperation): TurnOperation => {
    if ("sourceMessageOrdinal" in operation) {
      const { sourceMessageOrdinal, sourceSpan, ...rest } = operation;
      if (sourceMessageOrdinal !== 0) throw new Error("SOURCE_MESSAGE_ORDINAL_NOT_FOUND");
      return { ...rest, source: { messageId: "adversarial-message", ...(sourceSpan ? { span: sourceSpan } : {}) } } as TurnOperation;
    }
    return operation as TurnOperation;
  };
  return validateTurnPlan({
    userIntentSummary: proposal.userIntentSummary,
    ops: proposal.ops.map(bind),
    leftover: proposal.leftover.map((pending) => ({ conditionCode: pending.conditionCode, operation: bind(pending.operation) })),
  });
}

function planCall(caseId: string, ordinal = 0): ReturnType<typeof fauxToolCall> {
  return fauxToolCall("commit_turn_plan", {
    userIntentSummary: `adversarial ${caseId}`,
    ops: [{ opId: `budget-${caseId}`, kind: "GOAL_SET_BUDGET", sourceMessageOrdinal: ordinal, budget: { amount: "2500", currency: "CNY" } }],
    leftover: [],
  });
}

function cases(): AdversarialCase[] {
  const values: AdversarialCase[] = [];
  const forbiddenTools = ["publish_reply", "discover_offers", "reject_offers", "research_offers", "patch_goal"];
  for (const [index, toolName] of forbiddenTools.entries()) {
    values.push({
      caseId: `out-of-phase-${index + 1}`,
      family: "OUT_OF_PHASE_TOOL",
      responses: [fauxAssistantMessage(fauxToolCall(toolName, {}))],
      expectedExecuted: 0,
    });
  }
  for (let index = 1; index <= 5; index += 1) {
    const caseId = `duplicate-${index}`;
    values.push({
      caseId,
      family: "DUPLICATE_SUBMISSION",
      responses: [fauxAssistantMessage(planCall(caseId)), fauxAssistantMessage(planCall(`${caseId}-again`))],
      expectedExecuted: 1,
    });
  }
  for (const [index, ordinal] of [1, 2, 7, 99, 999].entries()) {
    const caseId = `ordinal-${index + 1}`;
    values.push({
      caseId,
      family: "SOURCE_ORDINAL",
      responses: [fauxAssistantMessage(planCall(caseId, ordinal)), fauxAssistantMessage("cannot repair")],
      expectedExecuted: 0,
    });
  }
  for (let index = 1; index <= 5; index += 1) {
    const caseId = `unsupported-source-${index}`;
    values.push({
      caseId,
      family: "UNSUPPORTED_GOAL_SOURCE",
      responses: [fauxAssistantMessage(planCall(caseId)), fauxAssistantMessage("host rejected unsupported source")],
      rejectCommit: true,
      expectedExecuted: 0,
    });
  }
  for (let index = 1; index <= 5; index += 1) {
    values.push({
      caseId: `no-tool-${index}`,
      family: "NO_TOOL_RESPONSE",
      responses: [fauxAssistantMessage(`free text ${index}`), fauxAssistantMessage(`free text again ${index}`)],
      expectedExecuted: 0,
    });
  }
  for (let index = 1; index <= 5; index += 1) {
    const caseId = `invalid-claim-${index}`;
    values.push({
      caseId,
      family: "INVALID_CLAIM_REFERENCE",
      responses: [
        fauxAssistantMessage(planCall(caseId)),
        fauxAssistantMessage(fauxToolCall("publish_reply", { outcome: "CHAT", blocks: [{ type: "CLAIM", claimId: `invented-${index}` }], nextMoves: [] })),
      ],
      rejectClaim: true,
      expectedExecuted: 1,
    });
  }
  return values;
}

async function executeCase(testCase: AdversarialCase): Promise<ProtocolAdversarialCaseResult> {
  const executed: string[] = [];
  const published: AssistantEnvelopeProposal[] = [];
  const fallbacks: string[] = [];
  let plan: TurnPlan | null = null;
  const host: TurnHostOperations = {
    commitPlan: async (proposal) => {
      if (testCase.rejectCommit) throw new Error("GOAL_VALUE_NOT_SUPPORTED_BY_SOURCE");
      plan = bindProposal(proposal);
      return { plan, route: "talk", maxModelInferences: 2 };
    },
    executeOperation: async (operation): Promise<OperationReceipt> => {
      executed.push(operation.opId);
      return { opId: operation.opId, toolName: "patch_goal", status: "APPLIED", claimIds: [], questionSlotIds: [], disclosureCodes: [], publicResult: {} };
    },
    publishReply: async (proposal) => {
      if (testCase.rejectClaim) throw new Error("CLAIM_NOT_FOUND");
      published.push(proposal);
      return { ...proposal, addressedOpIds: plan?.ops.map((operation) => operation.opId) ?? [] } as AssistantEnvelope;
    },
    fallbackReply: async (_code, currentPlan) => {
      fallbacks.push(testCase.caseId);
      return {
        outcome: "DEGRADED",
        addressedOpIds: currentPlan?.ops.map((operation) => operation.opId) ?? [],
        blocks: [{ type: "TRANSITION", text: "本轮未安全完成。" }],
        nextMoves: [],
      };
    },
  };
  try {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(testCase.responses);
    const result = await executeConversationTurn({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      host,
      context: {
        state: { revision: 0, status: "OPEN", goalRevision: null, dialogue: emptyDialogueState(), workingSet: null },
        currentUserMessages: ["预算改成 2500，先不要重新搜索"],
        capabilities: ["patch_goal", "talk"],
        now: "2026-08-28T00:00:00.000Z",
        modelId: "faux-model",
        providerCallBudget: 0,
      },
      sessionId: testCase.caseId,
    });
    const passed = result.usedFallback
      && executed.length === testCase.expectedExecuted
      && published.length === 0
      && fallbacks.length === 1;
    return {
      caseId: testCase.caseId,
      family: testCase.family,
      passed,
      usedFallback: result.usedFallback,
      executedOperationCount: executed.length,
      publishedReplyCount: published.length,
      fallbackCount: fallbacks.length,
      failure: passed ? null : `unsafe_disposition:fallback=${result.usedFallback}:executed=${executed.length}:published=${published.length}:fallbacks=${fallbacks.length}`,
    };
  } catch (error) {
    return {
      caseId: testCase.caseId,
      family: testCase.family,
      passed: false,
      usedFallback: false,
      executedOperationCount: executed.length,
      publishedReplyCount: published.length,
      fallbackCount: fallbacks.length,
      failure: error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN_ERROR",
    };
  }
}

export async function runProtocolAdversarialAcceptance(): Promise<ProtocolAdversarialReport> {
  const testCases = cases();
  if (testCases.length !== 30) throw new Error(`PROTOCOL_ADVERSARIAL_SCALE_INVALID:${testCases.length}/30`);
  const results: ProtocolAdversarialCaseResult[] = [];
  for (const testCase of testCases) results.push(await executeCase(testCase));
  const familyResults = Object.fromEntries(PROTOCOL_ADVERSARIAL_FAMILIES.map((family) => {
    const familyCases = results.filter((result) => result.family === family);
    return [family, { passed: familyCases.filter((result) => result.passed).length, total: familyCases.length }];
  })) as Record<ProtocolAdversarialFamily, { passed: number; total: number }>;
  const failures = results.filter((result) => !result.passed).map((result) => `${result.caseId}:${result.failure ?? "FAILED"}`);
  return {
    schemaVersion: "interec-protocol-adversarial-v1",
    passed: results.length === 30 && failures.length === 0,
    passedCases: results.filter((result) => result.passed).length,
    totalCases: results.length,
    familyResults,
    cases: results,
    failures,
  };
}
