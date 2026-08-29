import { DomainError } from "./errors.js";
import type { AssistantEnvelope, ClaimLedger, TurnPlan, VerifiedClaim } from "./conversation-types.js";

export interface AssistantEnvelopeContext {
  plan: TurnPlan;
  claimLedger: ClaimLedger;
  allowedOfferRefs: ReadonlySet<string>;
  allowedQuestionSlotIds: ReadonlySet<string>;
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

function claimMap(ledger: ClaimLedger): Map<string, VerifiedClaim> {
  const ids = ledger.claims.map((item) => item.claimId);
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("DUPLICATE_CLAIM_ID", `Claim ledger contains duplicate IDs: ${ids.join(",")}`);
  }
  return new Map(ledger.claims.map((item) => [item.claimId, item]));
}

export function renderDisclosureCode(code: string): string {
  if (code === "WARRANTY_UNKNOWN") return "保修信息：暂无可验证证据";
  if (code === "PARTIAL_PROVIDER_COVERAGE") return "部分市场检索未完成；覆盖不完整不代表当地没有销售。";
  if (code === "PROVIDER_UNAVAILABLE") return "本次市场检索均未完成；未取回数据不代表市场中没有销售。";
  if (code === "RESEARCH_COVERAGE_UNKNOWN") return "暂无可验证的历史市场检索覆盖记录。";
  const incomplete = /^RESEARCH_COVERAGE_INCOMPLETE:([A-Z0-9_-]+(?:,[A-Z0-9_-]+)*)$/.exec(code);
  if (incomplete) {
    const markets = incomplete[1]!.split(",").join("、");
    return `历史检索中 ${markets} 市场的数据未成功返回；这表示覆盖不完整，不代表当地没有销售。`;
  }
  return code;
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

  const claims = claimMap(context.claimLedger);
  const verifyClaim = (claimId: string) => {
    const claim = claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `Claim was not found in the verified ledger: ${claimId}`);
    if (claim.offerRefs.some((ref) => !context.allowedOfferRefs.has(ref))) {
      throw new DomainError("CLAIM_OFFER_OUTSIDE_WORKING_SET", `Claim references an offer outside the working set: ${claimId}`);
    }
    if (claim.evidenceRefs.length === 0) {
      throw new DomainError("CLAIM_EVIDENCE_REQUIRED", `Verified claim has no evidence references: ${claimId}`);
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
      if (!context.allowedQuestionSlotIds.has(block.slotId)) throw new DomainError("QUESTION_SLOT_NOT_ALLOWED", block.slotId);
      if (!block.wording.trim()) throw new DomainError("QUESTION_WORDING_REQUIRED", block.slotId);
    } else if (!context.allowedDisclosureCodes.has(block.disclosureCode)) {
      throw new DomainError("DISCLOSURE_CODE_NOT_ALLOWED", block.disclosureCode);
    }
  }
  return structuredClone(envelope);
}

export function renderAssistantEnvelope(envelope: AssistantEnvelope, ledger: ClaimLedger): string {
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
