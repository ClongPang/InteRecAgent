import {
  DomainError,
  canonicalModels,
  canonicalProductModel,
  inferCategoryContract,
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
  type ShoppingGoal,
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
import { compileTurnIntent } from "./intent-compiler.js";

export interface WorldOperationResult {
  claims: VerifiedClaim[];
  disclosureCodes: string[];
  publicResult: Record<string, unknown>;
}

export interface TurnWorldPort {
  inspect(operation: Extract<WorldOperation, { kind: "INSPECT_WORKING_SET" }>, offerRefs: string[], state: ConversationState, signal?: AbortSignal): Promise<WorldOperationResult>;
  inspectResearchCoverage(operation: Extract<WorldOperation, { kind: "INSPECT_RESEARCH_COVERAGE" }>, state: ConversationState, signal?: AbortSignal): Promise<WorldOperationResult>;
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

function explicitlyLeavesProductTargetOpen(text: string): boolean {
  return /(?:还没|尚未|没有|没)(?:说|决定|确定|想好).{0,12}(?:买|要买|找)?(?:什么|具体(?:买|商品|产品|品类|型号)?|目标)|(?:不知道|不确定|未确定).{0,10}(?:买|找|选)(?:什么|哪类)|\b(?:haven't|have not|not yet)\s+(?:said|decided|chosen).{0,24}(?:what|product|category)\b/iu.test(text);
}

function sanitizeGoalProposal(
  proposal: TurnPlanProposal,
  contents: string[] | undefined,
  existingGoal: ShoppingGoal | null,
): TurnPlanProposal {
  if (!contents) return proposal;
  const requestsResultCount = contents.some((content) => /(?:给我|列出?|展示|显示).{0,8}(?:\d+|[一二两三四五六七八九十])\s*条/iu.test(content));
  const omitsBudget = (content: string) => /(?:不设|没有|无需|不限|无)预算|预算(?:不限|不设|无所谓)|no\s+budget|without\s+(?:a\s+)?budget|unlimited\s+budget/iu.test(content);
  const statedBudget = (content: string) => content.match(/(?:预算(?:是|为|改为|改成)?|最高|最多|上限|不超过|不高于)[^\d]{0,12}(\d[\d,]*(?:\.\d+)?)/u)?.[1]?.replace(/,/g, "") ?? null;
  const latestBudgetDirective = [...contents.entries()].reverse().find(([, content]) => omitsBudget(content) || statedBudget(content));
  const explicitlyOmitsBudget = latestBudgetDirective ? omitsBudget(latestBudgetDirective[1]) : false;
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
      if (operation.kind === "REQUEST_CLARIFICATION" && explicitlyOmitsBudget && /budget|预算/iu.test(operation.slotId)) return null;
      if (operation.kind === "REQUEST_CLARIFICATION" && requestsResultCount && /quantity|数量|件数/iu.test(operation.slotId)) return null;
      return operation;
    }
    const text = sourceText(operation, contents);
    if (operation.kind === "GOAL_ADD_GAP" && requestsResultCount && /quantity|数量|件数/iu.test(operation.gap.slotId)) return null;
    if (operation.kind === "GOAL_SET_BUDGET") {
      if (explicitlyOmitsBudget) return null;
      const requested = operation.budget.amount.replace(/,/g, "").replace(/\.0+$/, "");
      if (!requested || !operation.budget.currency.trim()) return null;
      const latestStatedBudget = latestBudgetDirective ? statedBudget(latestBudgetDirective[1]) : null;
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
      const registeredCategory = resolveCategoryContract(operation.target.categoryId);
      if (!registeredCategory && explicitlyLeavesProductTargetOpen(groundedText)) return null;
      const explicitTargetText = operation.target.targetText?.trim();
      // Open categories have no deterministic lexicon yet. If the model omits
      // targetText, retain the exact source message as the auditable retrieval
      // anchor instead of either dropping the product intent or trusting an
      // ungrounded model-authored translation.
      const proposedTargetText = explicitTargetText
        || (!registeredCategory ? groundedText.normalize("NFKC").trim().slice(0, 200) : "")
        || operation.target.categoryId;
      const categorySupported = registeredCategory?.categoryId === "headphones"
        ? /耳机|headphones?|headsets?/iu.test(groundedText) || inferCategoryContract(groundedText)?.categoryId === "headphones"
        : registeredCategory?.categoryId === "smartphone"
          ? /手机|iphones?|smartphones?|mobile\s+phones?|galaxy|pixel/iu.test(groundedText) || inferCategoryContract(groundedText)?.categoryId === "smartphone"
          : Boolean(groundedText.trim()) && compactText(groundedText).includes(compactText(proposedTargetText));
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
      // Registered product identity is verified by the target contract. A
      // second generic brand/model constraint has no independent proof rule
      // and would incorrectly disqualify otherwise matching offers.
      if (/(?:^|_)(?:brand|manufacturer|model)(?:_|$)/iu.test(operation.constraint.key)
        && resolveCategoryContract(activeTarget?.categoryId ?? "")
        && activeTarget?.canonicalModel) return null;
    }
    return operation;
  };
  let ops = proposal.ops.flatMap((operation) => {
    const value = sanitize(operation);
    return value ? [value] : [];
  });
  // Missing semantic effects belong to the model-facing intent layer. Keep
  // the historical lexical recovery code disabled while it is removed in
  // stages; the Host may validate proposed values but must not become a
  // second prose planner.
  const allowLexicalIntentRecovery = false;
  const hasTargetMutation = ops.some((operation) => operation.kind === "GOAL_SET_TARGET" || operation.kind === "GOAL_CLEAR_TARGET");
  if (allowLexicalIntentRecovery && !hasTargetMutation) {
    for (let sourceMessageOrdinal = contents.length - 1; sourceMessageOrdinal >= 0; sourceMessageOrdinal -= 1) {
      const content = contents[sourceMessageOrdinal]!;
      const hasShoppingIntent = /(?:想买|要买|我要(?:的是)?|选定|确定(?:买|要)|找|查|搜索|检索|推荐|看看|比较|换成|改成|说错|不是.{0,40}(?:是|要))|\b(?:buy|find|search|recommend|look\s+for|switch\s+to|change\s+to|compare|correction)\b/iu.test(content);
      if (!hasShoppingIntent) continue;
      const correction = /(?:说错|不是.{0,40}(?:是|要)|改成|换成|容量改为?|容量改成)|\b(?:correction|switch\s+to|change\s+to)\b/iu.test(content);
      const contract = inferCategoryContract(content)
        ?? (correction && existingGoal?.target ? resolveCategoryContract(existingGoal.target.categoryId) : null);
      if (!contract) {
        if (existingGoal?.target) continue;
        // A market/budget correction such as "改成只看新加坡，预算降到…"
        // does not introduce a new product. In a superseding batch, keep
        // scanning older unconsumed messages for the actual target instead of
        // turning this scope-only message into an open-category target.
        if (correction && /只看|只在|范围|市场|预算|上限|最高|排序|偏好|刷新/iu.test(content)) continue;
        if (explicitlyLeavesProductTargetOpen(content)) continue;
        let opId = "host-recovered-open-target";
        for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-recovered-open-target-${suffix}`;
        const condition = /新机|全新|brand[\s-]?new|\bnew\b/iu.test(content)
          ? "NEW" as const
          : /翻新|refurbished|renewed/iu.test(content)
            ? "REFURBISHED" as const
            : /二手|pre[\s-]?owned|\bused\b/iu.test(content)
              ? "USED" as const
              : "ANY" as const;
        ops = [{
          opId,
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal,
          target: {
            categoryId: "open",
            targetText: content.normalize("NFKC").trim().slice(0, 200),
            canonicalModel: null,
            itemRole: "PRIMARY_PRODUCT",
            condition,
          },
        }, ...ops];
        break;
      }
      const models = canonicalModels(content, contract.categoryId);
      const capacity = contract.categoryId === "smartphone"
        ? content.normalize("NFKC").match(/\b(\d+)\s*(GB|TB)\b/iu)
        : null;
      const existingModelBase = existingGoal?.target?.categoryId === contract.categoryId
        ? existingGoal.target.canonicalModel?.replace(/\s+\d+(?:GB|TB)\b/iu, "") ?? null
        : null;
      const capacityCorrectedModel = correction && capacity && existingModelBase
        ? `${existingModelBase} ${capacity[1]}${capacity[2]!.toUpperCase()}`
        : null;
      const selectedModel = correction ? models.at(-1) ?? null : models[0] ?? null;
      const canonicalModel = capacityCorrectedModel
        ?? (selectedModel && capacity && !/\b\d+\s*(?:GB|TB)\b/iu.test(selectedModel)
          ? `${selectedModel} ${capacity[1]}${capacity[2]!.toUpperCase()}`
          : selectedModel);
      const sameExistingTarget = existingGoal?.target?.categoryId === contract.categoryId
        && (!canonicalModel || existingGoal.target.canonicalModel === canonicalModel);
      if (sameExistingTarget) break;
      let opId = "host-recovered-target";
      for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-recovered-target-${suffix}`;
      const condition = /新机|全新|brand[\s-]?new|\bnew\b/iu.test(content)
        ? "NEW" as const
        : /翻新|refurbished|renewed/iu.test(content)
          ? "REFURBISHED" as const
          : /二手|pre[\s-]?owned|\bused\b/iu.test(content)
            ? "USED" as const
            : existingGoal?.target?.categoryId === contract.categoryId
              ? existingGoal.target.condition
              : "ANY" as const;
      ops = [{
        opId,
        kind: "GOAL_SET_TARGET",
        sourceMessageOrdinal,
        target: {
          categoryId: contract.categoryId,
          canonicalModel,
          itemRole: "PRIMARY_PRODUCT",
          condition,
        },
      }, ...ops];
      break;
    }
  }
  const targetOperation = ops.find((operation) => operation.kind === "GOAL_SET_TARGET");
  const effectiveTarget = targetOperation?.kind === "GOAL_SET_TARGET" ? targetOperation.target : existingGoal?.target;
  if (effectiveTarget?.canonicalModel && resolveCategoryContract(effectiveTarget.categoryId)) {
    const targetCarriesCapacity = /\b\d+\s*(?:GB|TB)\b/iu.test(effectiveTarget.canonicalModel);
    ops = ops.filter((operation) => operation.kind !== "GOAL_UPSERT_CONSTRAINT"
      || !(/(?:^|_)(?:brand|manufacturer|model)(?:_|$)/iu.test(operation.constraint.key)
        || (targetCarriesCapacity && /(?:storage|capacity)/iu.test(operation.constraint.key))));
  }
  const hasMarketMutation = ops.some((operation) => operation.kind === "GOAL_SET_RETRIEVAL_MARKETS");
  if (allowLexicalIntentRecovery && !hasMarketMutation && (existingGoal?.retrievalMarkets.length ?? 0) === 0) {
    for (const [sourceMessageOrdinal, content] of contents.entries()) {
      const markets = [
        ...(/美国|美区|\bUS\b|United States/iu.test(content) ? ["US"] : []),
        ...(/新加坡|新加坡区|\bSG\b|Singapore/iu.test(content) ? ["SG"] : []),
      ];
      if (markets.length === 0) continue;
      let opId = "host-recovered-markets";
      for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-recovered-markets-${suffix}`;
      const targetOffset = ops.findIndex((operation) => operation.kind === "GOAL_SET_TARGET");
      const insertAt = targetOffset >= 0 ? targetOffset + 1 : 0;
      ops = [
        ...ops.slice(0, insertAt),
        { opId, kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal, markets },
        ...ops.slice(insertAt),
      ];
      break;
    }
  }
  if (allowLexicalIntentRecovery) {
    const latestMarketDirective = [...contents.entries()].reverse().find(([, content]) =>
      /(?:扩大|扩展|收窄|缩小|改成|换成|只看|只在).{0,16}(?:美国|美区|新加坡|新加坡区|\bUS\b|\bSG\b)|(?:范围|市场).{0,16}(?:扩大|扩展|收窄|缩小|改|只)/iu.test(content)
    );
    if (latestMarketDirective) {
      const [sourceMessageOrdinal, content] = latestMarketDirective;
      const markets = [
        ...(/美国|美区|\bUS\b|United States/iu.test(content) ? ["US"] : []),
        ...(/新加坡|新加坡区|\bSG\b|Singapore/iu.test(content) ? ["SG"] : []),
      ];
      const alreadyGrounded = ops.some((operation) => operation.kind === "GOAL_SET_RETRIEVAL_MARKETS"
        && operation.sourceMessageOrdinal === sourceMessageOrdinal
        && JSON.stringify([...operation.markets].sort()) === JSON.stringify([...markets].sort()));
      if (markets.length > 0 && !alreadyGrounded) {
        let opId = "host-recovered-market-override";
        for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-recovered-market-override-${suffix}`;
        const researchOffset = ops.findIndex((operation) => operation.kind === "RESEARCH_OFFERS");
        const insertAt = researchOffset >= 0 ? researchOffset : ops.length;
        ops = [
          ...ops.slice(0, insertAt),
          { opId, kind: "GOAL_SET_RETRIEVAL_MARKETS", sourceMessageOrdinal, markets },
          ...ops.slice(insertAt),
        ];
      }
    }
  }
  if (allowLexicalIntentRecovery && latestBudgetDirective) {
    const [sourceMessageOrdinal, content] = latestBudgetDirective;
    const amount = statedBudget(content);
    const hasGroundedDirective = ops.some((operation) => operation.sourceMessageOrdinal === sourceMessageOrdinal
      && (amount
        ? operation.kind === "GOAL_SET_BUDGET" && operation.budget.amount.replace(/,/g, "") === amount
        : operation.kind === "GOAL_CLEAR_BUDGET"));
    if (!hasGroundedDirective && (amount || existingGoal?.budget || ops.some((operation) => operation.kind === "GOAL_SET_BUDGET"))) {
      let opId = amount ? "host-recovered-budget" : "host-recovered-clear-budget";
      for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `${amount ? "host-recovered-budget" : "host-recovered-clear-budget"}-${suffix}`;
      const researchOffset = ops.findIndex((operation) => operation.kind === "RESEARCH_OFFERS");
      const insertAt = researchOffset >= 0 ? researchOffset : ops.length;
      const budgetOperation: ProposedTurnOperation = amount
        ? {
          opId,
          kind: "GOAL_SET_BUDGET",
          sourceMessageOrdinal,
          budget: {
            amount,
            currency: /美元|\bUSD\b|US\$/iu.test(content) ? "USD" : /新加坡元|新币|\bSGD\b|S\$/iu.test(content) ? "SGD" : "CNY",
          },
        }
        : { opId, kind: "GOAL_CLEAR_BUDGET", sourceMessageOrdinal };
      ops = [...ops.slice(0, insertAt), budgetOperation, ...ops.slice(insertAt)];
    }
  }
  const explicitlyRequestsRefresh = contents.some((content) => /刷新.*(?:报价|结果)|重新(?:搜索|查|找)|refresh/iu.test(content)
    && !/(?:别|不要|无需|不必).{0,6}(?:刷新|重新)/u.test(content));
  if (allowLexicalIntentRecovery && explicitlyRequestsRefresh && !ops.some((operation) => operation.kind === "RESEARCH_OFFERS")) {
    let opId = "host-recovered-refresh";
    for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-recovered-refresh-${suffix}`;
    ops.push({ opId, kind: "RESEARCH_OFFERS", reasonCode: "USER_REQUESTED_REFRESH" });
  }
  const hasPricePreference = ops.some((operation) => operation.kind === "GOAL_UPSERT_PREFERENCE" && /price|价格|便宜/iu.test(operation.preference.key));
  const priceRerankOffset = ops.findIndex((operation) => operation.kind === "RERANK_WORKING_SET" && /price|价格|便宜/iu.test(operation.preferenceKey));
  if (allowLexicalIntentRecovery && !hasPricePreference && priceRerankOffset >= 0) {
    for (let sourceMessageOrdinal = contents.length - 1; sourceMessageOrdinal >= 0; sourceMessageOrdinal -= 1) {
      const content = contents[sourceMessageOrdinal]!;
      if (!/便宜|低价|价格低|价格优先|cheaper|lower[ -]?price|price\s+first/iu.test(content)) continue;
      let opId = "host-recovered-price-preference";
      for (let suffix = 2; ops.some((operation) => operation.opId === opId); suffix += 1) opId = `host-recovered-price-preference-${suffix}`;
      ops = [
        ...ops.slice(0, priceRerankOffset),
        {
          opId,
          kind: "GOAL_UPSERT_PREFERENCE",
          sourceMessageOrdinal,
          preference: { key: "price", value: "LOWER", weight: 1 },
        },
        ...ops.slice(priceRerankOffset),
      ];
      break;
    }
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

function recoverExplicitWorkingSetProposal(
  proposal: TurnPlanProposal,
  contents: string[] | undefined,
  workingSet: WorkingSet | null,
): TurnPlanProposal {
  if (!contents || !workingSet || proposal.ops.some((operation) => operation.kind === "REJECT_OFFERS")) return proposal;
  const requestsReject = contents.some((content) => /不要(?!删|移除|排除)|排除(?!其他|其余)|reject/iu.test(content)
    && !/(?:刚才|之前).{0,8}不要.{0,8}(?:恢复|还原)|(?:仍然|继续|依然)不要/iu.test(content));
  if (!requestsReject) return proposal;
  const ranks = explicitOrdinalRanks(contents);
  const recovered = ranks.flatMap((rank, index): ProposedTurnOperation[] => workingSet.displayOfferRefs[rank - 1] ? [{
    opId: `host-recovered-reject-${index + 1}`,
    kind: "REJECT_OFFERS",
    referents: [{ kind: "DISPLAY_RANK", rank }],
    reasonCode: "USER_REJECTED",
  }] : []);
  if (contents.some((content) => /(?:然后|再|接着).{0,12}(?:现在)?最后一条.{0,8}(?:排除|不要)|(?:排除|不要).{0,12}(?:然后|再|接着).{0,12}(?:现在)?最后一条/iu.test(content))) {
    recovered.push({
      opId: "host-recovered-reject-current-last",
      kind: "REJECT_OFFERS",
      referents: [{ kind: "TEXT", text: "current last shown offer" }],
      reasonCode: "USER_REJECTED",
    });
  }
  return recovered.length > 0 ? { ...proposal, ops: [...recovered, ...proposal.ops] } : proposal;
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

function inspectionFieldsFromMessages(contents: string[] | undefined): Array<Extract<WorldOperation, { kind: "INSPECT_WORKING_SET" }>["fields"][number]> {
  const text = (contents ?? []).join("\n");
  const fields: Array<Extract<WorldOperation, { kind: "INSPECT_WORKING_SET" }>["fields"][number]> = [];
  if (/价格|多少钱|price|cost/iu.test(text)) fields.push("PRICE");
  if (/商家|店铺|merchant|seller/iu.test(text)) fields.push("MERCHANT");
  if (/市场|哪里|来源|market|source/iu.test(text)) fields.push("MARKET");
  if (/库存|有货|现货|stock|availability/iu.test(text)) fields.push("STOCK");
  if (/型号|model/iu.test(text)) fields.push("MODEL");
  if (/成色|新旧|condition/iu.test(text)) fields.push("CONDITION");
  if (/为什么|排序|依据|reason|rank/iu.test(text)) fields.push("RANKING_REASON");
  if (/保修|warranty/iu.test(text)) fields.push("WARRANTY");
  return [...new Set(fields)];
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
    const supportedProposal = compileTurnIntent(sanitizeGoalProposal(
      proposal,
      this.options.inputMessageContents,
      this.options.baseState.goalRevision?.goal ?? null,
    ), this.options.baseState);
    const stablePlan = stabilizePlanReferents(bindPlan(supportedProposal, this.options.inputMessageIds), this.options.baseState.workingSet);
    const undoNormalizedPlan = normalizeUndoRevision(stablePlan, this.options.baseState.revision, this.options.inputMessageContents);
    const proposedPlan = constrainOrdinalRejections(undoNormalizedPlan, this.options.baseState.workingSet, this.options.inputMessageContents);
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
      case "INSPECT_RESEARCH_COVERAGE":
        return this.options.world.inspectResearchCoverage(operation, structuredClone(this.state), signal);
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
    const coverageInspectionOnly = this.plan.ops.every((operation) => operation.kind === "INSPECT_RESEARCH_COVERAGE");
    const materializedBlocks: AssistantEnvelope["blocks"] = proposal.blocks.map((block) => {
      if (block.type === "QUESTION") return { ...block, wording: clarificationWording(block.slotId) };
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
    if (safeBlocks.length === 0) {
      safeBlocks.push({
        type: "TRANSITION",
        text: hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
          ? "当前没有形成可验证的候选。"
          : "我已更新当前选购状态。",
      });
    }
    const allCandidatesAreDiscovery = (this.state.workingSet?.pool.length ?? 0) > 0
      && this.state.workingSet!.pool.every((candidate) => candidate.discovery?.supportLevel === "DISCOVERY");
    const outcome = hasClarification
      ? "CLARIFICATION"
      : hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? "NO_MATCH"
        : allCandidatesAreDiscovery && (hasResearch || proposal.outcome === "RECOMMENDATION")
          ? "DISCOVERY"
        : hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) > 0
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
    let blockedQuestionSlotId = [...receipts].reverse().flatMap((receipt) => receipt.questionSlotIds)[0] ?? null;
    if (!plan) {
      // A pre-plan model failure has produced no trustworthy semantic frame.
      // Persist trusted UI focus only, then ask for a rephrase; never reparse
      // the raw utterance here and silently turn the Host into another agent.
      plan = validateTurnPlan({
        userIntentSummary: "request a safe rephrase after model planning failure",
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
      receipts = [];
      for (const operation of plan.ops) receipts.push(await this.executeOperation(operation));
      blockedQuestionSlotId = [...receipts].reverse().flatMap((receipt) => receipt.questionSlotIds)[0] ?? null;
      executedFallbackPlan = true;
    }
    if (!plan) {
      const inspectionFields = inspectionFieldsFromMessages(this.options.inputMessageContents);
      const inspectionOfferRef = this.options.requiredFocusOfferRef ?? this.options.baseState.dialogue.focusOfferRef;
      const canRecoverInspection = Boolean(inspectionOfferRef) && inspectionFields.length > 0 && this.options.baseState.workingSet !== null;
      const emptyRecoveryProposal: TurnPlanProposal = {
        userIntentSummary: "recover an explicit shopping request after model protocol failure",
        ops: [],
        leftover: [],
      };
      const recoveredShoppingProposal = canRecoverInspection ? null : recoverExplicitWorkingSetProposal(
        sanitizeGoalProposal(
          emptyRecoveryProposal,
          this.options.inputMessageContents,
          this.options.baseState.goalRevision?.goal ?? null,
        ),
        this.options.inputMessageContents,
        this.options.baseState.workingSet,
      );
      const recoveredMarkets = recoveredShoppingProposal?.ops.find((operation) => operation.kind === "GOAL_SET_RETRIEVAL_MARKETS");
      const hasRecoveredTarget = Boolean(recoveredShoppingProposal?.ops.some((operation) => operation.kind === "GOAL_SET_TARGET"));
      const hasUsableMarkets = recoveredMarkets?.kind === "GOAL_SET_RETRIEVAL_MARKETS"
          ? recoveredMarkets.markets.length > 0
          : (this.options.baseState.goalRevision?.goal.retrievalMarkets.length ?? 0) > 0;
      const canRecoverShopping = hasRecoveredTarget && hasUsableMarkets;
      const canRecoverPartialShopping = hasRecoveredTarget && !hasUsableMarkets;
      const canRecoverFollowup = Boolean(this.options.baseState.workingSet
        && recoveredShoppingProposal?.ops.some((operation) => operation.kind === "REJECT_OFFERS"
          || operation.kind === "RESTORE_OFFERS"
          || operation.kind === "RESEARCH_OFFERS"
          || operation.kind.startsWith("GOAL_")));
      if (canRecoverShopping || canRecoverPartialShopping || canRecoverFollowup) {
        const pendingSlotId = this.options.baseState.dialogue.pendingClarification?.slotId;
        const recoveryProposal: TurnPlanProposal = {
          ...emptyRecoveryProposal,
          ops: canRecoverPartialShopping
            ? [{ opId: "host-recovered-market-clarification", kind: "REQUEST_CLARIFICATION", slotId: "retrieval_markets", reasonCode: "MARKET_REQUIRED" }]
            : hasRecoveredTarget && pendingSlotId && pendingSlotId !== "turn_rephrase"
              ? [{
                opId: "host-recovered-goal-gap",
                kind: "GOAL_RESOLVE_GAP",
                sourceMessageOrdinal: Math.max(0, (this.options.inputMessageContents?.length ?? 1) - 1),
                slotId: pendingSlotId,
              }]
              : [],
        };
        const committed = await this.commitPlan(recoveryProposal);
        plan = committed.plan;
        receipts = [];
        for (const operation of plan.ops) receipts.push(await this.executeOperation(operation));
        blockedQuestionSlotId = [...receipts].reverse().flatMap((receipt) => receipt.questionSlotIds)[0] ?? null;
        executedFallbackPlan = true;
      }
      if (!plan) plan = validateTurnPlan({
        userIntentSummary: canRecoverInspection
          ? "recover an explicit focused-offer fact question after model protocol failure"
          : "request a safe rephrase after protocol failure",
        ops: canRecoverInspection ? [
          {
            opId: "fallback-ui-focus",
            kind: "SET_FOCUS" as const,
            referent: { kind: "OFFER_REF" as const, offerRef: inspectionOfferRef! },
          },
          {
            opId: "fallback-inspect",
            kind: "INSPECT_WORKING_SET" as const,
            referents: [{ kind: "OFFER_REF" as const, offerRef: inspectionOfferRef! }],
            fields: inspectionFields,
          },
        ] : [
          ...(this.options.requiredFocusOfferRef ? [{
            opId: "fallback-ui-focus",
            kind: "SET_FOCUS" as const,
            referent: { kind: "OFFER_REF" as const, offerRef: this.options.requiredFocusOfferRef },
          }] : []),
          { opId: "fallback-clarification", kind: "REQUEST_CLARIFICATION", slotId: "turn_rephrase", reasonCode: "MODEL_PROTOCOL_FAILED" },
        ],
        leftover: [],
      });
      if (!executedFallbackPlan) {
        this.plan = plan;
        await this.options.onPlanCommitted?.(plan);
        receipts = [];
        for (const operation of plan.ops) receipts.push(await this.executeOperation(operation));
        blockedQuestionSlotId = [...receipts].reverse().flatMap((receipt) => receipt.questionSlotIds)[0] ?? null;
        executedFallbackPlan = true;
      }
    }
    const fallbackClaimIds = [...new Set(receipts.flatMap((receipt) => receipt.claimIds))];
    if (plan && fallbackClaimIds.length > 0) {
      const disclosureCodes = [...new Set(receipts.flatMap((receipt) => receipt.disclosureCodes))];
      const claimLimit = Math.max(1, 20 - disclosureCodes.length - 1);
      const hasResearch = plan.ops.some((operation) => operation.kind === "RESEARCH_OFFERS");
      const outcome: AssistantEnvelope["outcome"] = hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? "NO_MATCH"
        : hasResearch && (this.state.workingSet?.pool.length ?? 0) > 0
          && this.state.workingSet!.pool.every((candidate) => candidate.discovery?.supportLevel === "DISCOVERY")
          ? "DISCOVERY"
          : hasResearch
            ? "RECOMMENDATION"
            : "CHAT";
      const envelope: AssistantEnvelope = {
        outcome,
        addressedOpIds: plan.ops.map((operation) => operation.opId),
        blocks: [
          { type: "TRANSITION", text: transitionText(hasResearch ? "RESEARCH_COMPLETED" : "EVIDENCE_SUMMARY") },
          ...disclosureCodes.map((disclosureCode) => ({ type: "DISCLOSURE" as const, disclosureCode })),
          ...fallbackClaimIds.slice(0, claimLimit).map((claimId) => ({ type: "CLAIM" as const, claimId })),
        ],
        nextMoves: [],
      };
      const fallbackLedger = this.claimLedgerForEnvelope(envelope);
      validateAssistantEnvelope(envelope, {
        plan,
        claimLedger: fallbackLedger,
        allowedOfferRefs: new Set(this.state.workingSet?.pool.map((candidate) => candidate.offerRef) ?? []),
        allowedQuestionSlotIds: this.questionSlotIds,
        allowedDisclosureCodes: this.disclosureCodes,
      });
      if (!this.state.workingSet) throw new DomainError("CLAIM_WORKING_SET_REQUIRED", "Claims require a working set");
      verifyClaimLedger(fallbackLedger, {
        workingSet: this.state.workingSet,
        allowedEvidenceRefs: this.evidenceKeys,
        envelope,
        renderedDraft: renderAssistantEnvelope(envelope, fallbackLedger),
      });
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
    const fullyExecuted = plan !== null
      && receipts.length === plan.ops.length
      && receipts.every((receipt) => receipt.status !== "FAILED");
    if (plan && fullyExecuted && !blockedQuestionSlotId) {
      const disclosureCodes = [...new Set(receipts.flatMap((receipt) => receipt.disclosureCodes))];
      const hasResearch = plan.ops.some((operation) => operation.kind === "RESEARCH_OFFERS");
      const outcome: AssistantEnvelope["outcome"] = hasResearch && (this.state.workingSet?.displayOfferRefs.length ?? 0) === 0
        ? "NO_MATCH"
        : hasResearch && (this.state.workingSet?.pool.length ?? 0) > 0
          && this.state.workingSet!.pool.every((candidate) => candidate.discovery?.supportLevel === "DISCOVERY")
          ? "DISCOVERY"
          : "CHAT";
      const envelope: AssistantEnvelope = {
        outcome,
        addressedOpIds: plan.ops.map((operation) => operation.opId),
        blocks: [
          { type: "TRANSITION", text: transitionText(hasResearch ? "RESEARCH_COMPLETED" : "STATE_UPDATED") },
          ...disclosureCodes.slice(0, 19).map((disclosureCode) => ({ type: "DISCLOSURE" as const, disclosureCode })),
        ],
        nextMoves: [],
      };
      const fallbackLedger = this.claimLedgerForEnvelope(envelope);
      validateAssistantEnvelope(envelope, {
        plan,
        claimLedger: fallbackLedger,
        allowedOfferRefs: new Set(this.state.workingSet?.pool.map((candidate) => candidate.offerRef) ?? []),
        allowedQuestionSlotIds: this.questionSlotIds,
        allowedDisclosureCodes: this.disclosureCodes,
      });
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
