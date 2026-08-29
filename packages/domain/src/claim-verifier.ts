import { DomainError } from "./errors.js";
import { canonicalDecimal } from "./money.js";
import { renderDisclosureCode } from "./assistant-envelope.js";
import type { AssistantEnvelope, ClaimEvidenceRef, ClaimLedger, VerifiedClaim, WorkingSet } from "./conversation-types.js";

export interface ClaimVerifierContext {
  workingSet: WorkingSet;
  allowedEvidenceRefs?: ReadonlySet<string>;
  envelope?: AssistantEnvelope;
  renderedDraft?: string;
}

function required(value: string, code: string, description: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainError(code, description);
  return normalized;
}

export function claimEvidenceKey(ref: Pick<ClaimEvidenceRef, "artifactRef" | "jsonPath" | "sourceFactRef">): string {
  return `${ref.artifactRef}:${ref.jsonPath}:${ref.sourceFactRef}`;
}

function verifyEvidence(claim: VerifiedClaim, allowedEvidenceRefs?: ReadonlySet<string>): void {
  if (claim.evidenceRefs.length === 0) {
    throw new DomainError("CLAIM_EVIDENCE_REQUIRED", `Claim has no evidence: ${claim.claimId}`);
  }
  const keys = new Set<string>();
  for (const ref of claim.evidenceRefs) {
    required(ref.artifactRef, "INVALID_EVIDENCE_REF", `Evidence artifact is missing for claim ${claim.claimId}`);
    required(ref.jsonPath, "INVALID_EVIDENCE_REF", `Evidence JSON path is missing for claim ${claim.claimId}`);
    required(ref.source, "INVALID_EVIDENCE_REF", `Evidence provider is missing for claim ${claim.claimId}`);
    required(ref.sourceFactRef, "INVALID_EVIDENCE_REF", `Source fact is missing for claim ${claim.claimId}`);
    required(ref.providerSchemaVersion, "INVALID_EVIDENCE_REF", `Provider schema version is missing for claim ${claim.claimId}`);
    required(ref.policyVersion, "INVALID_EVIDENCE_REF", `Evidence policy version is missing for claim ${claim.claimId}`);
    if (!Number.isFinite(Date.parse(ref.observedAt))) {
      throw new DomainError("INVALID_EVIDENCE_TIMESTAMP", `Evidence timestamp is invalid for claim ${claim.claimId}`);
    }
    if (ref.canonicalValue === undefined) {
      throw new DomainError("EVIDENCE_CANONICAL_VALUE_REQUIRED", `Evidence canonical value is missing for claim ${claim.claimId}`);
    }
    const key = claimEvidenceKey(ref);
    if (keys.has(key)) throw new DomainError("DUPLICATE_CLAIM_EVIDENCE", `Claim contains duplicate evidence: ${key}`);
    if (allowedEvidenceRefs && !allowedEvidenceRefs.has(key)) {
      throw new DomainError("EVIDENCE_OUTSIDE_ATTEMPT", `Claim evidence is outside the committed attempt: ${key}`);
    }
    keys.add(key);
  }
}

function asRecord(value: unknown, claimId: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_CLAIM_VALUE", `Claim value must be an object: ${claimId}`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, claimId: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("INVALID_CLAIM_VALUE", `Claim value must be a non-empty string: ${claimId}`);
  }
  return value;
}

