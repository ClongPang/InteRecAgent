import { DomainError } from "./errors.js";
import { clarificationKey } from "./clarification.js";
import type { AssistantEnvelope, GroundedClaimSet, TurnPlan, GroundedClaim } from "./conversation-types.js";

export interface AssistantEnvelopeContext {
  plan: TurnPlan;
  groundedClaims: GroundedClaimSet;
  allowedOfferRefs: ReadonlySet<string>;
  allowedClarificationIds: ReadonlySet<string>;
  allowedDisclosureCodes: ReadonlySet<string>;
}

const factualTransitionPattern = /[0-9０-９¥￥$€£%]|\b(?:USD|SGD|CNY|RMB)\b/i;
const unsupportedRankingPattern = /最推荐|首选|最佳|最好|性价比最高|最值得|最适合|\b(?:best|top pick|highest quality|best value|most suitable)\b/i;

export function transitionContainsFactualData(text: string): boolean {
  return factualTransitionPattern.test(text);
}

export function transitionOverstatesRanking(text: string): boolean {
  return unsupportedRankingPattern.test(text);
}

function claimMap(ledger: GroundedClaimSet): Map<string, GroundedClaim> {
  const ids = ledger.claims.map((item) => item.claimId);
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("DUPLICATE_CLAIM_ID", `Claim ledger contains duplicate IDs: ${ids.join(",")}`);
  }
  return new Map(ledger.claims.map((item) => [item.claimId, item]));
}

export function renderDisclosureCode(code: string): string {
  const unknownFactMessages: Readonly<Record<string, string>> = {
    PRICE_UNKNOWN: "当前来源没有提供可验证的价格信息。",
    MERCHANT_UNKNOWN: "当前来源没有提供可验证的商家信息。",
    MARKET_UNKNOWN: "当前来源没有提供可验证的销售市场信息。",
    STOCK_UNKNOWN: "当前来源没有提供可验证的库存状态。",
    MODEL_UNKNOWN: "当前来源没有提供可验证的具体型号信息。",
    CONDITION_UNKNOWN: "当前来源没有提供可验证的商品成色信息。",
    RANKING_REASON_UNKNOWN: "当前证据不足以说明该候选的排序原因。",
    WARRANTY_UNKNOWN: "当前来源没有提供可验证的保修信息。",
  };
  if (unknownFactMessages[code]) return unknownFactMessages[code]!;
  const publicDisclosureMessages: Readonly<Record<string, string>> = {
    SEMANTIC_RELEVANCE_UNAVAILABLE: "商品相关性验证暂时未完成；这不代表没有符合需求的商品，建议稍后重试。",
    FX_ESTIMATE: "人民币价格按已记录汇率换算，仅供估算。",
    EXCLUDES_TAX_SHIPPING_PAYMENT: "当前价格不包含可能产生的税费、运费和支付手续费。",
    MERCHANT_CHECKOUT_FINAL: "最终价格和可购买状态以商家结算页为准。",
    DETERMINISTIC_OFFER_ORDER_NOT_PRODUCT_QUALITY: "当前顺序依据已验证的筛选和价格规则，不代表对商品质量的主观评价。",
    UNVERIFIED_RESULTS_NOT_RECOMMENDED: "当前没有形成证据充分、可以正式推荐的候选。",
    LISTING_LEVEL_IDENTITY_ONLY: "当前只能确认商品页面层级的信息，尚不能完全确认具体型号身份。",
    INDEX_MARKET_NOT_DELIVERY_VERIFIED: "检索市场表示商品被该市场数据源收录，不代表已验证可配送到你的收货地。",
    LOCAL_CANDIDATE_CACHE: "本轮使用了近期缓存的候选数据，实际价格和库存仍应以商家页面为准。",
  };
  if (publicDisclosureMessages[code]) return publicDisclosureMessages[code]!;
  if (code === "PURCHASE_MARKET_SCOPE_ASSUMED") return "你暂未限定购买市场，本轮先检索当前支持的美国和新加坡市场，之后可以继续缩小范围。";
  if (code === "PRODUCT_CONDITION_NOT_RESTRICTED") return "你暂未限定商品成色，本轮不会把全新、翻新或二手作为硬性筛选条件。";
  if (code === "PARTIAL_PROVIDER_COVERAGE") return "部分市场检索未完成；覆盖不完整不代表当地没有销售。";
  if (code === "PROVIDER_UNAVAILABLE") return "本次市场检索均未完成；未取回数据不代表市场中没有销售。";
  if (code === "SEARCH_COVERAGE_UNKNOWN") return "暂无可验证的历史市场检索覆盖记录。";
  const incomplete = /^SEARCH_COVERAGE_INCOMPLETE:([A-Z0-9_-]+(?:,[A-Z0-9_-]+)*)$/.exec(code);
  if (incomplete) {
    const markets = incomplete[1]!.split(",").join("、");
    return `历史检索中 ${markets} 市场的数据未成功返回；这表示覆盖不完整，不代表当地没有销售。`;
  }
  return "部分信息当前无法完整验证。";
}

