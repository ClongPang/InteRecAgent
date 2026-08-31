import {
  DomainError,
  applyDialogueOperations,
  createGoalRevision,
  CONVERSATION_PLAN_POLICY_VERSION,
  reviewConversationPlan,
  reviewStructuredConversationPlan,
  markWorkingSetMentioned,
  refilterWorkingSetByMarkets,
  reprojectWorkingSetForGoal,
  rejectWorkingSetOffers,
  renderAssistantEnvelope,
  sortWorkingSetByPrice,
  resolveReferents,
  restoreWorkingSetOffers,
  setWorkingSetComparison,
  setWorkingSetFocus,
  transitionContainsFactualData,
  transitionOverstatesRanking,
  validateAssistantEnvelope,
  validateWorkingSet,
  validateGroundedClaimSet,
  evaluateAnswerability,
  disclosureIndicatesIncompleteSearchCoverage,
  claimEvidenceKey,
  clarificationKey,
  clarificationRationale,
  clarificationResponseSpec,
  clarificationWording,
  normalizeDialogueState,
  type AssistantEnvelope,
  type AnswerabilityDecision,
  type ValidatedClarificationAnswer,
  type ClarificationIntent,
  type GroundedClaimSet,
  type ConversationState,
  type GoalOperation,
  type SearchNeed,
  type PlanReview,
  type RepairRequiredPlanReview,
  type TurnOperation,
  type TurnPlan,
  type GroundedClaim,
  type WorkingSet,
  type TurnAction,
} from "@interec/domain";

import {
  toolNameForOperation,
  type AssistantEnvelopeProposal,
  type CommittedTurnPlan,
  type OperationReceipt,
  PlanReviewError,
  type TurnExecutionController,
  type TurnPlanProposal,
  type TransitionCode,
} from "./protocol.js";
import { normalizeTurnPlanProposal } from "./plan-normalizer.js";
import { bindOperation, bindPlan, groundTurnPlanProposal } from "./proposal-grounding.js";
import { constrainOrdinalRejections, normalizeUndoRevision, stabilizePlanReferents } from "./referent-planning.js";

export interface TurnActionResult {
  claims: GroundedClaim[];
  disclosureCodes: string[];
  publicResult: Record<string, unknown>;
}

export interface ShoppingDataPort {
  inspect(operation: Extract<TurnAction, { kind: "INSPECT_WORKING_SET" }>, offerRefs: string[], state: ConversationState, signal?: AbortSignal): Promise<TurnActionResult>;
  inspectSearchCoverage(operation: Extract<TurnAction, { kind: "INSPECT_SEARCH_COVERAGE" }>, state: ConversationState, signal?: AbortSignal): Promise<TurnActionResult>;
  search(operation: Extract<TurnAction, { kind: "SEARCH_OFFERS" }>, state: ConversationState, signal?: AbortSignal): Promise<{ workingSet: WorkingSet; result: TurnActionResult }>;
}

export interface TurnExecutionSnapshot {
  state: ConversationState;
  plan: TurnPlan;
  groundedClaims: GroundedClaimSet;
  evidenceKeys: string[];
  receipts: OperationReceipt[];
}

export interface PlanReviewObservation {
  proposalNumber: number;
  proposal: TurnPlanProposal;
  reviewedPlan: TurnPlan;
  review: PlanReview;
  approvedPlan: TurnPlan | null;
}

export interface ConversationTurnExecutorOptions {
  turnId: string;
  inputMessageIds: string[];
  inputMessageContents?: string[];
  baseState: ConversationState;
  searchNeed: SearchNeed;
  requiredFocusOfferRef?: string;
  clarificationAnswer?: ValidatedClarificationAnswer;
  planAuthority?: "PI_AGENT" | "STRUCTURED_INPUT";
  maxPlanProposals?: 1 | 2 | 3;
  shoppingData: ShoppingDataPort;
  loadRevision(revision: number): Promise<ConversationState | null>;
  onPlanCommitted?(plan: TurnPlan): Promise<void>;
  onPlanReviewed?(observation: PlanReviewObservation): Promise<void>;
  onDraftChanged?(snapshot: TurnExecutionSnapshot): Promise<void>;
  onReplyValidated?(input: {
    state: ConversationState;
    plan: TurnPlan;
    envelope: AssistantEnvelope;
    groundedClaims: GroundedClaimSet;
    evidenceKeys: string[];
    allowedClarificationIds: string[];
    allowedDisclosureCodes: string[];
    answerability: AnswerabilityDecision;
    renderedText: string;
    fallbackReasonCode?: string;
  }): Promise<void>;
}

function isGoalOperation(operation: TurnOperation): operation is GoalOperation {
  return operation.kind.startsWith("GOAL_");
}

