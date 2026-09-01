import {
  type QuoteAssistantPublication,
  type QuoteConversationState,
  type QuoteTurnOperation,
  type QuoteTurnPlan,
} from "@interec/domain";

export interface QuoteOperationReceiptView {
  opId: string;
  kind: QuoteTurnOperation["kind"];
  status: "APPLIED" | "BLOCKED";
  providerCalled: boolean;
  publicResult: Record<string, unknown>;
}

const MERCHANT_CHECK = "请打开商家页确认最终价格、准确型号/版本、成色与是否可购买。";
const AFFILIATE_NOTICE = "部分入口可能是推广或联盟链接。";

function disclosureCodes(
  state: QuoteConversationState,
  outcome: QuoteAssistantPublication["outcome"],
): QuoteAssistantPublication["disclosureCodes"] {
  if (state.leadSet?.outcome === "QUOTE_LEADS" && state.leadSet.leads.length > 0) {
    return ["MERCHANT_PAGE_CHECK_REQUIRED", "AFFILIATE_LINK_DISCLOSURE"];
  }
  if (outcome === "NO_QUOTE_LEADS" || outcome === "DEGRADED") {
    return ["PROVIDER_RESULT_NOT_MARKET_ABSENCE"];
  }
  return [];
}

function priceText(lead: NonNullable<QuoteConversationState["leadSet"]>["leads"][number]): string {
  return lead.priceRanges.map((range) => {
    const original = range.originalPrice.minAmount === range.originalPrice.maxAmount
      ? `${range.originalPrice.currency} ${range.originalPrice.minAmount}`
      : `${range.originalPrice.currency} ${range.originalPrice.minAmount}–${range.originalPrice.maxAmount}`;
    if (!range.cnyEstimate) return `${original}（当前没有可发布的 CNY 汇率估算）`;
    const cny = range.cnyEstimate.minAmount === range.cnyEstimate.maxAmount
      ? `CNY ${range.cnyEstimate.minAmount}`
      : `CNY ${range.cnyEstimate.minAmount}–${range.cnyEstimate.maxAmount}`;
    return `${original}（约 ${cny}，汇率观测 ${range.cnyEstimate.fxObservedAt}）`;
  }).join("；");
}

function leadSummary(state: QuoteConversationState, refs: readonly string[]): string {
  return refs.flatMap((ref) => {
    const lead = state.leadSet?.leads.find((item) => item.quoteLeadRef === ref);
    if (!lead) return [];
    const rank = state.displayQuoteLeadRefs.indexOf(ref) + 1;
    return [`线索${rank > 0 ? ` ${rank}` : ""}：${priceText(lead)}；成色 ${lead.condition}；商家域名 ${lead.merchantDomain}；${lead.observationCount} 条观测，最近观测 ${lead.latestObservedAt}。`];
  }).join("\n");
}

