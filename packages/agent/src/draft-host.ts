import {
  DomainError,
  canonicalProductModel,
  resolveCategoryContract,
  applyDialogueOperations,
  createGoalRevision,
  evaluateConversationPolicy,
  markWorkingSetMentioned,
  refilterWorkingSetByMarkets,
  reprojectWorkingSetForGoal,
  rejectWorkingSetOffers,
  renderAssistantEnvelope,
  rerankWorkingSetByPrice,
  resolveReferents,
  restoreWorkingSetOffers,
  setWorkingSetComparison,
  setWorkingSetFocus,
  transitionContainsFactualData,
  transitionOverstatesRanking,
  validateAssistantEnvelope,
  validateTurnPlan,
  validateWorkingSet,
  verifyClaimLedger,
  claimEvidenceKey,
  clarificationWording,
  type AssistantEnvelope,
  type ClaimLedger,
  type ConversationState,
  type GoalOperation,
  type ResearchNeed,
  type TurnOperation,
  type TurnPlan,
  type VerifiedClaim,
  type WorkingSet,
  type WorldOperation,
} from "@interec/domain";

import {
  toolNameForOperation,
  type AssistantEnvelopeProposal,
  type CommittedTurnPlan,
  type OperationReceipt,
  type ProposedTurnOperation,
  type TurnHostOperations,
  type TurnPlanProposal,
  type TransitionCode,
} from "./protocol.js";

export interface WorldOperationResult {
  claims: VerifiedClaim[];
  disclosureCodes: string[];
  publicResult: Record<string, unknown>;
}

export interface TurnWorldPort {
  inspect(operation: Extract<WorldOperation, { kind: "INSPECT_WORKING_SET" }>, offerRefs: string[], state: ConversationState, signal?: AbortSignal): Promise<WorldOperationResult>;
  research(operation: Extract<WorldOperation, { kind: "RESEARCH_OFFERS" }>, state: ConversationState, signal?: AbortSignal): Promise<{ workingSet: WorkingSet; result: WorldOperationResult }>;
}

export interface TurnDraftSnapshot {
  state: ConversationState;
  plan: TurnPlan;
  claimLedger: ClaimLedger;
  evidenceKeys: string[];
  receipts: OperationReceipt[];
}

export interface TurnDraftHostOptions {
  turnId: string;
  inputMessageIds: string[];
  inputMessageContents?: string[];
  baseState: ConversationState;
  researchNeed: ResearchNeed;
  requiredFocusOfferRef?: string;
  world: TurnWorldPort;
  loadRevision(revision: number): Promise<ConversationState | null>;
  onPlanCommitted?(plan: TurnPlan): Promise<void>;
  onDraftChanged?(snapshot: TurnDraftSnapshot): Promise<void>;
  onReplyValidated?(input: {
    state: ConversationState;
    plan: TurnPlan;
    envelope: AssistantEnvelope;
    claimLedger: ClaimLedger;
    evidenceKeys: string[];
    allowedQuestionSlotIds: string[];
    allowedDisclosureCodes: string[];
    renderedText: string;
    fallbackReasonCode?: string;
  }): Promise<void>;
}

function isGoalOperation(operation: TurnOperation): operation is GoalOperation {
  return operation.kind.startsWith("GOAL_");
}

function bindOperation(operation: ProposedTurnOperation, messageIds: string[]): TurnOperation {
  if (operation.kind.startsWith("GOAL_") && "sourceMessageOrdinal" in operation) {
    const { sourceMessageOrdinal, sourceSpan, ...value } = operation;
    const messageId = messageIds[sourceMessageOrdinal];
    if (!messageId) throw new DomainError("SOURCE_MESSAGE_ORDINAL_NOT_FOUND", `Current message ordinal is not available: ${sourceMessageOrdinal}`);
    if (sourceSpan && sourceSpan.end < sourceSpan.start) throw new DomainError("INVALID_SOURCE_SPAN", "Operation source span end must not precede start");
    return {
      ...value,
      source: { messageId, ...(sourceSpan ? { span: sourceSpan } : {}) },
    } as TurnOperation;
  }
  const { sourceMessageOrdinal: _sourceMessageOrdinal, sourceSpan: _sourceSpan, ...worldOperation } = operation;
  return structuredClone(worldOperation) as TurnOperation;
}

