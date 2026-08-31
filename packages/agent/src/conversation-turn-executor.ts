import {
  DomainError,
  canonicalModels,
  canonicalProductModel,
  inferCategoryValidationPolicies,
  inferCategoryValidationPolicy,
  resolveCategoryValidationPolicy,
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
  validateTurnPlan,
  validateWorkingSet,
  validateGroundedClaimSet,
  evaluateAnswerability,
  disclosureIndicatesIncompleteSearchCoverage,
  claimEvidenceKey,
  clarificationKey,
  clarificationRationale,
  clarificationResponseSpec,
  clarificationWording,
  legacyClarificationSlotId,
  normalizeClarificationIntent,
  normalizeDialogueState,
  type AssistantEnvelope,
  type AnswerabilityDecision,
  type ValidatedClarificationAnswer,
  type ClarificationIntent,
  type GroundedClaimSet,
  type ConversationState,
  type GoalOperation,
  type SearchNeed,
  type ShoppingGoal,
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
  type ProposedTurnOperation,
  type TurnExecutionController,
  type TurnPlanProposal,
  type TransitionCode,
} from "./protocol.js";
import { normalizeTurnPlanProposal } from "./plan-normalizer.js";

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
  const { sourceMessageOrdinal: _sourceMessageOrdinal, sourceSpan: _sourceSpan, ...turnAction } = operation;
  return structuredClone(turnAction) as TurnOperation;
}

function bindPlan(proposal: TurnPlanProposal, messageIds: string[]): TurnPlan {
  return validateTurnPlan({
    userIntentSummary: proposal.userIntentSummary,
    ops: proposal.ops.map((operation) => bindOperation(operation, messageIds)),
    leftover: proposal.leftover.map((pending) => ({ conditionCode: pending.conditionCode, operation: bindOperation(pending.operation, messageIds) })),
  });
}

function normalizeProposalClarifications(proposal: TurnPlanProposal): TurnPlanProposal {
  const normalize = (operation: ProposedTurnOperation): ProposedTurnOperation => {
    if (operation.kind !== "REQUEST_CLARIFICATION") return operation;
    const legacy = operation as unknown as Record<string, unknown>;
    const clarification = normalizeClarificationIntent(legacy["clarification"] ?? legacy["slotId"]);
    const { slotId: _legacySlotId, clarification: _clarification, ...rest } = legacy;
    return { ...rest, kind: "REQUEST_CLARIFICATION", clarification } as ProposedTurnOperation;
  };
  return {
    ...proposal,
    ops: proposal.ops.map(normalize),
    leftover: proposal.leftover.map((item) => ({ ...item, operation: normalize(item.operation) })),
  };
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

function explicitlyLeavesProductTargetOpen(text: string): boolean {
  return /(?:还没|尚未|没有|没)(?:说|决定|确定|想好).{0,12}(?:买|要买|找)?(?:什么|具体(?:买|商品|产品|品类|型号)?|目标)|(?:不知道|不确定|未确定).{0,10}(?:买|找|选)(?:什么|哪类)|\b(?:haven't|have not|not yet)\s+(?:said|decided|chosen).{0,24}(?:what|product|category)\b|\b(?:i\s+)?(?:(?:do\s+not|don't)\s+know|(?:am\s+)?not\s+sure)\s+(?:what|which)\b/iu.test(text);
}

function explicitlyOmitsBudget(text: string): boolean {
  return /(?:不设|没有|无需|不限|无)预算|预算(?:不限|不设|无所谓)|no\s+budget|without\s+(?:a\s+)?budget|unlimited\s+budget/iu.test(text);
}