export function validateAssistantEnvelope(envelope: AssistantEnvelope, context: AssistantEnvelopeContext): AssistantEnvelope {
  if (envelope.blocks.length === 0) throw new DomainError("ASSISTANT_BLOCK_REQUIRED", "At least one assistant block is required");
  const addressed = new Set(envelope.addressedOpIds);
  if (addressed.size !== envelope.addressedOpIds.length) {
    throw new DomainError("DUPLICATE_ADDRESSED_OPERATION", `Addressed operation IDs must be unique: ${envelope.addressedOpIds.join(",")}`);
  }
  for (const operation of context.plan.ops) {
    if (!addressed.has(operation.opId)) {
      throw new DomainError("UNADDRESSED_TURN_OPERATION", `Turn operation was not addressed: ${operation.opId}`);
    }
  }
  for (const opId of addressed) {
    if (!context.plan.ops.some((item) => item.opId === opId)) {
      throw new DomainError("UNKNOWN_ADDRESSED_OPERATION", `Assistant addressed an unknown turn operation: ${opId}`);
    }
  }

  const claims = claimMap(context.groundedClaims);
  const verifyClaim = (claimId: string) => {
    const claim = claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `Claim was not found in the grounded claim set: ${claimId}`);
    if (claim.offerRefs.some((ref) => !context.allowedOfferRefs.has(ref))) {
      throw new DomainError("CLAIM_OFFER_OUTSIDE_WORKING_SET", `Claim references an offer outside the working set: ${claimId}`);
    }
    if (claim.evidenceRefs.length === 0) {
      throw new DomainError("CLAIM_EVIDENCE_REQUIRED", `Grounded claim has no evidence references: ${claimId}`);
    }
  };

  for (const block of envelope.blocks) {
    if (block.type === "TRANSITION") {
      const text = block.text.trim();
      if (!text || text.length > 160) throw new DomainError("INVALID_TRANSITION_TEXT", `Transition text must contain 1-160 characters: ${block.text}`);
      if (transitionContainsFactualData(text)) {
        throw new DomainError("FACTUAL_TRANSITION_NOT_ALLOWED", `FACTUAL_TRANSITION_NOT_ALLOWED: ${text}`);
      }
      if (transitionOverstatesRanking(text)) {
        throw new DomainError("UNSUPPORTED_RANKING_TRANSITION", `UNSUPPORTED_RANKING_TRANSITION: ${text}`);
      }
    } else if (block.type === "CLAIM") {
      verifyClaim(block.claimId);
    } else if (block.type === "COMPARISON") {
      if (block.claimIds.length < 2) throw new DomainError("COMPARISON_REQUIRES_MULTIPLE_CLAIMS", block.claimIds.join(","));
      block.claimIds.forEach(verifyClaim);
    } else if (block.type === "QUESTION") {
      const key = clarificationKey(block.clarification);
      if (!context.allowedClarificationIds.has(block.clarificationId)) throw new DomainError("QUESTION_CLARIFICATION_NOT_ALLOWED", block.clarificationId);
      if (!block.wording.trim()) throw new DomainError("QUESTION_WORDING_REQUIRED", key);
    } else if (!context.allowedDisclosureCodes.has(block.disclosureCode)) {
      throw new DomainError("DISCLOSURE_CODE_NOT_ALLOWED", block.disclosureCode);
    }
  }
  return structuredClone(envelope);
}

export function renderAssistantEnvelope(envelope: AssistantEnvelope, ledger: GroundedClaimSet): string {
  const claims = claimMap(ledger);
  return envelope.blocks
    .map((block) => {
      if (block.type === "TRANSITION") return block.text.trim();
      if (block.type === "CLAIM") return claims.get(block.claimId)?.renderedText ?? "";
      if (block.type === "COMPARISON") return block.claimIds.map((id) => claims.get(id)?.renderedText ?? "").filter(Boolean).join("\n");
      if (block.type === "QUESTION") return block.wording.trim();
      return renderDisclosureCode(block.disclosureCode);
    })
    .filter(Boolean)
    .join("\n\n");
}