function bindPlan(proposal: TurnPlanProposal, messageIds: string[]): TurnPlan {
  return validateTurnPlan({
    userIntentSummary: proposal.userIntentSummary,
    ops: proposal.ops.map((operation) => bindOperation(operation, messageIds)),
    leftover: proposal.leftover.map((pending) => ({ conditionCode: pending.conditionCode, operation: bindOperation(pending.operation, messageIds) })),
  });
}

function compactText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function sourceText(operation: ProposedTurnOperation, contents: string[]): string {
  if (!("sourceMessageOrdinal" in operation) || operation.sourceMessageOrdinal === undefined) return "";
  const content = contents[operation.sourceMessageOrdinal] ?? "";
  if (!operation.sourceSpan) return content;
  const { start, end } = operation.sourceSpan;
  return start >= 0 && end >= start && end <= content.length ? content.slice(start, end) : "";
}

function sanitizeGoalProposal(proposal: TurnPlanProposal, contents: string[] | undefined): TurnPlanProposal {
  if (!contents) return proposal;
  const explicitlyOmitsBudget = contents.some((content) => /(?:不设|没有|无需|不限|无)预算|预算(?:不限|不设|无所谓)|no\s+budget|without\s+(?:a\s+)?budget|unlimited\s+budget/iu.test(content));
  const supportedMarket = (market: string, text: string) => {
    const upper = market.toUpperCase();
    if (upper === "US") return /美国|美区|\bUS\b|United States/iu.test(text);
    if (upper === "SG") return /新加坡|新加坡区|\bSG\b|Singapore/iu.test(text);
    return compactText(text).includes(compactText(market));
  };
  const sanitize = (operation: ProposedTurnOperation): ProposedTurnOperation | null => {
    if (!operation.kind.startsWith("GOAL_")) {
      if (operation.kind === "REQUEST_CLARIFICATION" && explicitlyOmitsBudget && /budget|预算/iu.test(operation.slotId)) return null;
      return operation;
    }
    const text = sourceText(operation, contents);
    if (operation.kind === "GOAL_SET_BUDGET") {
      if (explicitlyOmitsBudget) return null;
      const requested = operation.budget.amount.replace(/,/g, "").replace(/\.0+$/, "");
      if (!requested || !operation.budget.currency.trim()) return null;
      const amounts = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/gu)].map((match) => match[0]!.replace(/,/g, "").replace(/\.0+$/, ""));
      if (!amounts.includes(requested)) return null;
      const currency = /美元|\bUSD\b|US\$/iu.test(text)
        ? "USD"
        : /新加坡元|新币|\bSGD\b|S\$/iu.test(text)
          ? "SGD"
          : /人民币|\bCNY\b|\bRMB\b|元/iu.test(text)
            ? "CNY"
            : operation.budget.currency;
      return { ...operation, budget: { ...operation.budget, currency } };
    }
    if (operation.kind === "GOAL_SET_RETRIEVAL_MARKETS") {
      const markets = operation.markets.filter((market) => supportedMarket(market, text));
      return markets.length > 0 ? { ...operation, markets } : null;
    }
    if (operation.kind === "GOAL_SET_TARGET") {
      const registeredCategory = resolveCategoryContract(operation.target.categoryId);
      const explicitTargetText = operation.target.targetText?.trim();
      // Open categories have no deterministic lexicon yet. If the model omits
      // targetText, retain the exact source message as the auditable retrieval
      // anchor instead of either dropping the product intent or trusting an
      // ungrounded model-authored translation.
      const proposedTargetText = explicitTargetText
        || (!registeredCategory ? text.normalize("NFKC").trim().slice(0, 200) : "")
        || operation.target.categoryId;
      const categorySupported = registeredCategory?.categoryId === "headphones"
        ? /耳机|headphones?|headsets?/iu.test(text)
        : registeredCategory?.categoryId === "smartphone"
          ? /手机|iphones?|smartphones?|mobile\s+phones?|galaxy|pixel/iu.test(text)
          : Boolean(text.trim()) && compactText(text).includes(compactText(proposedTargetText));
      if (!categorySupported) return null;
      const conditionSupported = operation.target.condition === "ANY"
        || (operation.target.condition === "NEW" && /新机|全新|brand[\s-]?new|\bnew\b/iu.test(text))
        || (operation.target.condition === "REFURBISHED" && /翻新|refurbished|renewed/iu.test(text))
        || (operation.target.condition === "USED" && /二手|pre[\s-]?owned|\bused\b/iu.test(text));
      const modelSupported = operation.target.canonicalModel === null
        || compactText(text).includes(compactText(operation.target.canonicalModel));
      const explicitModel = canonicalProductModel(text, operation.target.categoryId);
      return {
        ...operation,
        target: {
          ...operation.target,
          ...(!registeredCategory ? { targetText: proposedTargetText } : {}),
          condition: conditionSupported ? operation.target.condition : "ANY",
          canonicalModel: explicitModel ?? (modelSupported ? operation.target.canonicalModel : null),
        },
      };
    }
    if (operation.kind === "GOAL_UPSERT_CONSTRAINT" && /^(?:storage|storage_capacity|capacity)$/iu.test(operation.constraint.key)) {
      return canonicalProductModel(text, "smartphone") ? null : operation;
    }
    return operation;
  };
  const ops = proposal.ops.flatMap((operation) => {
    const value = sanitize(operation);
    return value ? [value] : [];
  });
  const leftover = proposal.leftover.flatMap((pending) => {
    const operation = sanitize(pending.operation);
    return operation ? [{ ...pending, operation }] : [];
  });
  return { ...proposal, ops, leftover };
}