function statedBudgetAmount(text: string): string | null {
  const arabic = text.match(/(?:预算(?:是|为|改为|改成)?|最高|最多|上限|不超过|不高于|\bbudget(?:\s+(?:is|of|to))?)[^\d]{0,12}(\d[\d,]*(?:\.\d+)?)/iu)?.[1];
  if (arabic) return arabic.replace(/,/g, "");
  const chinese = text.match(/(?:预算(?:是|为|改为|改成)?|最高|最多|上限|不超过|不高于)[^零〇一二两三四五六七八九十百千万]{0,12}([零〇一二两三四五六七八九十百千万]+)/u)?.[1];
  if (!chinese) return null;
  const digits = new Map<string, number>([["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9]]);
  const units = new Map<string, number>([["十", 10], ["百", 100], ["千", 1_000]]);
  let total = 0;
  let section = 0;
  let number = 0;
  for (const token of chinese) {
    if (digits.has(token)) {
      number = digits.get(token)!;
    } else if (token === "万") {
      section += number;
      total += (section || 1) * 10_000;
      section = 0;
      number = 0;
    } else {
      const unit = units.get(token);
      if (!unit) return null;
      section += (number || 1) * unit;
      number = 0;
    }
  }
  const amount = total + section + number;
  return amount > 0 ? String(amount) : null;
}

function planAddressesPendingClarification(plan: TurnPlanProposal, kind: string): boolean {
  if (kind === "TARGET_PRODUCT" || kind === "TARGET_MODEL") return plan.ops.some((operation) => operation.kind === "GOAL_SET_TARGET");
  if (kind === "BUDGET") return plan.ops.some((operation) => operation.kind === "GOAL_SET_BUDGET" || operation.kind === "GOAL_CLEAR_BUDGET");
  if (kind === "PURCHASE_MARKET") return plan.ops.some((operation) => operation.kind === "GOAL_SET_RETRIEVAL_MARKETS");
  if (kind === "DELIVERY_DESTINATION") return plan.ops.some((operation) => operation.kind === "GOAL_SET_DELIVERY_DESTINATION");
  return false;
}

function latestBudgetDirective(contents: string[]): { ordinal: number; text: string; amount: string | null; omitted: boolean } | null {
  for (let ordinal = contents.length - 1; ordinal >= 0; ordinal -= 1) {
    const text = contents[ordinal]!;
    const omitted = explicitlyOmitsBudget(text);
    const amount = statedBudgetAmount(text);
    if (omitted || amount) return { ordinal, text, amount, omitted };
  }
  return null;
}

function explicitRegisteredShoppingTarget(contents: string[]): { ordinal: number; categoryId: string } | null {
  const shoppingPhrase = /(?:想(?:买|找)|要买|购买|选购|找|需要|looking\s+for|search(?:ing)?\s+for|want(?:\s+to)?\s+(?:buy|get)|shop(?:ping)?\s+for)[^,，。；;!?]{0,100}/giu;
  for (let ordinal = contents.length - 1; ordinal >= 0; ordinal -= 1) {
    const text = contents[ordinal]!;
    if (explicitlyLeavesProductTargetOpen(text)) continue;
    const categories = new Set<string>();
    for (const match of text.matchAll(shoppingPhrase)) {
      const prefix = text.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
      if (/(?:不|别|不要|无需|don't|do\s+not|not)\s*$/iu.test(prefix)) continue;
      for (const policy of inferCategoryValidationPolicies(match[0])) categories.add(policy.categoryId);
    }
    if (categories.size === 1) return { ordinal, categoryId: [...categories][0]! };
  }
  return null;
}

function sanitizeGoalProposal(
  proposal: TurnPlanProposal,
  contents: string[] | undefined,
  existingGoal: ShoppingGoal | null,
  clarificationAnswer?: ValidatedClarificationAnswer,
): TurnPlanProposal {
  if (!contents) return proposal;
  const requestsResultCount = contents.some((content) => /(?:给我|列出?|展示|显示).{0,8}(?:\d+|[一二两三四五六七八九十])\s*条/iu.test(content));
  const budgetDirective = latestBudgetDirective(contents);
  const omitsExplicitBudget = budgetDirective?.omitted ?? false;
  const supportedMarket = (market: string, text: string) => {
    const upper = market.toUpperCase();
    if (upper === "US") return /美国|美区|\bUS\b|United States/iu.test(text);
    if (upper === "SG") return /新加坡|新加坡区|\bSG\b|Singapore/iu.test(text);
    return compactText(text).includes(compactText(market));
  };
  const canonicalMarket = (market: string): string => {
    if (/^(?:US|USA|UNITED STATES|美国|美区)$/iu.test(market.trim())) return "US";
    if (/^(?:SG|SGP|SINGAPORE|新加坡|新加坡区)$/iu.test(market.trim())) return "SG";
    return market.trim().toUpperCase();
  };
  const proposedTarget = proposal.ops.find((operation) => operation.kind === "GOAL_SET_TARGET");
  const activeTarget = proposedTarget?.kind === "GOAL_SET_TARGET" ? proposedTarget.target : existingGoal?.target;
  const isContextualTargetAnswer = (operation: ProposedTurnOperation, text: string): boolean => {
    if (operation.kind !== "GOAL_SET_TARGET" || !clarificationAnswer || clarificationAnswer.answer.type === "SKIP") return false;
    if (clarificationAnswer.clarification.kind !== "TARGET_PRODUCT" && clarificationAnswer.clarification.kind !== "TARGET_MODEL") return false;
    const answerText = clarificationAnswer.answerText?.trim() ?? "";
    if (!answerText || explicitlyLeavesProductTargetOpen(answerText)) return false;
    const compactAnswer = compactText(answerText);
    const compactSource = compactText(text);
    return Boolean(compactAnswer) && (compactSource.includes(compactAnswer) || compactAnswer.includes(compactSource));
  };
  const sanitize = (operation: ProposedTurnOperation): ProposedTurnOperation | null => {
    if (operation.kind === "GOAL_EXCLUDE_ENTITY" && operation.entity.kind === "OFFER") {
      return {
        opId: operation.opId,
        kind: "REJECT_OFFERS",
        referents: [{ kind: "OFFER_REF", offerRef: operation.entity.value }],
        reasonCode: "USER_REJECTED",
      };
    }
    if (operation.kind === "GOAL_RESTORE_ENTITY" && operation.entity.kind === "OFFER") {
      return {
        opId: operation.opId,
        kind: "RESTORE_OFFERS",
        referents: [{ kind: "OFFER_REF", offerRef: operation.entity.value }],
      };
    }
    if (!operation.kind.startsWith("GOAL_")) {
      if (operation.kind === "REQUEST_CLARIFICATION" && omitsExplicitBudget && operation.clarification.kind === "BUDGET") return null;
      if (operation.kind === "REQUEST_CLARIFICATION" && requestsResultCount && operation.clarification.kind === "QUANTITY") return null;
      return operation;
    }
    const text = sourceText(operation, contents);
    if (operation.kind === "GOAL_ADD_GAP" && requestsResultCount && /quantity|数量|件数/iu.test(operation.gap.slotId)) return null;
    if (operation.kind === "GOAL_SET_BUDGET") {
      if (omitsExplicitBudget) return null;
      const requested = operation.budget.amount.replace(/,/g, "").replace(/\.0+$/, "");
      if (!requested || !operation.budget.currency.trim()) return null;
      const latestStatedBudget = budgetDirective?.amount ?? null;
      if (latestStatedBudget && latestStatedBudget.replace(/\.0+$/, "") !== requested) return null;
      const containsRequestedAmount = (value: string) => [...value.matchAll(/\d[\d,]*(?:\.\d+)?/gu)]
        .some((match) => match[0]!.replace(/,/g, "").replace(/\.0+$/, "") === requested);
      let groundedSourceMessageOrdinal = operation.sourceMessageOrdinal;
      let groundedText = text;
      if (!containsRequestedAmount(groundedText)) {
        const supportingOrdinal = [...contents.keys()].reverse().find((index) => containsRequestedAmount(contents[index]!));
        if (supportingOrdinal === undefined) return null;
        groundedSourceMessageOrdinal = supportingOrdinal;
        groundedText = contents[supportingOrdinal]!;
      }
      const amounts = [...groundedText.matchAll(/\d[\d,]*(?:\.\d+)?/gu)].map((match) => match[0]!.replace(/,/g, "").replace(/\.0+$/, ""));
      if (!amounts.includes(requested)) return null;
      const currency = /美元|\bUSD\b|US\$/iu.test(text)
        ? "USD"
        : /新加坡元|新币|\bSGD\b|S\$/iu.test(text)
          ? "SGD"
          : /人民币|\bCNY\b|\bRMB\b|元/iu.test(text)
            ? "CNY"
            : operation.budget.currency;
      return {
        ...operation,
        sourceMessageOrdinal: groundedSourceMessageOrdinal,
        ...(groundedSourceMessageOrdinal !== operation.sourceMessageOrdinal ? { sourceSpan: undefined } : {}),
        budget: { ...operation.budget, currency },
      };
    }
    if (operation.kind === "GOAL_SET_RETRIEVAL_MARKETS") {
      let groundedSourceMessageOrdinal = operation.sourceMessageOrdinal;
      let groundedText = text;
      if (!operation.markets.some((market) => supportedMarket(market, groundedText))) {
        const supportingOrdinal = [...contents.keys()].reverse()
          .find((index) => operation.markets.some((market) => supportedMarket(market, contents[index]!)));
        if (supportingOrdinal === undefined) return null;
        groundedSourceMessageOrdinal = supportingOrdinal;
        groundedText = contents[supportingOrdinal]!;
      }
      const markets = [...new Set(operation.markets
        .filter((market) => supportedMarket(market, groundedText))
        .map(canonicalMarket))];
      return markets.length > 0 ? {
        ...operation,
        sourceMessageOrdinal: groundedSourceMessageOrdinal,
        ...(groundedSourceMessageOrdinal !== operation.sourceMessageOrdinal ? { sourceSpan: undefined } : {}),
        markets,
      } : null;
    }
    if (operation.kind === "GOAL_SET_TARGET") {
      let groundedText = contents[operation.sourceMessageOrdinal] ?? text;
      let groundedSourceMessageOrdinal = operation.sourceMessageOrdinal;
      const contextualTargetAnswer = isContextualTargetAnswer(operation, groundedText);
      if (operation.target.canonicalModel && !compactText(text).includes(compactText(operation.target.canonicalModel))) {
        for (let index = contents.length - 1; index >= 0; index -= 1) {
          const candidateText = contents[index]!;
          const supportsProposedModel = canonicalModels(candidateText, operation.target.categoryId)
            .some((model) => compactText(model) === compactText(operation.target.canonicalModel!));
          if (!supportsProposedModel) continue;
          groundedText = candidateText;
          groundedSourceMessageOrdinal = index;
          break;
        }
      }
      const registeredCategory = resolveCategoryValidationPolicy(operation.target.categoryId);
      if (!registeredCategory && explicitlyLeavesProductTargetOpen(groundedText)) return null;
      const explicitTargetText = operation.target.targetText?.trim();
      // Open categories have no deterministic lexicon yet. If the model omits
      // targetText, retain the exact source message as the auditable retrieval
      // anchor instead of either dropping the product intent or trusting an
      // ungrounded model-authored translation.
      const proposedTargetText = explicitTargetText
        || (!registeredCategory ? groundedText.normalize("NFKC").trim().slice(0, 200) : "")
        || operation.target.categoryId;
      const categorySupported = registeredCategory
        ? inferCategoryValidationPolicy(groundedText)?.categoryId === registeredCategory.categoryId
        : contextualTargetAnswer || (Boolean(groundedText.trim()) && compactText(groundedText).includes(compactText(proposedTargetText)));
      if (!categorySupported) return null;
      const conditionSupported = operation.target.condition === "ANY"
        || (operation.target.condition === "NEW" && /新机|全新|brand[\s-]?new|\bnew\b/iu.test(groundedText))
        || (operation.target.condition === "REFURBISHED" && /翻新|refurbished|renewed/iu.test(groundedText))
        || (operation.target.condition === "USED" && /二手|pre[\s-]?owned|\bused\b/iu.test(groundedText));
      const modelSupported = operation.target.canonicalModel === null
        || compactText(groundedText).includes(compactText(operation.target.canonicalModel));
      const groundedModels = canonicalModels(groundedText, operation.target.categoryId);
      const isCorrection = /(?:说错|不是.{0,40}(?:是|要)|改成|换成)|\b(?:correction|switch\s+to|change\s+to)\b/iu.test(groundedText);
      const explicitModel = isCorrection && groundedModels.length > 1
        ? groundedModels.at(-1) ?? null
        : canonicalProductModel(groundedText, operation.target.categoryId);
      return {
        ...operation,
        sourceMessageOrdinal: groundedSourceMessageOrdinal,
        ...(groundedText !== text || groundedSourceMessageOrdinal !== operation.sourceMessageOrdinal ? { sourceSpan: undefined } : {}),
        target: {
          ...operation.target,
          ...(!registeredCategory ? { targetText: proposedTargetText } : {}),
          condition: conditionSupported ? operation.target.condition : "ANY",
          canonicalModel: explicitModel ?? (modelSupported ? operation.target.canonicalModel : null),
        },
      };
    }
    if (operation.kind === "GOAL_UPSERT_CONSTRAINT") {
      if (/(?:storage|capacity)/iu.test(operation.constraint.key)) {
        const targetAlreadyCarriesCapacity = /\b\d+\s*(?:GB|TB)\b/iu.test(activeTarget?.canonicalModel ?? "");
        return canonicalProductModel(text, "smartphone") || targetAlreadyCarriesCapacity ? null : operation;
      }
      // Product identity was resolved using category-specific matching rules. A
      // A second generic brand/model constraint has no category-specific validation rule.
      // and would incorrectly disqualify otherwise matching offers.
      if (/(?:^|_)(?:brand|manufacturer|model)(?:_|$)/iu.test(operation.constraint.key)
        && resolveCategoryValidationPolicy(activeTarget?.categoryId ?? "")
        && activeTarget?.canonicalModel) return null;
    }
    return operation;
  };
  let ops = proposal.ops.flatMap((operation) => {
    const value = sanitize(operation);
    return value ? [value] : [];
  });
  const targetOperation = ops.find((operation) => operation.kind === "GOAL_SET_TARGET");
  const effectiveTarget = targetOperation?.kind === "GOAL_SET_TARGET" ? targetOperation.target : existingGoal?.target;
  if (effectiveTarget?.canonicalModel && resolveCategoryValidationPolicy(effectiveTarget.categoryId)) {
    const targetCarriesCapacity = /\b\d+\s*(?:GB|TB)\b/iu.test(effectiveTarget.canonicalModel);
    ops = ops.filter((operation) => operation.kind !== "GOAL_UPSERT_CONSTRAINT"
      || !(/(?:^|_)(?:brand|manufacturer|model)(?:_|$)/iu.test(operation.constraint.key)
        || (targetCarriesCapacity && /(?:storage|capacity)/iu.test(operation.constraint.key))));
  }
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

function normalizeUndoRevision(plan: TurnPlan, currentRevision: number, contents: string[] | undefined): TurnPlan {
  const explicitlyRequestsUndo = contents?.some((content) => /撤销|回到上一次|恢复上一次|undo/iu.test(content)) ?? false;
  if (!explicitlyRequestsUndo || currentRevision < 1) return plan;
  const ops = plan.ops.map((operation) => operation.kind === "UNDO_REVISION" && operation.revision >= currentRevision
    ? { ...operation, revision: currentRevision - 1 }
    : operation);
  return validateTurnPlan({ ...plan, ops });
}

function stabilizePlanReferents(plan: TurnPlan, workingSet: WorkingSet | null): TurnPlan {
  if (!workingSet) return plan;
  const planned = {
    focusOfferRef: workingSet.focusOfferRef,
    comparisonOfferRefs: [...workingSet.comparisonOfferRefs],
  };
  let plannedDisplayOfferRefs = [...workingSet.displayOfferRefs];
  let restoredOfferRefs: string[] = [];
  const ops = plan.ops.map((operation): TurnOperation => {
    switch (operation.kind) {
      case "REJECT_OFFERS": {
        if (plannedDisplayOfferRefs.length === 0) return operation;
        const referents = operation.referents.flatMap((referent) => referent.kind === "TEXT" && /(?:current\s+)?last|最后/iu.test(referent.text)
          ? plannedDisplayOfferRefs.at(-1) ? [{ kind: "OFFER_REF" as const, offerRef: plannedDisplayOfferRefs.at(-1)! }] : []
          : stableOfferReferents(workingSet, [referent], planned));
        const rejected = new Set(referents.map((referent) => referent.offerRef));
        plannedDisplayOfferRefs = plannedDisplayOfferRefs.filter((offerRef) => !rejected.has(offerRef));
        return { ...operation, referents };
      }
      case "INSPECT_WORKING_SET": {
        if (plannedDisplayOfferRefs.length === 0 && restoredOfferRefs.length === 0) return operation;
        const referents = operation.referents.flatMap((referent) => referent.kind === "DISPLAY_RANK"
          && !workingSet.displayOfferRefs[referent.rank - 1]
          && restoredOfferRefs.length === 1
          ? [{ kind: "OFFER_REF" as const, offerRef: restoredOfferRefs[0]! }]
          : stableOfferReferents(workingSet, [referent], planned));
        return { ...operation, referents };
      }
      case "RESTORE_OFFERS": {
        restoredOfferRefs = workingSet.rejectedOfferRefs.length === 1
          ? [workingSet.rejectedOfferRefs[0]!]
          : operation.referents.flatMap((referent) => referent.kind === "DISPLAY_RANK" && workingSet.rejectedOfferRefs[referent.rank - 1]
            ? [workingSet.rejectedOfferRefs[referent.rank - 1]!]
            : stableOfferReferents(workingSet, [referent], planned).map((resolved) => resolved.offerRef));
        return {
          ...operation,
          referents: restoredOfferRefs.map((offerRef) => ({ kind: "OFFER_REF", offerRef })),
        };
      }
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
  if (contents.some((content) => /(?:然后|再|接着).{0,12}(?:现在)?最后一条.{0,8}(?:排除|不要)|(?:排除|不要).{0,12}(?:然后|再|接着).{0,12}(?:现在)?最后一条/iu.test(content))) {
    const afterExplicitRanks = workingSet.displayOfferRefs.filter((_, index) => !ranks.includes(index + 1));
    if (afterExplicitRanks.at(-1)) allowed.add(afterExplicitRanks.at(-1)!);
  }
  const ops = plan.ops.flatMap((operation): TurnOperation[] => {
    if (operation.kind !== "REJECT_OFFERS") return [operation];
    const referents = operation.referents.filter((referent) => referent.kind === "OFFER_REF" && allowed.has(referent.offerRef));
    return referents.length > 0 ? [{ ...operation, referents }] : [];
  });
  return validateTurnPlan({ ...plan, ops });
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
    const answer = this.options.clarificationAnswer;
    const hostAugmentedProposal: TurnPlanProposal = answer
      ? {
        ...proposal,
        ops: [{
          opId: `host-resolve-clarification-${answer.clarificationId}`,
          kind: "RESOLVE_CLARIFICATION",
          clarificationId: answer.clarificationId,
          clarification: answer.clarification,
          outcome: answer.answer.type === "SKIP" ? "SKIPPED" : "ANSWERED",
        }, ...proposal.ops],
      }
      : proposal;
    const normalizedHostProposal = normalizeProposalClarifications(hostAugmentedProposal);
    const sanitizedHostProposal = sanitizeGoalProposal(
      normalizedHostProposal,
      this.options.inputMessageContents,
      this.options.baseState.goalRevision?.goal ?? null,
      this.options.clarificationAnswer,
    );
    const droppedTarget = normalizedHostProposal.ops.find((operation) => operation.kind === "GOAL_SET_TARGET"
      && !sanitizedHostProposal.ops.some((supported) => supported.kind === "GOAL_SET_TARGET" && supported.opId === operation.opId));
    const preflightViolations: RepairRequiredPlanReview["violations"] = [];
    if (droppedTarget?.kind === "GOAL_SET_TARGET") {
      preflightViolations.push({
        code: "UNSUPPORTED_GOAL_TARGET_SOURCE",
        operationId: droppedTarget.opId,
        path: `ops.${droppedTarget.opId}.target`,
        observed: droppedTarget.target,
        admissibleAlternatives: [
          "Use a targetText directly supported by the cited current user message; target-clarification answers may rely on the active question as semantic context.",
          "If the corrected target and existing market make the goal search-ready, include SEARCH_OFFERS in the repaired plan; repeat target clarification only when the answer still has competing meanings.",
        ],
      });
    }
    const budgetDirective = this.options.inputMessageContents
      ? latestBudgetDirective(this.options.inputMessageContents)
      : null;
    if (budgetDirective?.amount && !budgetDirective.omitted) {
      const normalizedAmount = budgetDirective.amount.replace(/\.0+$/, "");
      const plannedBudget = sanitizedHostProposal.ops.find((operation) => operation.kind === "GOAL_SET_BUDGET");
      const existingAmount = this.options.baseState.goalRevision?.goal.budget?.amount.replace(/,/g, "").replace(/\.0+$/, "") ?? null;
      const plannedAmount = plannedBudget?.kind === "GOAL_SET_BUDGET"
        ? plannedBudget.budget.amount.replace(/,/g, "").replace(/\.0+$/, "")
        : null;
      if (plannedAmount !== normalizedAmount && existingAmount !== normalizedAmount) {
        preflightViolations.push({
          code: "EXPLICIT_BUDGET_NOT_PLANNED",
          operationId: null,
          path: "ops",
          observed: { amount: normalizedAmount, sourceMessageOrdinal: budgetDirective.ordinal },
          admissibleAlternatives: [
            "Add GOAL_SET_BUDGET for the explicit amount using the cited current message; keep it in the same plan even when another field requires clarification.",
            "If the user explicitly removed the budget, omit GOAL_SET_BUDGET and do not request budget clarification.",
          ],
        });
      }
    }
    const explicitRegisteredTarget = this.options.inputMessageContents && !this.options.clarificationAnswer
      ? explicitRegisteredShoppingTarget(this.options.inputMessageContents)
      : null;
    if (explicitRegisteredTarget) {
      const plannedTarget = sanitizedHostProposal.ops.find((operation) => operation.kind === "GOAL_SET_TARGET");
      const existingTarget = this.options.baseState.goalRevision?.goal.target ?? null;
      const targetClarification = sanitizedHostProposal.ops.find((operation) => operation.kind === "REQUEST_CLARIFICATION"
        && operation.clarification.kind === "TARGET_PRODUCT");
      const targetAlreadyPlanned = plannedTarget?.kind === "GOAL_SET_TARGET"
        && plannedTarget.target.categoryId === explicitRegisteredTarget.categoryId;
      const targetAlreadyKnown = existingTarget?.categoryId === explicitRegisteredTarget.categoryId;
      if (targetClarification?.kind === "REQUEST_CLARIFICATION" && !targetAlreadyPlanned && !targetAlreadyKnown) {
        preflightViolations.push({
          code: "EXPLICIT_REGISTERED_TARGET_NOT_PLANNED",
          operationId: targetClarification.opId,
          path: `ops.${targetClarification.opId}`,
          observed: { categoryId: explicitRegisteredTarget.categoryId, sourceMessageOrdinal: explicitRegisteredTarget.ordinal },
          admissibleAlternatives: [
            "Add GOAL_SET_TARGET for the explicit registered product category and remove the redundant TARGET_PRODUCT clarification.",
            "Keep a target clarification only when the current message genuinely names multiple competing product categories or explicitly leaves the product undecided.",
          ],
        });
      }
    }
    const pendingClarification = this.options.baseState.dialogue.pendingClarification;
    if (pendingClarification && !answer && planAddressesPendingClarification(sanitizedHostProposal, pendingClarification.clarification.kind)) {
      const resolvesPending = sanitizedHostProposal.ops.some((operation) => operation.kind === "RESOLVE_CLARIFICATION"
        && operation.clarificationId === pendingClarification.clarificationId
        && operation.clarification.kind === pendingClarification.clarification.kind);
      if (!resolvesPending) {
        preflightViolations.push({
          code: "PENDING_CLARIFICATION_RESOLUTION_NOT_PLANNED",
          operationId: null,
          path: "ops",
          observed: {
            clarificationId: pendingClarification.clarificationId,
            clarificationKind: pendingClarification.clarification.kind,
          },
          admissibleAlternatives: [
            "Add RESOLVE_CLARIFICATION for the pending clarification before applying the answered goal field.",
            "If the message does not answer the pending question, do not apply that goal field and keep the clarification pending.",
          ],
        });
      }
    }
    if (preflightViolations.length > 0) {
      const reviewedProposal = normalizeTurnPlanProposal(normalizedHostProposal, this.options.baseState);
      const reviewedPlan = stabilizePlanReferents(bindPlan(reviewedProposal, this.options.inputMessageIds), this.options.baseState.workingSet);
      await this.rejectPlanProposal(proposal, reviewedPlan, {
        decision: "REPAIR_REQUIRED",
        policyVersion: CONVERSATION_PLAN_POLICY_VERSION,
        violations: preflightViolations,
      });
    }
    const supportedProposal = normalizeTurnPlanProposal(sanitizedHostProposal, this.options.baseState);
    const stablePlan = stabilizePlanReferents(bindPlan(supportedProposal, this.options.inputMessageIds), this.options.baseState.workingSet);
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
    let result = emptyActionResult();
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