/** Renders only host-owned facts from the validated quote state and operation receipts. */
export function renderQuoteAssistantPublication(
  plan: QuoteTurnPlan,
  state: QuoteConversationState,
  receipts: readonly QuoteOperationReceiptView[],
): QuoteAssistantPublication {
  const addressedOpIds = plan.ops.map((operation) => operation.opId);
  const requestedModel = plan.ops.some((operation) => operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION");
  const declined = plan.ops.find((operation) => operation.kind === "DECLINE_UNSUPPORTED_QUOTE_TARGET");
  if (declined?.kind === "DECLINE_UNSUPPORTED_QUOTE_TARGET") {
    return {
      outcome: "CHAT",
      addressedOpIds,
      disclosureCodes: [],
      text: declined.reasonCode === "SERVICE"
        ? "这个助手不查询维修或服务报价。请提供要购买的主商品准确型号，我可以查找面向新加坡的报价线索。"
        : "这个助手不查询配件或替换零件报价，也不会把它们当成主商品。请提供主商品的准确型号。",
    };
  }
  if (requestedModel) {
    return {
      outcome: "CLARIFICATION",
      addressedOpIds,
      disclosureCodes: [],
      text: "请提供商品的准确型号。型号确认前我不会调用报价服务，也不会改查相近商品。",
    };
  }
  if (state.pendingTargetConfirmation) {
    return {
      outcome: "CLARIFICATION",
      addressedOpIds,
      disclosureCodes: [],
      text: `请确认准确型号是否为 ${state.pendingTargetConfirmation.proposal.proposedModel}。确认前我不会调用报价服务。`,
    };
  }

  const providerCalled = receipts.some((receipt) => receipt.providerCalled);
  if (providerCalled && state.leadSet?.outcome === "QUOTE_LEADS") {
    return {
      outcome: "QUOTE_LEADS",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "QUOTE_LEADS"),
      text: `已记录这次报价观测，共发布 ${state.leadSet.leads.length} 个报价线索。原币价格、成色和入口见报价区；${MERCHANT_CHECK}${AFFILIATE_NOTICE}`,
    };
  }
  if (providerCalled && state.leadSet?.outcome === "NO_QUOTE_LEADS") {
    const allRejected = state.leadSet.reasonCodes.includes("ALL_RECORDS_REJECTED");
    return {
      outcome: "NO_QUOTE_LEADS",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "NO_QUOTE_LEADS"),
      text: allRejected
        ? "本次返回记录均未通过准确型号、商品角色或必要字段核验，因此没有发布报价线索。这不表示新加坡市场没有该商品。"
        : "本次报价服务没有返回可发布记录。这只是一次空观测，不表示新加坡市场没有该商品。",
    };
  }
  if (providerCalled && state.leadSet?.outcome === "DEGRADED") {
    return {
      outcome: "DEGRADED",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "DEGRADED"),
      text: "报价服务本次未能完成，因此没有取得可发布报价线索；这不表示新加坡市场没有该商品。你可以明确要求刷新后重试。",
    };
  }

  const hasLeadContext = Boolean(state.leadSet?.leads.length);
  const comparison = plan.ops.find((operation) => operation.kind === "SET_QUOTE_COMPARISON");
  if (comparison?.kind === "SET_QUOTE_COMPARISON") {
    return {
      outcome: "CHAT",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "CHAT"),
      text: `以下比较复用当前已发布观测，没有重新调用报价服务。\n${leadSummary(state, state.comparisonQuoteLeadRefs)}\n这些是报价线索的字段差异，不是商品优劣排序；${MERCHANT_CHECK}${AFFILIATE_NOTICE}`,
    };
  }
  const inspection = plan.ops.find((operation) => operation.kind === "INSPECT_QUOTE_LEADS");
  if (inspection?.kind === "INSPECT_QUOTE_LEADS") {
    const receipt = receipts.find((item) => item.opId === inspection.opId);
    const refs = Array.isArray(receipt?.publicResult["quoteLeadRefs"])
      ? receipt.publicResult["quoteLeadRefs"].map(String)
      : [];
    const excludedRefs = refs.filter((ref) => state.excludedQuoteLeadRefs.includes(ref));
    const targetContext = state.target
      ? `当前准确型号是 ${state.target.canonicalModel}，以下信息来自当前已发布观测。`
      : "以下信息来自当前已发布观测。";
    const exclusionContext = excludedRefs.length > 0
      ? `其中 ${excludedRefs.length} 个报价线索已在当前会话中排除，因此不会出现在当前展示列表；检查状态不会触发重新查询。`
      : "";
    return {
      outcome: "CHAT",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "CHAT"),
      text: `${targetContext}没有重新调用报价服务。\n${leadSummary(state, refs)}\n观测条数不是商家数量；${exclusionContext}${MERCHANT_CHECK}${AFFILIATE_NOTICE}`,
    };
  }
  if (plan.ops.some((operation) => operation.kind === "INSPECT_QUOTE_STATUS") && state.target) {
    const normalization = state.target.normalizationChanges.length > 0
      ? `记录到的标准化：${state.target.normalizationChanges.join("、")}；未改动型号字母或数字。`
      : "没有记录到型号字符改写。";
    const observation = state.leadSet
      ? `当前观测结果为 ${state.leadSet.outcome}，provider 状态为 ${state.leadSet.providerStatus}，观测时间 ${state.leadSet.observedAt}。`
      : "当前还没有已发布报价观测。";
    return {
      outcome: "CHAT",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "CHAT"),
      text: `当前准确型号是 ${state.target.canonicalModel}。${normalization}${observation}${hasLeadContext ? ` ${MERCHANT_CHECK}${AFFILIATE_NOTICE}` : ""}`,
    };
  }
  if (plan.ops.some((operation) => operation.kind === "EXCLUDE_QUOTE_LEADS")) {
    return {
      outcome: "CHAT",
      addressedOpIds,
      disclosureCodes: disclosureCodes(state, "CHAT"),
      text: `已在当前会话中保留这项排除，没有重新调用报价服务。以后明确刷新时，如果同一商家页面与成色再次出现，这项排除仍会生效；其余线索${MERCHANT_CHECK}${AFFILIATE_NOTICE}`,
    };
  }
  return {
    outcome: "CHAT",
    addressedOpIds,
    disclosureCodes: disclosureCodes(state, "CHAT"),
    text: hasLeadContext
      ? `已按当前报价观测更新对话视图，没有重新调用报价服务。报价是观测线索；${MERCHANT_CHECK}${AFFILIATE_NOTICE}`
      : "请告诉我商品的准确型号。我会查找面向新加坡的报价线索，并把最终确认留在商家页面。",
  };
}
