import { DomainError } from "./errors.js";
import type {
  PublishedQuoteLeadSet,
  QuoteAssistantPublication,
  QuoteConversationState,
  QuoteTurnPlan,
} from "./quote-conversation-types.js";
import { QUOTE_LEAD_CONTRACT_VERSION, type QuoteLeadSet } from "./quote-types.js";
import { assertHttps, assertIso, assertNoForbiddenPublicKey, uniqueRefs } from "./quote-validation.js";

const FORBIDDEN_QUOTE_REPLY_PATTERN = /(?:全网最低|当前最低|最便宜|产品推荐|购买推荐|\bin\s*stock\b|\bdelivery\s+(?:is|confirmed)\b|\bshipping\s+(?:is|confirmed)\b|\blowest\s+price\b|\bbest\s+(?:price|value|choice)\b|\btop\s+pick\b)/iu;

export function validateQuoteAssistantPublication(
  publication: QuoteAssistantPublication,
  plan: QuoteTurnPlan,
  state: QuoteConversationState,
): QuoteAssistantPublication {
  const value = structuredClone(publication);
  const text = value.text.normalize("NFKC").trim();
  if (!text || text.length > 1_000) throw new DomainError("INVALID_QUOTE_REPLY_TEXT", text);
  if (/https?:\/\//iu.test(text)) throw new DomainError("QUOTE_REPLY_URL_NOT_ALLOWED", text);
  if (FORBIDDEN_QUOTE_REPLY_PATTERN.test(text)) throw new DomainError("QUOTE_REPLY_SEMANTIC_OVERCLAIM", text);
  const operationIds = plan.ops.map((operation) => operation.opId);
  if (new Set(value.addressedOpIds).size !== value.addressedOpIds.length
    || value.addressedOpIds.length !== operationIds.length
    || operationIds.some((id) => !value.addressedOpIds.includes(id))) {
    throw new DomainError("QUOTE_REPLY_OPERATION_COVERAGE_MISMATCH", value.addressedOpIds.join(","));
  }
  if (new Set(value.disclosureCodes).size !== value.disclosureCodes.length) throw new DomainError("DUPLICATE_QUOTE_DISCLOSURE", value.disclosureCodes.join(","));
  const providerOperation = plan.ops.some((operation) => operation.kind === "LOOKUP_QUOTES" || operation.kind === "REFRESH_QUOTES");
  if (providerOperation) {
    if (!state.leadSet) throw new DomainError("QUOTE_REPLY_LEAD_SET_REQUIRED", value.outcome);
    if (state.leadSet.outcome !== value.outcome) throw new DomainError("QUOTE_REPLY_OUTCOME_MISMATCH", `${state.leadSet.outcome}:${value.outcome}`);
  }
  if (value.outcome === "QUOTE_LEADS") {
    if (!state.leadSet?.leads.length) throw new DomainError("QUOTE_REPLY_LEADS_REQUIRED", value.outcome);
    if (!value.disclosureCodes.includes("MERCHANT_PAGE_CHECK_REQUIRED") || !value.disclosureCodes.includes("AFFILIATE_LINK_DISCLOSURE")) {
      throw new DomainError("QUOTE_REPLY_DISCLOSURE_REQUIRED", value.disclosureCodes.join(","));
    }
    if (!text.includes("商家页")) throw new DomainError("QUOTE_REPLY_MERCHANT_HANDOFF_REQUIRED", text);
  }
  if ((value.outcome === "NO_QUOTE_LEADS" || (providerOperation && value.outcome === "DEGRADED"))
    && !value.disclosureCodes.includes("PROVIDER_RESULT_NOT_MARKET_ABSENCE")) {
    throw new DomainError("QUOTE_EMPTY_NOT_ABSENCE_DISCLOSURE_REQUIRED", value.outcome);
  }
  if (value.outcome === "CLARIFICATION" && !state.pendingTargetConfirmation
    && !plan.ops.some((operation) => operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION")) {
    throw new DomainError("QUOTE_CLARIFICATION_WITHOUT_GAP", text);
  }
  if (plan.ops.some((operation) => operation.kind === "REQUEST_QUOTE_MODEL_CONFIRMATION") && state.target) {
    throw new DomainError("QUOTE_MODEL_REQUEST_WITH_ACTIVE_TARGET", state.target.targetRef);
  }
  value.text = text;
  return value;
}

export function projectPublishedQuoteLeadSet(leadSet: QuoteLeadSet): PublishedQuoteLeadSet {
  const projection: PublishedQuoteLeadSet = {
    contractVersion: leadSet.contractVersion,
    quoteLeadSetRef: leadSet.quoteLeadSetRef,
    targetRef: leadSet.target.targetRef,
    outcome: leadSet.outcome,
    reasonCodes: [...leadSet.reasonCodes],
    providerStatus: leadSet.provider.status,
    providerFailureCode: leadSet.provider.failureCode,
    providerRetryable: leadSet.provider.retryable,
    providerContractVersion: leadSet.provider.contractVersion,
    leads: leadSet.leads.map((lead) => ({
      quoteLeadRef: lead.quoteLeadRef,
      canonicalModel: lead.canonicalModel,
      representativeTitle: lead.representativeTitle,
      condition: lead.condition,
      merchantLabel: lead.merchantLabel,
      merchantDomain: lead.merchantDomain,
      outboundUrl: lead.outboundUrl,
      priceRanges: lead.priceRanges.map((range) => ({
        originalPrice: { currency: range.currency, minAmount: range.minAmount, maxAmount: range.maxAmount },
        cnyEstimate: range.cnyEstimate ? {
          minAmount: range.cnyEstimate.minAmount,
          maxAmount: range.cnyEstimate.maxAmount,
          fxObservedAt: range.cnyEstimate.fxObservedAt,
          fxExpiresAt: range.cnyEstimate.fxExpiresAt,
        } : null,
      })),
      observationCount: lead.observationCount,
      firstObservedAt: lead.firstObservedAt,
      latestObservedAt: lead.latestObservedAt,
    })),
    observedAt: leadSet.observedAt,
  };
  return validatePublishedQuoteLeadSet(projection);
}

export function validatePublishedQuoteLeadSet(input: PublishedQuoteLeadSet): PublishedQuoteLeadSet {
  const value = structuredClone(input);
  assertNoForbiddenPublicKey(value);
  if (value.contractVersion !== QUOTE_LEAD_CONTRACT_VERSION) throw new DomainError("QUOTE_CONTRACT_VERSION_MISMATCH", value.contractVersion);
  if (!value.quoteLeadSetRef.trim() || !value.targetRef.trim()) throw new DomainError("QUOTE_LEAD_SET_ID_REQUIRED", value.quoteLeadSetRef);
  const refs = uniqueRefs(value.leads.map((lead) => lead.quoteLeadRef), "DUPLICATE_QUOTE_LEAD_REF");
  if (value.outcome === "QUOTE_LEADS" && refs.length === 0) throw new DomainError("QUOTE_LEADS_OUTCOME_REQUIRES_LEADS", value.quoteLeadSetRef);
  if (value.outcome !== "QUOTE_LEADS" && refs.length > 0) throw new DomainError("NON_RESULT_OUTCOME_HAS_LEADS", value.quoteLeadSetRef);
  if (value.providerStatus === "OK_RESULTS" && value.outcome === "DEGRADED") throw new DomainError("QUOTE_PROVIDER_OUTCOME_MISMATCH", value.quoteLeadSetRef);
  if (["DEGRADED", "FAILED"].includes(value.providerStatus) && value.outcome !== "DEGRADED") throw new DomainError("QUOTE_PROVIDER_OUTCOME_MISMATCH", value.quoteLeadSetRef);
  value.observedAt = assertIso(value.observedAt, "INVALID_QUOTE_OBSERVED_AT");
  for (const lead of value.leads) {
    lead.outboundUrl = assertHttps(lead.outboundUrl, "INVALID_QUOTE_OUTBOUND_URL");
    if (!lead.merchantDomain.trim() || !lead.representativeTitle.trim() || !lead.canonicalModel.trim()) {
      throw new DomainError("INCOMPLETE_PUBLISHED_QUOTE_LEAD", lead.quoteLeadRef);
    }
    if (!Number.isSafeInteger(lead.observationCount) || lead.observationCount < 1) throw new DomainError("INVALID_QUOTE_OBSERVATION_COUNT", lead.quoteLeadRef);
    lead.firstObservedAt = assertIso(lead.firstObservedAt, "INVALID_QUOTE_OBSERVED_AT");
    lead.latestObservedAt = assertIso(lead.latestObservedAt, "INVALID_QUOTE_OBSERVED_AT");
    if (Date.parse(lead.firstObservedAt) > Date.parse(lead.latestObservedAt)) throw new DomainError("QUOTE_OBSERVATION_TIME_INVERTED", lead.quoteLeadRef);
    if (lead.priceRanges.length === 0) throw new DomainError("QUOTE_PRICE_RANGE_REQUIRED", lead.quoteLeadRef);
    for (const range of lead.priceRanges) {
      if (!/^[A-Z]{3}$/u.test(range.originalPrice.currency)) throw new DomainError("INVALID_QUOTE_CURRENCY", range.originalPrice.currency);
      if (!/^\d+(?:\.\d+)?$/u.test(range.originalPrice.minAmount) || !/^\d+(?:\.\d+)?$/u.test(range.originalPrice.maxAmount)) {
        throw new DomainError("INVALID_QUOTE_PRICE", lead.quoteLeadRef);
      }
      if (range.cnyEstimate) {
        range.cnyEstimate.fxObservedAt = assertIso(range.cnyEstimate.fxObservedAt, "INVALID_QUOTE_FX_TIME");
        range.cnyEstimate.fxExpiresAt = assertIso(range.cnyEstimate.fxExpiresAt, "INVALID_QUOTE_FX_TIME");
      }
    }
  }
  return value;
}