function stableOfferReferents(
  set: WorkingSet,
  referents: Parameters<typeof resolveReferents>[1],
  planned: { focusOfferRef: string | null; comparisonOfferRefs: string[] },
) {
  return referents.flatMap((referent) => {
    if (referent.kind === "FOCUS" && planned.focusOfferRef) return [{ kind: "OFFER_REF" as const, offerRef: planned.focusOfferRef }];
    if (referent.kind === "COMPARISON" && planned.comparisonOfferRefs.length > 0) {
      return planned.comparisonOfferRefs.map((offerRef) => ({ kind: "OFFER_REF" as const, offerRef }));
    }
    return resolveReferents(set, [referent]).map((offerRef) => ({ kind: "OFFER_REF" as const, offerRef }));
  });
}

function stabilizePlanReferents(plan: TurnPlan, workingSet: WorkingSet | null): TurnPlan {
  if (!workingSet || workingSet.displayOfferRefs.length === 0) return plan;
  const planned = {
    focusOfferRef: workingSet.focusOfferRef,
    comparisonOfferRefs: [...workingSet.comparisonOfferRefs],
  };
  const ops = plan.ops.map((operation): TurnOperation => {
    switch (operation.kind) {
      case "REJECT_OFFERS":
      case "RESTORE_OFFERS":
      case "INSPECT_WORKING_SET":
        return { ...operation, referents: stableOfferReferents(workingSet, operation.referents, planned) };
      case "SET_COMPARISON": {
        const referents = stableOfferReferents(workingSet, operation.referents, planned);
        planned.comparisonOfferRefs = referents.map((referent) => referent.offerRef);
        return { ...operation, referents };
      }
      case "SET_FOCUS": {
        if (operation.referent === null) {
          planned.focusOfferRef = null;
          return operation;
        }
        const refs = stableOfferReferents(workingSet, [operation.referent], planned);
        if (refs.length !== 1) throw new DomainError("FOCUS_REQUIRES_ONE_OFFER", `Focus resolved to ${refs.length} offers`);
        planned.focusOfferRef = refs[0]!.offerRef;
        return { ...operation, referent: refs[0]! };
      }
      default:
        return operation;
    }
  });
  return validateTurnPlan({ ...plan, ops });
}

function explicitOrdinalRanks(contents: string[]): number[] {
  const values = new Map<string, number>([
    ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5],
    ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10],
  ]);
  return [...new Set(contents.flatMap((content) => [...content.matchAll(/第\s*(\d+|[一二两三四五六七八九十])\s*(?:个|项|款)?/gu)].flatMap((match) => {
    const rank = /^\d+$/u.test(match[1]!) ? Number(match[1]) : values.get(match[1]!);
    return rank && Number.isSafeInteger(rank) ? [rank] : [];
  })))];
}