function verifyCandidateFact(claim: VerifiedClaim, workingSet: WorkingSet): void {
  if (claim.kind === "FX") {
    const value = asRecord(claim.canonicalValue, claim.claimId);
    const snapshotId = exactString(value["snapshotId"], claim.claimId);
    exactString(value["base"], claim.claimId);
    exactString(value["quote"], claim.claimId);
    canonicalDecimal(exactString(value["rate"], claim.claimId));
    if (!claim.evidenceRefs.some((ref) => ref.fxSnapshotId === snapshotId)) {
      throw new DomainError("FX_EVIDENCE_REQUIRED", `FX claim lacks its snapshot evidence: ${claim.claimId}`);
    }
    return;
  }
  if (claim.kind === "RESEARCH_STATUS") {
    exactString(claim.canonicalValue, claim.claimId);
    return;
  }
  if (claim.offerRefs.length === 0) {
    throw new DomainError("CLAIM_OFFER_REQUIRED", `Offer-scoped claim has no offer reference: ${claim.claimId}`);
  }
  const candidates = claim.offerRefs.map((offerRef) => {
    const candidate = workingSet.pool.find((item) => item.offerRef === offerRef);
    if (!candidate) throw new DomainError("CLAIM_OFFER_OUTSIDE_WORKING_SET", `Claim references an offer outside the working set: ${offerRef}`);
    if (workingSet.rejectedOfferRefs.includes(offerRef)) {
      throw new DomainError("CLAIM_REFERENCES_REJECTED_OFFER", `Claim references a rejected offer: ${offerRef}`);
    }
    if (!candidate.claimIds.includes(claim.claimId)) {
      throw new DomainError("CLAIM_NOT_BOUND_TO_OFFER", `Claim is not bound to the working-set offer: ${claim.claimId}:${offerRef}`);
    }
    return candidate;
  });

  if (claim.kind === "PRICE") {
    const value = asRecord(claim.canonicalValue, claim.claimId);
    const amount = canonicalDecimal(exactString(value["amount"], claim.claimId));
    const currency = exactString(value["currency"], claim.claimId).toUpperCase();
    if (currency === "CNY" && candidates.some((candidate) => canonicalDecimal(candidate.cnyAmount) !== amount)) {
      throw new DomainError("PRICE_CLAIM_MISMATCH", `CNY price claim does not match its working-set offer: ${claim.claimId}`);
    }
    if (value["basis"] === "FX_ESTIMATE") {
      const snapshotId = exactString(value["fxSnapshotId"], claim.claimId);
      if (!claim.evidenceRefs.some((ref) => ref.fxSnapshotId === snapshotId && ref.derivation === "DERIVED")) {
        throw new DomainError("FX_EVIDENCE_REQUIRED", `FX-derived price claim lacks its FX snapshot: ${claim.claimId}`);
      }
    }
    return;
  }

  if (claim.kind === "RANKING_REASON") {
    if (!Array.isArray(claim.canonicalValue)
      || claim.canonicalValue.length === 0
      || claim.canonicalValue.some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new DomainError("INVALID_CLAIM_VALUE", `Ranking-reason claim value must be a non-empty string array: ${claim.claimId}`);
    }
    const expected = claim.canonicalValue.map((value) => value.trim());
    if (candidates.some((candidate) => JSON.stringify(candidate.rankingReasonCodes ?? []) !== JSON.stringify(expected))) {
      throw new DomainError("CLAIM_VALUE_MISMATCH", `Ranking-reason claim does not match its working-set offer: ${claim.claimId}`);
    }
    return;
  }

  const expected = exactString(claim.canonicalValue, claim.claimId);
  const values = candidates.map((candidate) => {
    switch (claim.kind) {
      case "MERCHANT": return candidate.merchant;
      case "MARKET": return candidate.retrievalMarket;
      case "STOCK": return candidate.stock;
      case "MODEL": return candidate.canonicalModel;
      case "CONDITION": return candidate.condition;
      default: return expected;
    }
  });
  if (values.some((value) => value === null || value !== expected)) {
    throw new DomainError("CLAIM_VALUE_MISMATCH", `Claim value does not match its working-set offer: ${claim.claimId}`);
  }
}

function verifyComparisonBlocks(ledger: ClaimLedger, context: ClaimVerifierContext): void {
  if (!context.envelope) return;
  const claims = new Map(ledger.claims.map((claim) => [claim.claimId, claim]));
  for (const block of context.envelope.blocks) {
    if (block.type !== "COMPARISON") continue;
    const offerRefs = [...new Set(block.claimIds.flatMap((claimId) => claims.get(claimId)?.offerRefs ?? []))];
    if (offerRefs.length < 2) {
      throw new DomainError("COMPARISON_REQUIRES_MULTIPLE_OFFERS", "A comparison block must be grounded in at least two offers");
    }
    const scopes = offerRefs.map((offerRef) => {
      const candidate = context.workingSet.pool.find((item) => item.offerRef === offerRef);
      if (!candidate) throw new DomainError("CLAIM_OFFER_OUTSIDE_WORKING_SET", `Comparison references an offer outside the working set: ${offerRef}`);
      return `${candidate.categoryId}:${candidate.itemRole}`;
    });
    if (new Set(scopes).size !== 1) {
      throw new DomainError("COMPARISON_SCOPE_MISMATCH", `Comparison offers do not share a proof-qualified category and item role: ${offerRefs.join(",")}`);
    }
  }
}

export function verifyClaimLedger(ledger: ClaimLedger, context: ClaimVerifierContext): ClaimLedger {
  const ids = ledger.claims.map((claim) => required(claim.claimId, "INVALID_CLAIM_ID", "Claim ID is required"));
  if (new Set(ids).size !== ids.length) throw new DomainError("DUPLICATE_CLAIM_ID", `Claim IDs must be unique: ${ids.join(",")}`);

  for (const claim of ledger.claims) {
    required(claim.renderedText, "CLAIM_RENDERED_TEXT_REQUIRED", `Rendered claim text is required: ${claim.claimId}`);
    verifyEvidence(claim, context.allowedEvidenceRefs);
    verifyCandidateFact(claim, context.workingSet);
  }
  verifyComparisonBlocks(ledger, context);

  if (context.envelope && context.renderedDraft !== undefined) {
    const byId = new Map(ledger.claims.map((claim) => [claim.claimId, claim]));
    const rendered = context.envelope.blocks.map((block) => {
      if (block.type === "TRANSITION") return block.text.trim();
      if (block.type === "CLAIM") return byId.get(block.claimId)?.renderedText.trim() ?? "";
      if (block.type === "COMPARISON") return block.claimIds.map((id) => byId.get(id)?.renderedText.trim() ?? "").filter(Boolean).join("\n");
      if (block.type === "QUESTION") return block.wording.trim();
      return renderDisclosureCode(block.disclosureCode);
    }).filter(Boolean).join("\n\n");
    if (rendered !== context.renderedDraft.trim()) {
      throw new DomainError("ASSISTANT_DRAFT_MISMATCH", "Assistant draft differs from the deterministic claim rendering");
    }
  }
  return structuredClone(ledger);
}