function emptyActionResult(publicResult: Record<string, unknown> = {}): TurnActionResult {
  return { claims: [], disclosureCodes: [], publicResult };
}

function transitionText(code: TransitionCode): string {
  switch (code) {
    case "STATE_UPDATED": return "我已更新当前选购状态。";
    case "EVIDENCE_SUMMARY": return "以下内容来自当前可验证证据。";
    case "EVIDENCE_COMPARISON": return "我按当前可验证证据列出对比。";
    case "SEARCH_COMPLETED": return "我已完成本轮检索和证据校验。";
    case "CHECKED_PREMISE": return "我先按现有证据核对这个前提。";
  }
}

export class ConversationTurnExecutor implements TurnExecutionController {
  private readonly publicationRevision: number;
  private readonly baseGoalRevision: ConversationState["goalRevision"];
  private state: ConversationState;
  private plan: TurnPlan | null = null;
  private goalOperations: GoalOperation[] = [];
  private claims = new Map<string, GroundedClaim>();
  private evidenceKeys = new Set<string>();
  private receipts: OperationReceipt[] = [];
  private questionClarifications = new Map<string, { clarificationId: string; clarification: ClarificationIntent }>();
  private disclosureCodes = new Set<string>();
  private planProposalCount = 0;

  public constructor(private readonly options: ConversationTurnExecutorOptions) {
    if (options.inputMessageIds.length < 1 || options.inputMessageIds.length > 8) throw new Error("INVALID_CURRENT_MESSAGE_BATCH");
    if (options.inputMessageContents && options.inputMessageContents.length !== options.inputMessageIds.length) throw new Error("CURRENT_MESSAGE_BATCH_MISMATCH");
    if (options.maxPlanProposals !== undefined && ![1, 2, 3].includes(options.maxPlanProposals)) throw new Error("INVALID_PLAN_PROPOSAL_BUDGET");
    this.publicationRevision = options.baseState.revision + 1;
    this.baseGoalRevision = structuredClone(options.baseState.goalRevision);
    this.state = {
      ...structuredClone(options.baseState),
      dialogue: normalizeDialogueState(options.baseState.dialogue),
      revision: this.publicationRevision,
    };
    if (this.state.dialogue.pendingClarification?.clarification.kind === "TURN_REPHRASE") {
      this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_CLEAR_CLARIFICATION", clarification: { kind: "TURN_REPHRASE" } }]);
    }
  }

  public async commitPlan(proposal: TurnPlanProposal): Promise<CommittedTurnPlan> {
    if (this.plan) throw new DomainError("TURN_PLAN_ALREADY_COMMITTED", "A Turn may commit only one plan");
    this.planProposalCount += 1;
    const grounding = groundTurnPlanProposal({
      proposal,
      inputMessageIds: this.options.inputMessageIds,
      inputMessageContents: this.options.inputMessageContents,
      baseState: this.options.baseState,
      clarificationAnswer: this.options.clarificationAnswer,
    });
    const { normalizedProposal, supportedProposal, preflightViolations } = grounding;
    if (preflightViolations.length > 0) {
      const reviewedProposal = normalizeTurnPlanProposal(normalizedProposal, this.options.baseState);
      const reviewedPlan = stabilizePlanReferents(bindPlan(reviewedProposal, this.options.inputMessageIds), this.options.baseState.workingSet);
      await this.rejectPlanProposal(proposal, reviewedPlan, {
        decision: "REPAIR_REQUIRED",
        policyVersion: CONVERSATION_PLAN_POLICY_VERSION,
        violations: preflightViolations,
      });
    }
    const normalizedSupportedProposal = normalizeTurnPlanProposal(supportedProposal, this.options.baseState);
    const stablePlan = stabilizePlanReferents(bindPlan(normalizedSupportedProposal, this.options.inputMessageIds), this.options.baseState.workingSet);
    const undoNormalizedPlan = normalizeUndoRevision(stablePlan, this.options.baseState.revision, this.options.inputMessageContents);
    const proposedPlan = constrainOrdinalRejections(undoNormalizedPlan, this.options.baseState.workingSet, this.options.inputMessageContents);
    if (this.options.requiredFocusOfferRef) {
      const focusesRequiredOffer = proposedPlan.ops.some((operation) => operation.kind === "SET_FOCUS"
        && operation.referent?.kind === "OFFER_REF"
        && operation.referent.offerRef === this.options.requiredFocusOfferRef);
      if (!focusesRequiredOffer) {
        await this.rejectPlanProposal(proposal, proposedPlan, {
          decision: "REPAIR_REQUIRED",
          policyVersion: CONVERSATION_PLAN_POLICY_VERSION,
          violations: [{
            code: "UI_FOCUS_NOT_PLANNED",
            operationId: null,
            path: "ops",
            observed: { requiredFocusOfferRef: this.options.requiredFocusOfferRef },
            admissibleAlternatives: ["Add SET_FOCUS for the exact required OFFER_REF before operations that answer the focused UI request."],
          }],
        });
      }
    }
    const review = this.options.planAuthority === "STRUCTURED_INPUT"
      ? reviewStructuredConversationPlan
      : reviewConversationPlan;
    const reviewResult = review({ plan: proposedPlan, state: this.options.baseState, searchNeed: this.options.searchNeed });
    if (!("policyDecision" in reviewResult)) {
      return this.rejectPlanProposal(proposal, proposedPlan, reviewResult.review);
    }
    const policy = reviewResult.policyDecision;
    const plan = proposedPlan;
    await this.options.onPlanReviewed?.({
      proposalNumber: this.planProposalCount,
      proposal: structuredClone(proposal),
      reviewedPlan: structuredClone(proposedPlan),
      review: structuredClone(reviewResult.review),
      approvedPlan: structuredClone(plan),
    });
    this.plan = plan;
    this.state.dialogue.pendingOps = structuredClone(plan.leftover);
    await this.options.onPlanCommitted?.(plan);
    await this.stage();
    return { plan, route: policy.route, maxModelInferences: policy.route === "search" ? 4 : 2, review: reviewResult.review };
  }