function constrainOrdinalRejections(plan: TurnPlan, workingSet: WorkingSet | null, contents: string[] | undefined): TurnPlan {
  if (!workingSet || !contents) return plan;
  const ranks = explicitOrdinalRanks(contents);
  if (ranks.length === 0) return plan;
  const allowed = new Set(ranks.flatMap((rank) => workingSet.displayOfferRefs[rank - 1] ? [workingSet.displayOfferRefs[rank - 1]!] : []));
  const ops = plan.ops.flatMap((operation): TurnOperation[] => {
    if (operation.kind !== "REJECT_OFFERS") return [operation];
    const referents = operation.referents.filter((referent) => referent.kind === "OFFER_REF" && allowed.has(referent.offerRef));
    return referents.length > 0 ? [{ ...operation, referents }] : [];
  });
  return validateTurnPlan({ ...plan, ops });
}

function emptyWorldResult(publicResult: Record<string, unknown> = {}): WorldOperationResult {
  return { claims: [], disclosureCodes: [], publicResult };
}

function transitionText(code: TransitionCode): string {
  switch (code) {
    case "STATE_UPDATED": return "我已更新当前选购状态。";
    case "EVIDENCE_SUMMARY": return "以下内容来自当前可验证证据。";
    case "EVIDENCE_COMPARISON": return "我按当前可验证证据列出对比。";
    case "RESEARCH_COMPLETED": return "我已完成本轮检索和证据校验。";
    case "CHECKED_PREMISE": return "我先按现有证据核对这个前提。";
  }
}

export class ConversationTurnDraftHost implements TurnHostOperations {
  private readonly publicationRevision: number;
  private readonly baseGoalRevision: ConversationState["goalRevision"];
  private state: ConversationState;
  private plan: TurnPlan | null = null;
  private goalOperations: GoalOperation[] = [];
  private claims = new Map<string, VerifiedClaim>();
  private evidenceKeys = new Set<string>();
  private receipts: OperationReceipt[] = [];
  private questionSlotIds = new Set<string>();
  private disclosureCodes = new Set<string>();

  public constructor(private readonly options: TurnDraftHostOptions) {
    if (options.inputMessageIds.length < 1 || options.inputMessageIds.length > 8) throw new Error("INVALID_CURRENT_MESSAGE_BATCH");
    if (options.inputMessageContents && options.inputMessageContents.length !== options.inputMessageIds.length) throw new Error("CURRENT_MESSAGE_BATCH_MISMATCH");
    this.publicationRevision = options.baseState.revision + 1;
    this.baseGoalRevision = structuredClone(options.baseState.goalRevision);
    this.state = { ...structuredClone(options.baseState), revision: this.publicationRevision };
    if (this.state.dialogue.pendingClarification?.slotId === "turn_rephrase") {
      this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_CLEAR_CLARIFICATION", slotId: "turn_rephrase" }]);
    }
  }

  public async commitPlan(proposal: TurnPlanProposal): Promise<CommittedTurnPlan> {
    if (this.plan) throw new DomainError("TURN_PLAN_ALREADY_COMMITTED", "A Turn may commit only one plan");
    const supportedProposal = sanitizeGoalProposal(proposal, this.options.inputMessageContents);
    const stablePlan = stabilizePlanReferents(bindPlan(supportedProposal, this.options.inputMessageIds), this.options.baseState.workingSet);
    const proposedPlan = constrainOrdinalRejections(stablePlan, this.options.baseState.workingSet, this.options.inputMessageContents);
    if (this.options.requiredFocusOfferRef) {
      const focusesRequiredOffer = proposedPlan.ops.some((operation) => operation.kind === "SET_FOCUS"
        && operation.referent?.kind === "OFFER_REF"
        && operation.referent.offerRef === this.options.requiredFocusOfferRef);
      if (!focusesRequiredOffer) throw new DomainError("UI_FOCUS_NOT_PLANNED", this.options.requiredFocusOfferRef);
    }
    const policy = evaluateConversationPolicy({ plan: proposedPlan, state: this.options.baseState, researchNeed: this.options.researchNeed });
    const plan = policy.plan;
    this.plan = plan;
    this.state.dialogue.pendingOps = structuredClone(plan.leftover);
    await this.options.onPlanCommitted?.(plan);
    await this.stage();
    return { plan, route: policy.route, maxModelInferences: policy.route === "research" ? 4 : 2 };
  }

