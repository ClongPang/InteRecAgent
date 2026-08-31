import type {
  AssistantEnvelope,
  GroundedClaimSet,
  ConversationState,
  ClarificationAnswer,
  GoalOperation,
  PlanReview,
  TurnPlan,
} from "@interec/domain";

export interface OwnerClaims {
  tenantId: string;
  ownerId: string;
}

export type UnboundGoalOperation = GoalOperation extends infer Operation
  ? Operation extends { source: unknown }
    ? Omit<Operation, "source">
    : never
  : never;

export type ConversationTurnInput =
  | { type: "MESSAGE"; content: string; focusOfferRef?: string }
  | { type: "PATCH_GOAL"; operations: UnboundGoalOperation[] }
  | { type: "UNDO"; revision: number }
  | { type: "SET_COMPARISON"; offerRefs: string[] }
  | { type: "ANSWER_CLARIFICATION"; clarificationId: string; answer: ClarificationAnswer };

export interface ConversationRecord {
  id: string;
  owner: OwnerClaims;
  status: "OPEN" | "CLOSED" | "BLOCKED";
  currentRevision: number;
  messageCursor: number;
  eventCursor: number;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: "USER" | "ASSISTANT";
  payload: Record<string, unknown>;
  consumedByTurnId: string | null;
  createdAt: string;
}

export type ConversationTurnStatus =
  | "ACCEPTED"
  | "CLAIMED"
  | "RUNNING"
  | "COMMITTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "SUPERSEDED"
  | "DEAD_LETTER";

export interface ConversationTurnRecord {
  id: string;
  conversationId: string;
  clientTurnId: string;
  baseRevision: number;
  status: ConversationTurnStatus;
  attempt: number;
  fenceToken: string;
  workerId: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AcceptedConversationTurn extends ConversationTurnRecord {
  inputMessageIds: string[];
  idempotentReplay: boolean;
}

export interface ClaimedConversationTurn extends ConversationTurnRecord {
  owner: OwnerClaims;
  inputMessages: ConversationMessageRecord[];
  snapshot: ConversationState;
  telemetryTraceId: string;
  telemetryRootObservationId?: string;
}

export interface AcceptConversationTurnInput {
  conversationId: string;
  owner: OwnerClaims;
  clientTurnId: string;
  expectedRevision?: number;
  input: ConversationTurnInput;
  deadlineSeconds?: number;
  telemetryTraceId?: string;
  telemetryRootObservationId?: string;
}

export interface RetryConversationTurnInput {
  conversationId: string;
  turnId: string;
  owner: OwnerClaims;
  clientTurnId: string;
  expectedRevision?: number;
  deadlineSeconds?: number;
  telemetryTraceId?: string;
  telemetryRootObservationId?: string;
}

export interface AttemptDraft {
  plan?: TurnPlan;
  goal?: ConversationState["goalRevision"];
  dialogue?: ConversationState["dialogue"];
  workingSet?: ConversationState["workingSet"];
  envelope?: AssistantEnvelope;
  groundedClaims?: GroundedClaimSet;
  evidenceKeys?: string[];
  fallbackReasonCode?: string;
}

export interface RecordPlanReviewInput {
  turnId: string;
  attempt: number;
  fenceToken: string;
  proposalNumber: number;
  proposal: unknown;
  reviewedPlan: TurnPlan;
  review: PlanReview;
  approvedPlan: TurnPlan | null;
}

export interface CommitConversationTurnInput {
  turnId: string;
  attempt: number;
  fenceToken: string;
  state: ConversationState;
  plan: TurnPlan;
  envelope: AssistantEnvelope;
  groundedClaims: GroundedClaimSet;
  renderedText: string;
  allowedClarificationIds: ReadonlySet<string>;
  allowedDisclosureCodes: ReadonlySet<string>;
  decision?: Record<string, unknown>;
}

export interface ConversationEventRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  seq: number;
  eventType: string;
  publicPayload: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationProjectionRecord {
  conversation: ConversationRecord;
  state: ConversationState;
  messages: ConversationMessageRecord[];
  activeTurn: ConversationTurnRecord | null;
  latestTurn: ConversationTurnRecord | null;
}

export interface FinalCommitResult {
  committed: boolean;
  conversationRevision: number;
  assistantMessageId: string;
  responseId: string;
}

export interface ToolExecutionRecord {
  id: string;
  turnId: string;
  attempt: number;
  stepKey: string;
  requestHash: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorCode: string | null;
}

export interface ToolReservation {
  action: "CALL" | "WAIT" | "REUSE";
  execution: ToolExecutionRecord;
}

export class ConversationRepositoryError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConversationRepositoryError";
  }
}

export interface ConversationRepository {
  createConversation(owner: OwnerClaims): Promise<ConversationRecord>;
  getConversation(id: string, owner: OwnerClaims): Promise<ConversationRecord | null>;
  getProjection(conversationId: string, owner: OwnerClaims): Promise<ConversationProjectionRecord | null>;
  acceptTurn(input: AcceptConversationTurnInput): Promise<AcceptedConversationTurn>;
  retryTurn(input: RetryConversationTurnInput): Promise<AcceptedConversationTurn>;
  claimTurn(workerId: string, leaseSeconds: number, turnId?: string): Promise<ClaimedConversationTurn | null>;
  recordAttemptTelemetryLink(turnId: string, attempt: number, fenceToken: string, traceId: string, rootObservationId: string): Promise<boolean>;
  markTurnRunning(turnId: string, attempt: number, fenceToken: string): Promise<boolean>;
  heartbeatTurn(turnId: string, attempt: number, fenceToken: string, leaseSeconds: number): Promise<boolean>;
  stageAttemptDraft(turnId: string, attempt: number, fenceToken: string, draft: AttemptDraft): Promise<boolean>;
  recordPlanReview(input: RecordPlanReviewInput): Promise<boolean>;
  reserveToolExecution(turnId: string, attempt: number, fenceToken: string, stepKey: string, request: Record<string, unknown>): Promise<ToolReservation | null>;
  completeToolExecution(turnId: string, attempt: number, fenceToken: string, stepKey: string, requestHash: string, result: Record<string, unknown>): Promise<boolean>;
  failToolExecution(turnId: string, attempt: number, fenceToken: string, stepKey: string, requestHash: string, errorCode: string): Promise<boolean>;
  commitTurn(input: CommitConversationTurnInput): Promise<FinalCommitResult | null>;
  failTurn(turnId: string, attempt: number, fenceToken: string, errorCode: string): Promise<boolean>;
  cancelTurn(turnId: string, owner: OwnerClaims): Promise<boolean>;
  expireDueTurns(): Promise<number>;
  getSnapshot(conversationId: string, owner: OwnerClaims): Promise<ConversationState | null>;
  getRevision(conversationId: string, owner: OwnerClaims, revision: number): Promise<ConversationState | null>;
  getTurn(turnId: string, owner: OwnerClaims): Promise<ConversationTurnRecord | null>;
  getLatestTurn(conversationId: string, owner: OwnerClaims): Promise<ConversationTurnRecord | null>;
  listMessages(conversationId: string, owner: OwnerClaims, afterSeq: number): Promise<ConversationMessageRecord[]>;
  listEvents(conversationId: string, owner: OwnerClaims, afterSeq: number): Promise<ConversationEventRecord[]>;
  close(): Promise<void>;
}