  private async rejectPlanProposal(
    proposal: TurnPlanProposal,
    reviewedPlan: TurnPlan,
    review: RepairRequiredPlanReview,
  ): Promise<never> {
    const proposalBudget = this.options.maxPlanProposals ?? 2;
    const finalReview: PlanReview = this.planProposalCount >= proposalBudget
      ? { ...review, decision: "REJECTED", failureOwner: "SYSTEM" }
      : review;
    await this.options.onPlanReviewed?.({
      proposalNumber: this.planProposalCount,
      proposal: structuredClone(proposal),
      reviewedPlan: structuredClone(reviewedPlan),
      review: structuredClone(finalReview),
      approvedPlan: null,
    });
    throw new PlanReviewError(finalReview);
  }

  public async executeOperation(operation: TurnOperation, signal?: AbortSignal): Promise<OperationReceipt> {
    if (!this.plan) throw new DomainError("TURN_PLAN_REQUIRED", "TurnPlan must be committed before execution");
    if (this.receipts.some((receipt) => receipt.opId === operation.opId)) throw new DomainError("TURN_OPERATION_ALREADY_EXECUTED", `Operation already executed: ${operation.opId}`);
    let result: TurnActionResult;
    let status: OperationReceipt["status"] = "APPLIED";
    let uncertaintyType: OperationReceipt["uncertaintyType"];
    const questionClarifications: ClarificationIntent[] = [];
    try {
      if (isGoalOperation(operation)) {
        this.goalOperations.push(operation);
        this.state.goalRevision = createGoalRevision(this.baseGoalRevision, this.goalOperations, this.options.turnId, this.publicationRevision);
        this.applyGoalImpact(operation);
        if (this.state.dialogue.pendingClarification?.clarification.kind === "CANDIDATE_REFERENT") {
          this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{
            kind: "DIALOGUE_CLEAR_CLARIFICATION",
            clarification: this.state.dialogue.pendingClarification.clarification,
          }]);
        }
        if (operation.kind === "GOAL_RESOLVE_GAP") {
          const pending = this.state.dialogue.pendingClarification;
          if (pending) this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_CLEAR_CLARIFICATION", clarification: pending.clarification }]);
        }
        result = emptyActionResult({ goalVersion: this.state.goalRevision.version, operation: operation.kind });
      } else {
        result = await this.executeTurnAction(operation, signal);
        if (operation.kind === "REQUEST_CLARIFICATION") {
          questionClarifications.push(operation.clarification);
          uncertaintyType = operation.uncertainty.type;
        }
      }
    } catch (error) {
      if (error instanceof DomainError && ["CANDIDATE_REFERENT_NOT_FOUND", "CANDIDATE_REFERENT_AMBIGUOUS"].includes(error.code)) {
        status = "BLOCKED";
        uncertaintyType = "INTENT_AMBIGUITY";
        const clarification = { kind: "CANDIDATE_REFERENT" as const, contextRef: operation.opId };
        const clarificationId = `${this.options.turnId}:${operation.opId}`;
        questionClarifications.push(clarification);
        this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_REQUEST_CLARIFICATION", clarificationId, clarification, askedByMessageId: this.options.turnId }]);
        result = emptyActionResult({ blockedReasonCode: error.code });
      } else {
        throw error;
      }
    }
    for (const claim of result.claims) {
      if (this.claims.has(claim.claimId)) throw new DomainError("DUPLICATE_CLAIM_ID", `Duplicate claim from turn action: ${claim.claimId}`);
      this.claims.set(claim.claimId, claim);
      for (const evidence of claim.evidenceRefs) this.evidenceKeys.add(claimEvidenceKey(evidence));
    }
    for (const clarification of questionClarifications) {
      const key = clarificationKey(clarification);
      if (!this.questionClarifications.has(key)) {
        this.questionClarifications.set(key, { clarificationId: `${this.options.turnId}:${operation.opId}`, clarification });
      }
    }
    for (const code of result.disclosureCodes) this.disclosureCodes.add(code);
    const receipt: OperationReceipt = {
      opId: operation.opId,
      toolName: toolNameForOperation(operation),
      status,
      claimIds: result.claims.map((claim) => claim.claimId),
      questionClarifications,
      disclosureCodes: result.disclosureCodes,
      ...(uncertaintyType ? { uncertaintyType } : {}),
      publicResult: result.publicResult,
    };
    this.receipts.push(receipt);
    await this.stage();
    return structuredClone(receipt);
  }

  private applyGoalImpact(operation: GoalOperation): void {
    if (operation.kind === "GOAL_SET_TARGET" || operation.kind === "GOAL_CLEAR_TARGET") {
      const before = this.baseGoalRevision?.goal.target ?? null;
      const after = this.state.goalRevision?.goal.target ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) this.state.workingSet = null;
    }
    if (this.state.workingSet && this.state.goalRevision) {
      this.state.workingSet = reprojectWorkingSetForGoal(validateWorkingSet({
        ...this.state.workingSet,
        version: this.publicationRevision,
        boundGoalVersion: this.state.goalRevision.version,
      }), this.state.goalRevision.goal);
      this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{
        kind: "DIALOGUE_SYNC_WORKING_SET",
        focusOfferRef: this.state.workingSet.focusOfferRef,
        comparisonOfferRefs: this.state.workingSet.comparisonOfferRefs,
      }]);
    }
  }

  private requireWorkingSet(): WorkingSet {
    if (!this.state.workingSet) throw new DomainError("WORKING_SET_REQUIRED", "This operation requires a current working set");
    return this.state.workingSet;
  }

  private publishWorkingSet(workingSet: WorkingSet): void {
    this.state.workingSet = validateWorkingSet({
      ...workingSet,
      version: this.publicationRevision,
      boundGoalVersion: this.state.goalRevision?.version ?? workingSet.boundGoalVersion,
    });
    this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{
      kind: "DIALOGUE_SYNC_WORKING_SET",
      focusOfferRef: this.state.workingSet.focusOfferRef,
      comparisonOfferRefs: this.state.workingSet.comparisonOfferRefs,
    }]);
  }

  private async executeTurnAction(operation: TurnAction, signal?: AbortSignal): Promise<TurnActionResult> {
    switch (operation.kind) {
      case "REJECT_OFFERS": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(rejectWorkingSetOffers(set, refs));
        return emptyActionResult({ offerRefs: refs });
      }
      case "RESTORE_OFFERS": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(restoreWorkingSetOffers(set, refs));
        return emptyActionResult({ offerRefs: refs });
      }
      case "SET_COMPARISON": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(setWorkingSetComparison(set, refs));
        return emptyActionResult({ offerRefs: refs });
      }
      case "SET_FOCUS": {
        const set = this.requireWorkingSet();
        const refs = operation.referent === null ? [] : resolveReferents(set, [operation.referent]);
        if (refs.length > 1) throw new DomainError("FOCUS_REQUIRES_ONE_OFFER", `Focus resolved to multiple offers: ${refs.join(",")}`);
        this.publishWorkingSet(setWorkingSetFocus(set, refs[0] ?? null));
        return emptyActionResult({ offerRef: refs[0] ?? null });
      }
      case "INSPECT_WORKING_SET": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(markWorkingSetMentioned(set, refs));
        return this.options.shoppingData.inspect(operation, refs, structuredClone(this.state), signal);
      }
      case "INSPECT_SEARCH_COVERAGE":
        return this.options.shoppingData.inspectSearchCoverage(operation, structuredClone(this.state), signal);
      case "REFILTER_WORKING_SET": {
        const set = this.requireWorkingSet();
        const configured = this.state.goalRevision?.goal.retrievalMarkets ?? [];
        const markets = configured.length > 0 ? configured : [...new Set(set.pool.map((candidate) => candidate.retrievalMarket))];
        this.publishWorkingSet(refilterWorkingSetByMarkets(set, markets));
        return emptyActionResult({ displayOfferRefs: this.state.workingSet!.displayOfferRefs });
      }
      case "SORT_WORKING_SET_BY_PRICE": {
        const set = this.requireWorkingSet();
        if (operation.preferenceKey.toLocaleLowerCase().includes("price")) {
          this.publishWorkingSet(sortWorkingSetByPrice(set));
        } else {
          const goal = this.state.goalRevision?.goal;
          if (!goal?.preferences.some((preference) => preference.key === operation.preferenceKey)) {
            throw new DomainError("UNSUPPORTED_RERANK_POLICY", `Preference is not present in the current shopping goal: ${operation.preferenceKey}`);
          }
          this.publishWorkingSet(reprojectWorkingSetForGoal(set, goal));
        }
        return emptyActionResult({ displayOfferRefs: this.state.workingSet!.displayOfferRefs });
      }
      case "SEARCH_OFFERS": {
        const searchResult = await this.options.shoppingData.search(operation, structuredClone(this.state), signal);
        this.publishWorkingSet(searchResult.workingSet);
        return searchResult.result;
      }
      case "REQUEST_CLARIFICATION":
        // Validate the cross-layer protocol value before it can enter dialogue
        // state. Unknown model-authored values fail closed and are recovered as
        // a protocol rephrase by fallbackReply instead of producing vague copy.
        clarificationWording(operation.clarification);
        {
          const clarificationId = `${this.options.turnId}:${operation.opId}`;
          this.questionClarifications.set(clarificationKey(operation.clarification), { clarificationId, clarification: operation.clarification });
          this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_REQUEST_CLARIFICATION", clarificationId, clarification: operation.clarification, askedByMessageId: this.options.turnId }]);
          return emptyActionResult({ clarificationId, clarification: operation.clarification, reasonCode: operation.reasonCode });
        }
      case "RESOLVE_CLARIFICATION": {
        const pending = this.state.dialogue.pendingClarification;
        if (!pending || pending.clarificationId !== operation.clarificationId) {
          throw new DomainError("STALE_CLARIFICATION_ID", operation.clarificationId);
        }
        if (clarificationKey(pending.clarification) !== clarificationKey(operation.clarification)) {
          throw new DomainError("CLARIFICATION_KIND_MISMATCH", operation.clarificationId);
        }
        this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{
          kind: "DIALOGUE_RECORD_CLARIFICATION_OUTCOME",
          clarification: operation.clarification,
          outcome: operation.outcome,
          goalVersion: this.state.goalRevision?.version ?? null,
        }]);
        return emptyActionResult({ clarificationId: operation.clarificationId, outcome: operation.outcome });
      }
      case "UNDO_REVISION": {
        const target = await this.options.loadRevision(operation.revision);
        if (!target) throw new DomainError("UNDO_TARGET_NOT_FOUND", `Conversation revision not found: ${operation.revision}`);
        this.state = { ...structuredClone(target), revision: this.publicationRevision, status: this.options.baseState.status };
        return emptyActionResult({ restoredRevision: operation.revision });
      }
    }
  }

  public async publishReply(proposal: AssistantEnvelopeProposal): Promise<AssistantEnvelope> {
    if (!this.plan) throw new DomainError("TURN_PLAN_REQUIRED", "TurnPlan must be committed before reply publication");
    const answerability = evaluateAnswerability({ plan: this.plan, receipts: this.receipts });
    const hasSearch = this.plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS");
    const hasClarification = this.plan.ops.some((operation) => operation.kind === "REQUEST_CLARIFICATION");
    const coverageInspectionOnly = this.plan.ops.every((operation) => operation.kind === "INSPECT_SEARCH_COVERAGE");
    const materializedBlocks: AssistantEnvelope["blocks"] = proposal.blocks.map((block) => {
      if (block.type === "QUESTION") {
        const registered = this.questionClarifications.get(clarificationKey(block.clarification));
        if (!registered) throw new DomainError("QUESTION_CLARIFICATION_NOT_ALLOWED", clarificationKey(block.clarification));
        return this.materializeQuestion(registered.clarification);
      }
      if (block.type === "TRANSITION") return {
        type: "TRANSITION",
        text: transitionText(coverageInspectionOnly ? "CHECKED_PREMISE" : block.transitionCode),
      };
      return block;
    });
    const hasQuestionBlock = materializedBlocks.some((block) => block.type === "QUESTION");
    const safeBlocks = materializedBlocks.filter((block) =>
      block.type !== "TRANSITION"
      || (!transitionContainsFactualData(block.text) && !transitionOverstatesRanking(block.text) && !hasQuestionBlock)
    );
    for (const disclosureCode of this.disclosureCodes) {
      if (!safeBlocks.some((block) => block.type === "DISCLOSURE" && block.disclosureCode === disclosureCode)) {
        safeBlocks.push({ type: "DISCLOSURE", disclosureCode });
      }
    }
    if (answerability.mode === "CLARIFY" && !safeBlocks.some((block) => block.type === "QUESTION")) {
      safeBlocks.push(this.materializeQuestion(answerability.clarification));
    }
    if (answerability.mode === "DEGRADE") {
      safeBlocks.splice(0, safeBlocks.length, {
        type: "TRANSITION",
        text: "这轮请求因系统处理失败未能完成，不是你的表达问题。你可以稍后重试。",
      });
    }
    if (safeBlocks.length === 0) {
      safeBlocks.push({
        type: "TRANSITION",
        text: hasSearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
          ? "当前没有形成可验证的候选。"
          : "我已更新当前选购状态。",
      });
    }
    const allCandidatesAreSearchOnly = (this.state.workingSet?.pool.length ?? 0) > 0
      && this.state.workingSet!.pool.every((candidate) => candidate.ranking?.validationMode === "SEARCH_ONLY");
    const incompleteSearchCoverage = [...this.disclosureCodes].some(disclosureIndicatesIncompleteSearchCoverage);
    const outcome = answerability.mode === "DEGRADE"
      ? "DEGRADED"
      : answerability.mode === "CLARIFY" || hasClarification
      ? "CLARIFICATION"
      : hasSearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? incompleteSearchCoverage ? "CHAT" : "NO_MATCH"
        : allCandidatesAreSearchOnly && (hasSearch || proposal.outcome === "RECOMMENDATION")
          ? "SEARCH_RESULTS"
        : hasSearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) > 0
          ? "RECOMMENDATION"
          : proposal.outcome;
    const envelope: AssistantEnvelope = {
      ...proposal,
      outcome,
      blocks: safeBlocks,
      addressedOpIds: this.plan.ops.map((operation) => operation.opId),
      nextMoves: proposal.nextMoves.map((move) => ({
        id: move.id,
        label: move.label,
        operation: bindOperation(move.operation, this.options.inputMessageIds),
      })),
    };
    const groundedClaims = this.groundedClaimsForEnvelope(envelope);
    validateAssistantEnvelope(envelope, {
      plan: this.plan,
      groundedClaims,
      allowedOfferRefs: new Set(this.state.workingSet?.pool.map((candidate) => candidate.offerRef) ?? []),
      allowedClarificationIds: new Set([...this.questionClarifications.values()].map((item) => item.clarificationId)),
      allowedDisclosureCodes: this.disclosureCodes,
    });
    if (groundedClaims.claims.length > 0) {
      if (!this.state.workingSet) throw new DomainError("CLAIM_WORKING_SET_REQUIRED", "Claims require a working set");
      validateGroundedClaimSet(groundedClaims, {
        workingSet: this.state.workingSet,
        allowedEvidenceRefs: this.evidenceKeys,
        envelope,
        renderedDraft: renderAssistantEnvelope(envelope, groundedClaims),
      });
    }
    const renderedText = renderAssistantEnvelope(envelope, groundedClaims);
    await this.options.onReplyValidated?.({
      state: structuredClone(this.state),
      plan: structuredClone(this.plan),
      envelope: structuredClone(envelope),
      groundedClaims,
      evidenceKeys: [...this.evidenceKeys],
      allowedClarificationIds: [...this.questionClarifications.values()].map((item) => item.clarificationId),
      allowedDisclosureCodes: [...this.disclosureCodes],
      answerability: structuredClone(answerability),
      renderedText,
    });
    return structuredClone(envelope);
  }

  public async fallbackReply(errorCode: string, plan: TurnPlan | null, receipts: OperationReceipt[] = []): Promise<AssistantEnvelope> {
    const blockedClarification = [...receipts].reverse().flatMap((receipt) => receipt.questionClarifications)[0] ?? null;
    if (!plan) {
      // A pre-plan failure has no approved business plan. Publish a system-owned
      // degradation without mutating dialogue or blaming the user's wording.
      plan = {
        userIntentSummary: "system-owned degraded publication after planning failure",
        ops: [],
        leftover: [],
      };
      this.plan = plan;
      const answerability = evaluateAnswerability({ plan, receipts: [], systemFailureCode: errorCode });
      const envelope: AssistantEnvelope = {
        outcome: "DEGRADED",
        addressedOpIds: [],
        blocks: [{
          type: "TRANSITION",
          text: "这轮请求因系统处理失败未能完成，不是你的表达问题。你可以稍后重试。",
        }],
        nextMoves: [],
      };
      const fallbackLedger: GroundedClaimSet = { claims: [] };
      const renderedText = renderAssistantEnvelope(envelope, fallbackLedger);
      await this.options.onReplyValidated?.({
        state: structuredClone(this.state),
        plan: structuredClone(plan),
        envelope: structuredClone(envelope),
        groundedClaims: fallbackLedger,
        evidenceKeys: [...this.evidenceKeys],
        allowedClarificationIds: [],
        allowedDisclosureCodes: [...this.disclosureCodes],
        answerability: structuredClone(answerability),
        renderedText,
        fallbackReasonCode: errorCode,
      });
      return envelope;
    }
    const fallbackClaimIds = [...new Set(receipts.flatMap((receipt) => receipt.claimIds))];
    if (plan && fallbackClaimIds.length > 0) {
      const disclosureCodes = [...new Set(receipts.flatMap((receipt) => receipt.disclosureCodes))];
      const claimLimit = Math.max(1, 20 - disclosureCodes.length - 1);
      const hasSearch = plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS");
      const incompleteSearchCoverage = disclosureCodes.some(disclosureIndicatesIncompleteSearchCoverage);
      const outcome: AssistantEnvelope["outcome"] = hasSearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? incompleteSearchCoverage ? "CHAT" : "NO_MATCH"
        : hasSearch && (this.state.workingSet?.pool.length ?? 0) > 0
          && this.state.workingSet!.pool.every((candidate) => candidate.ranking?.validationMode === "SEARCH_ONLY")
          ? "SEARCH_RESULTS"
          : hasSearch
            ? "RECOMMENDATION"
            : "CHAT";
      const envelope: AssistantEnvelope = {
        outcome,
        addressedOpIds: plan.ops.map((operation) => operation.opId),
        blocks: [
          { type: "TRANSITION", text: transitionText(hasSearch ? "SEARCH_COMPLETED" : "EVIDENCE_SUMMARY") },
          ...disclosureCodes.map((disclosureCode) => ({ type: "DISCLOSURE" as const, disclosureCode })),
          ...fallbackClaimIds.slice(0, claimLimit).map((claimId) => ({ type: "CLAIM" as const, claimId })),
        ],
        nextMoves: [],
      };
      const fallbackLedger = this.groundedClaimsForEnvelope(envelope);
      validateAssistantEnvelope(envelope, {
        plan,
        groundedClaims: fallbackLedger,
        allowedOfferRefs: new Set(this.state.workingSet?.pool.map((candidate) => candidate.offerRef) ?? []),
        allowedClarificationIds: new Set([...this.questionClarifications.values()].map((item) => item.clarificationId)),
        allowedDisclosureCodes: this.disclosureCodes,
      });
      if (!this.state.workingSet) throw new DomainError("CLAIM_WORKING_SET_REQUIRED", "Claims require a working set");
      validateGroundedClaimSet(fallbackLedger, {
        workingSet: this.state.workingSet,
        allowedEvidenceRefs: this.evidenceKeys,
        envelope,
        renderedDraft: renderAssistantEnvelope(envelope, fallbackLedger),
      });
      const renderedText = renderAssistantEnvelope(envelope, fallbackLedger);
      const answerability = evaluateAnswerability({ plan, receipts });
      await this.options.onReplyValidated?.({
        state: structuredClone(this.state),
        plan: structuredClone(plan),
        envelope: structuredClone(envelope),
        groundedClaims: fallbackLedger,
        evidenceKeys: [...this.evidenceKeys],
        allowedClarificationIds: [...this.questionClarifications.values()].map((item) => item.clarificationId),
        allowedDisclosureCodes: [...this.disclosureCodes],
        answerability: structuredClone(answerability),
        renderedText,
        fallbackReasonCode: errorCode,
      });
      return envelope;
    }
    const fullyExecuted = plan !== null
      && receipts.length === plan.ops.length
      && receipts.every((receipt) => receipt.status !== "FAILED");
    if (plan && fullyExecuted && !blockedClarification) {
      const disclosureCodes = [...new Set(receipts.flatMap((receipt) => receipt.disclosureCodes))];
      const hasSearch = plan.ops.some((operation) => operation.kind === "SEARCH_OFFERS");
      const incompleteSearchCoverage = disclosureCodes.some(disclosureIndicatesIncompleteSearchCoverage);
      const outcome: AssistantEnvelope["outcome"] = hasSearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? incompleteSearchCoverage ? "CHAT" : "NO_MATCH"
        : hasSearch && (this.state.workingSet?.pool.length ?? 0) > 0
          && this.state.workingSet!.pool.every((candidate) => candidate.ranking?.validationMode === "SEARCH_ONLY")
          ? "SEARCH_RESULTS"
          : "CHAT";
      const envelope: AssistantEnvelope = {
        outcome,
        addressedOpIds: plan.ops.map((operation) => operation.opId),
        blocks: [
          { type: "TRANSITION", text: transitionText(hasSearch ? "SEARCH_COMPLETED" : "STATE_UPDATED") },
          ...disclosureCodes.slice(0, 19).map((disclosureCode) => ({ type: "DISCLOSURE" as const, disclosureCode })),
        ],
        nextMoves: [],
      };
      const fallbackLedger = this.groundedClaimsForEnvelope(envelope);
      validateAssistantEnvelope(envelope, {
        plan,
        groundedClaims: fallbackLedger,
        allowedOfferRefs: new Set(this.state.workingSet?.pool.map((candidate) => candidate.offerRef) ?? []),
        allowedClarificationIds: new Set([...this.questionClarifications.values()].map((item) => item.clarificationId)),
        allowedDisclosureCodes: this.disclosureCodes,
      });
      const renderedText = renderAssistantEnvelope(envelope, fallbackLedger);
      const answerability = evaluateAnswerability({ plan, receipts });
      await this.options.onReplyValidated?.({
        state: structuredClone(this.state),
        plan: structuredClone(plan),
        envelope: structuredClone(envelope),
        groundedClaims: fallbackLedger,
        evidenceKeys: [...this.evidenceKeys],
        allowedClarificationIds: [...this.questionClarifications.values()].map((item) => item.clarificationId),
        allowedDisclosureCodes: [...this.disclosureCodes],
        answerability: structuredClone(answerability),
        renderedText,
        fallbackReasonCode: errorCode,
      });
      return envelope;
    }
    const answerability = blockedClarification
      ? evaluateAnswerability({ plan, receipts })
      : evaluateAnswerability({ plan, receipts, systemFailureCode: errorCode });
    const envelope: AssistantEnvelope = answerability.mode === "CLARIFY" ? {
      outcome: "CLARIFICATION",
      addressedOpIds: plan.ops.map((operation) => operation.opId),
      blocks: [this.materializeQuestion(answerability.clarification)],
      nextMoves: [],
    } : {
      outcome: "DEGRADED",
      addressedOpIds: plan.ops.map((operation) => operation.opId),
      blocks: [{
        type: "TRANSITION",
        text: "这轮请求因系统处理失败未能完成，不是你的表达问题。你可以稍后重试。",
      }],
      nextMoves: [],
    };
    const fallbackLedger = this.groundedClaimsForEnvelope(envelope);
    const renderedText = renderAssistantEnvelope(envelope, fallbackLedger);
    await this.options.onReplyValidated?.({
      state: structuredClone(this.state),
      plan: structuredClone(plan),
      envelope: structuredClone(envelope),
      groundedClaims: fallbackLedger,
      evidenceKeys: [...this.evidenceKeys],
      allowedClarificationIds: [...this.questionClarifications.values()].map((item) => item.clarificationId),
      allowedDisclosureCodes: [...this.disclosureCodes],
      answerability: structuredClone(answerability),
      renderedText,
      fallbackReasonCode: errorCode,
    });
    return envelope;
  }

  private materializeQuestion(clarification: ClarificationIntent): Extract<AssistantEnvelope["blocks"][number], { type: "QUESTION" }> {
    const registered = this.questionClarifications.get(clarificationKey(clarification));
    if (!registered) throw new DomainError("QUESTION_CLARIFICATION_NOT_ALLOWED", clarificationKey(clarification));
    return {
      type: "QUESTION",
      clarificationId: registered.clarificationId,
      clarification: registered.clarification,
      wording: clarificationWording(registered.clarification),
      rationale: clarificationRationale(registered.clarification),
      responseSpec: clarificationResponseSpec(registered.clarification),
    };
  }

  private groundedClaims(): GroundedClaimSet {
    return { claims: [...this.claims.values()].map((claim) => structuredClone(claim)) };
  }

  private groundedClaimsForEnvelope(envelope: AssistantEnvelope): GroundedClaimSet {
    const referenced = new Set(envelope.blocks.flatMap((block) => {
      if (block.type === "CLAIM") return [block.claimId];
      if (block.type === "COMPARISON") return block.claimIds;
      return [];
    }));
    return {
      claims: [...referenced].map((claimId) => {
        const claim = this.claims.get(claimId);
        if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `Claim was not produced by this Turn: ${claimId}`);
        return structuredClone(claim);
      }),
    };
  }

  private async stage(): Promise<void> {
    if (!this.plan) return;
    await this.options.onDraftChanged?.({
      state: structuredClone(this.state),
      plan: structuredClone(this.plan),
      groundedClaims: this.groundedClaims(),
      evidenceKeys: [...this.evidenceKeys],
      receipts: structuredClone(this.receipts),
    });
  }
}