  public async executeOperation(operation: TurnOperation, signal?: AbortSignal): Promise<OperationReceipt> {
    if (!this.plan) throw new DomainError("TURN_PLAN_REQUIRED", "TurnPlan must be committed before execution");
    if (this.receipts.some((receipt) => receipt.opId === operation.opId)) throw new DomainError("TURN_OPERATION_ALREADY_EXECUTED", `Operation already executed: ${operation.opId}`);
    let result = emptyWorldResult();
    let status: OperationReceipt["status"] = "APPLIED";
    const questionSlotIds: string[] = [];
    try {
      if (isGoalOperation(operation)) {
        this.goalOperations.push(operation);
        this.state.goalRevision = createGoalRevision(this.baseGoalRevision, this.goalOperations, this.options.turnId, this.publicationRevision);
        this.applyGoalImpact(operation);
        if (this.state.dialogue.pendingClarification?.slotId.startsWith("referent:")) {
          this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{
            kind: "DIALOGUE_CLEAR_CLARIFICATION",
            slotId: this.state.dialogue.pendingClarification.slotId,
          }]);
        }
        if (operation.kind === "GOAL_RESOLVE_GAP") {
          this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_CLEAR_CLARIFICATION", slotId: operation.slotId }]);
        }
        result = emptyWorldResult({ goalVersion: this.state.goalRevision.version, operation: operation.kind });
      } else {
        result = await this.executeWorldOperation(operation, signal);
        if (operation.kind === "REQUEST_CLARIFICATION") questionSlotIds.push(operation.slotId);
      }
    } catch (error) {
      if (error instanceof DomainError && ["CANDIDATE_REFERENT_NOT_FOUND", "CANDIDATE_REFERENT_AMBIGUOUS", "WORKING_SET_REQUIRED"].includes(error.code)) {
        status = "BLOCKED";
        const slotId = `referent:${operation.opId}`;
        questionSlotIds.push(slotId);
        this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_REQUEST_CLARIFICATION", slotId, askedByMessageId: this.options.turnId }]);
        result = emptyWorldResult({ blockedReasonCode: error.code });
      } else {
        throw error;
      }
    }
    for (const claim of result.claims) {
      if (this.claims.has(claim.claimId)) throw new DomainError("DUPLICATE_CLAIM_ID", `Duplicate claim from world operation: ${claim.claimId}`);
      this.claims.set(claim.claimId, claim);
      for (const evidence of claim.evidenceRefs) this.evidenceKeys.add(claimEvidenceKey(evidence));
    }
    for (const slotId of questionSlotIds) this.questionSlotIds.add(slotId);
    for (const code of result.disclosureCodes) this.disclosureCodes.add(code);
    const receipt: OperationReceipt = {
      opId: operation.opId,
      toolName: toolNameForOperation(operation),
      status,
      claimIds: result.claims.map((claim) => claim.claimId),
      questionSlotIds,
      disclosureCodes: result.disclosureCodes,
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

  private async executeWorldOperation(operation: WorldOperation, signal?: AbortSignal): Promise<WorldOperationResult> {
    switch (operation.kind) {
      case "REJECT_OFFERS": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(rejectWorkingSetOffers(set, refs));
        return emptyWorldResult({ offerRefs: refs });
      }
      case "RESTORE_OFFERS": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(restoreWorkingSetOffers(set, refs));
        return emptyWorldResult({ offerRefs: refs });
      }
      case "SET_COMPARISON": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(setWorkingSetComparison(set, refs));
        return emptyWorldResult({ offerRefs: refs });
      }
      case "SET_FOCUS": {
        const set = this.requireWorkingSet();
        const refs = operation.referent === null ? [] : resolveReferents(set, [operation.referent]);
        if (refs.length > 1) throw new DomainError("FOCUS_REQUIRES_ONE_OFFER", `Focus resolved to multiple offers: ${refs.join(",")}`);
        this.publishWorkingSet(setWorkingSetFocus(set, refs[0] ?? null));
        return emptyWorldResult({ offerRef: refs[0] ?? null });
      }
      case "INSPECT_WORKING_SET": {
        const set = this.requireWorkingSet();
        const refs = resolveReferents(set, operation.referents);
        this.publishWorkingSet(markWorkingSetMentioned(set, refs));
        return this.options.world.inspect(operation, refs, structuredClone(this.state), signal);
      }
      case "REFILTER_WORKING_SET": {
        const set = this.requireWorkingSet();
        const configured = this.state.goalRevision?.goal.retrievalMarkets ?? [];
        const markets = configured.length > 0 ? configured : [...new Set(set.pool.map((candidate) => candidate.retrievalMarket))];
        this.publishWorkingSet(refilterWorkingSetByMarkets(set, markets));
        return emptyWorldResult({ displayOfferRefs: this.state.workingSet!.displayOfferRefs });
      }
      case "RERANK_WORKING_SET": {
        const set = this.requireWorkingSet();
        if (operation.preferenceKey.toLocaleLowerCase().includes("price")) {
          this.publishWorkingSet(rerankWorkingSetByPrice(set));
        } else {
          const goal = this.state.goalRevision?.goal;
          if (!goal?.preferences.some((preference) => preference.key === operation.preferenceKey)) {
            throw new DomainError("UNSUPPORTED_RERANK_POLICY", `Preference is not present in the current Goal: ${operation.preferenceKey}`);
          }
          this.publishWorkingSet(reprojectWorkingSetForGoal(set, goal));
        }
        return emptyWorldResult({ displayOfferRefs: this.state.workingSet!.displayOfferRefs });
      }
      case "RESEARCH_OFFERS": {
        const researched = await this.options.world.research(operation, structuredClone(this.state), signal);
        this.publishWorkingSet(researched.workingSet);
        return researched.result;
      }
      case "REQUEST_CLARIFICATION":
        this.questionSlotIds.add(operation.slotId);
        this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_REQUEST_CLARIFICATION", slotId: operation.slotId, askedByMessageId: this.options.turnId }]);
        return emptyWorldResult({ slotId: operation.slotId, reasonCode: operation.reasonCode });
      case "UNDO_REVISION": {
        const target = await this.options.loadRevision(operation.revision);
        if (!target) throw new DomainError("UNDO_TARGET_NOT_FOUND", `Conversation revision not found: ${operation.revision}`);
        this.state = { ...structuredClone(target), revision: this.publicationRevision, status: this.options.baseState.status };
        return emptyWorldResult({ restoredRevision: operation.revision });
      }
    }
  }

  public async publishReply(proposal: AssistantEnvelopeProposal): Promise<AssistantEnvelope> {
    if (!this.plan) throw new DomainError("TURN_PLAN_REQUIRED", "TurnPlan must be committed before reply publication");
    const hasResearch = this.plan.ops.some((operation) => operation.kind === "RESEARCH_OFFERS");
    const hasClarification = this.plan.ops.some((operation) => operation.kind === "REQUEST_CLARIFICATION");
    const materializedBlocks: AssistantEnvelope["blocks"] = proposal.blocks.map((block) => {
      if (block.type === "QUESTION") return { ...block, wording: clarificationWording(block.slotId) };
      if (block.type === "TRANSITION") return { type: "TRANSITION", text: transitionText(block.transitionCode) };
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
    if (safeBlocks.length === 0) {
      safeBlocks.push({
        type: "TRANSITION",
        text: hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
          ? "当前没有形成可验证的候选。"
          : "我已更新当前选购状态。",
      });
    }
    const outcome = hasClarification
      ? "CLARIFICATION"
      : hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? "NO_MATCH"
        : hasResearch && (this.state.workingSet?.pool.length ?? 0) > 0
          && this.state.workingSet!.pool.every((candidate) => candidate.discovery?.supportLevel === "DISCOVERY")
          ? "DISCOVERY"
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
    const claimLedger = this.claimLedgerForEnvelope(envelope);
    validateAssistantEnvelope(envelope, {
      plan: this.plan,
      claimLedger,
      allowedOfferRefs: new Set(this.state.workingSet?.pool.map((candidate) => candidate.offerRef) ?? []),
      allowedQuestionSlotIds: this.questionSlotIds,
      allowedDisclosureCodes: this.disclosureCodes,
    });
    if (claimLedger.claims.length > 0) {
      if (!this.state.workingSet) throw new DomainError("CLAIM_WORKING_SET_REQUIRED", "Claims require a working set");
      verifyClaimLedger(claimLedger, {
        workingSet: this.state.workingSet,
        allowedEvidenceRefs: this.evidenceKeys,
        envelope,
        renderedDraft: renderAssistantEnvelope(envelope, claimLedger),
      });
    }
    const renderedText = renderAssistantEnvelope(envelope, claimLedger);
    await this.options.onReplyValidated?.({
      state: structuredClone(this.state),
      plan: structuredClone(this.plan),
      envelope: structuredClone(envelope),
      claimLedger,
      evidenceKeys: [...this.evidenceKeys],
      allowedQuestionSlotIds: [...this.questionSlotIds],
      allowedDisclosureCodes: [...this.disclosureCodes],
      renderedText,
    });
    return structuredClone(envelope);
  }

  public async fallbackReply(errorCode: string, plan: TurnPlan | null, receipts: OperationReceipt[] = []): Promise<AssistantEnvelope> {
    let executedFallbackPlan = false;
    const blockedQuestionSlotId = [...receipts].reverse().flatMap((receipt) => receipt.questionSlotIds)[0] ?? null;
    if (!plan) {
      plan = validateTurnPlan({
        userIntentSummary: "request a safe rephrase after protocol failure",
        ops: [
          ...(this.options.requiredFocusOfferRef ? [{
            opId: "fallback-ui-focus",
            kind: "SET_FOCUS" as const,
            referent: { kind: "OFFER_REF" as const, offerRef: this.options.requiredFocusOfferRef },
          }] : []),
          { opId: "fallback-clarification", kind: "REQUEST_CLARIFICATION", slotId: "turn_rephrase", reasonCode: "MODEL_PROTOCOL_FAILED" },
        ],
        leftover: [],
      });
      this.plan = plan;
      await this.options.onPlanCommitted?.(plan);
      for (const operation of plan.ops) await this.executeOperation(operation);
      executedFallbackPlan = true;
    }
    if (!executedFallbackPlan && !blockedQuestionSlotId) {
      this.questionSlotIds.add("turn_rephrase");
      this.state.dialogue = applyDialogueOperations(this.state.dialogue, [{ kind: "DIALOGUE_REQUEST_CLARIFICATION", slotId: "turn_rephrase", askedByMessageId: this.options.turnId }]);
      await this.stage();
    }
    const envelope: AssistantEnvelope = blockedQuestionSlotId ? {
      outcome: "CLARIFICATION",
      addressedOpIds: plan.ops.map((operation) => operation.opId),
      blocks: [{ type: "QUESTION", slotId: blockedQuestionSlotId, wording: clarificationWording(blockedQuestionSlotId) }],
      nextMoves: [],
    } : {
      outcome: "DEGRADED",
      addressedOpIds: plan.ops.map((operation) => operation.opId),
      blocks: [
        { type: "TRANSITION", text: "这轮没有安全完成。" },
        { type: "QUESTION", slotId: "turn_rephrase", wording: "请换一种说法告诉我你想继续调整、比较或了解什么。" },
      ],
      nextMoves: [],
    };
    if (!blockedQuestionSlotId) this.questionSlotIds.add("turn_rephrase");
    const fallbackLedger = this.claimLedgerForEnvelope(envelope);
    const renderedText = renderAssistantEnvelope(envelope, fallbackLedger);
    await this.options.onReplyValidated?.({
      state: structuredClone(this.state),
      plan: structuredClone(plan),
      envelope: structuredClone(envelope),
      claimLedger: fallbackLedger,
      evidenceKeys: [...this.evidenceKeys],
      allowedQuestionSlotIds: [...this.questionSlotIds],
      allowedDisclosureCodes: [...this.disclosureCodes],
      renderedText,
      fallbackReasonCode: errorCode,
    });
    return envelope;
  }

  private claimLedger(): ClaimLedger {
    return { claims: [...this.claims.values()].map((claim) => structuredClone(claim)) };
  }

  private claimLedgerForEnvelope(envelope: AssistantEnvelope): ClaimLedger {
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
      claimLedger: this.claimLedger(),
      evidenceKeys: [...this.evidenceKeys],
      receipts: structuredClone(this.receipts),
    });
  }
}
