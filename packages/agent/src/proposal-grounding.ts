import {
  DomainError,
  canonicalModels,
  canonicalProductModel,
  inferCategoryValidationPolicies,
  inferCategoryValidationPolicy,
  normalizeClarificationIntent,
  resolveCategoryValidationPolicy,
  validateTurnPlan,
  type ConversationState,
  type RepairRequiredPlanReview,
  type ShoppingGoal,
  type TurnOperation,
  type TurnPlan,
  type ValidatedClarificationAnswer,
} from "@interec/domain";

import type { ProposedTurnOperation, TurnPlanProposal } from "./protocol.js";

export interface GroundTurnPlanProposalInput {
  proposal: TurnPlanProposal;
  inputMessageIds: string[];
  inputMessageContents: string[] | undefined;
  baseState: ConversationState;
  clarificationAnswer: ValidatedClarificationAnswer | undefined;
}

export interface GroundTurnPlanProposalResult {
  normalizedProposal: TurnPlanProposal;
  supportedProposal: TurnPlanProposal;
  preflightViolations: RepairRequiredPlanReview["violations"];
}

export function bindOperation(operation: ProposedTurnOperation, messageIds: string[]): TurnOperation {
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

export function bindPlan(proposal: TurnPlanProposal, messageIds: string[]): TurnPlan {
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

export function groundTurnPlanProposal(input: GroundTurnPlanProposalInput): GroundTurnPlanProposalResult {
  const answer = input.clarificationAnswer;
  const hostAugmentedProposal: TurnPlanProposal = answer
    ? {
      ...input.proposal,
      ops: [{
        opId: `host-resolve-clarification-${answer.clarificationId}`,
        kind: "RESOLVE_CLARIFICATION",
        clarificationId: answer.clarificationId,
        clarification: answer.clarification,
        outcome: answer.answer.type === "SKIP" ? "SKIPPED" : "ANSWERED",
      }, ...input.proposal.ops],
    }
    : input.proposal;
  const normalizedProposal = normalizeProposalClarifications(hostAugmentedProposal);
  const supportedProposal = sanitizeGoalProposal(
    normalizedProposal,
    input.inputMessageContents,
    input.baseState.goalRevision?.goal ?? null,
    answer,
  );
  const preflightViolations: RepairRequiredPlanReview["violations"] = [];
  const droppedTarget = normalizedProposal.ops.find((operation) => operation.kind === "GOAL_SET_TARGET"
    && !supportedProposal.ops.some((supported) => supported.kind === "GOAL_SET_TARGET" && supported.opId === operation.opId));
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
  const budgetDirective = input.inputMessageContents ? latestBudgetDirective(input.inputMessageContents) : null;
  if (budgetDirective?.amount && !budgetDirective.omitted) {
    const normalizedAmount = budgetDirective.amount.replace(/\.0+$/, "");
    const plannedBudget = supportedProposal.ops.find((operation) => operation.kind === "GOAL_SET_BUDGET");
    const existingAmount = input.baseState.goalRevision?.goal.budget?.amount.replace(/,/g, "").replace(/\.0+$/, "") ?? null;
    const plannedAmount = plannedBudget?.kind === "GOAL_SET_BUDGET" ? plannedBudget.budget.amount.replace(/,/g, "").replace(/\.0+$/, "") : null;
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
  const explicitRegisteredTarget = input.inputMessageContents && !answer ? explicitRegisteredShoppingTarget(input.inputMessageContents) : null;
  if (explicitRegisteredTarget) {
    const plannedTarget = supportedProposal.ops.find((operation) => operation.kind === "GOAL_SET_TARGET");
    const existingTarget = input.baseState.goalRevision?.goal.target ?? null;
    const targetClarification = supportedProposal.ops.find((operation) => operation.kind === "REQUEST_CLARIFICATION" && operation.clarification.kind === "TARGET_PRODUCT");
    const targetAlreadyPlanned = plannedTarget?.kind === "GOAL_SET_TARGET" && plannedTarget.target.categoryId === explicitRegisteredTarget.categoryId;
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
  const pendingClarification = input.baseState.dialogue.pendingClarification;
  if (pendingClarification && !answer && planAddressesPendingClarification(supportedProposal, pendingClarification.clarification.kind)) {
    const resolvesPending = supportedProposal.ops.some((operation) => operation.kind === "RESOLVE_CLARIFICATION"
      && operation.clarificationId === pendingClarification.clarificationId
      && operation.clarification.kind === pendingClarification.clarification.kind);
    if (!resolvesPending) {
      preflightViolations.push({
        code: "PENDING_CLARIFICATION_RESOLUTION_NOT_PLANNED",
        operationId: null,
        path: "ops",
        observed: { clarificationId: pendingClarification.clarificationId, clarificationKind: pendingClarification.clarification.kind },
        admissibleAlternatives: [
          "Add RESOLVE_CLARIFICATION for the pending clarification before applying the answered goal field.",
          "If the message does not answer the pending question, do not apply that goal field and keep the clarification pending.",
        ],
      });
    }
  }
  return { normalizedProposal, supportedProposal, preflightViolations };
}
