import {
  identityLexicalKey,
  type QuotePlanPolicyViolation,
  type QuoteTargetProposal,
} from "@retail-price/domain";

export interface IdentitySourceSpan {
  start: number;
  end: number;
}

export interface IdentitySourceClaim {
  value: string;
  span: IdentitySourceSpan;
}

/** Model-authored semantics only; every authority-bearing value is revalidated by the host. */
export interface IdentityHypothesis {
  sourceMessageOrdinal: number;
  model: IdentitySourceClaim;
  brand: IdentitySourceClaim | null;
  productType: IdentitySourceClaim | null;
  qualifiers: IdentitySourceClaim[];
  selectedVariantRef: string | null;
  confidence: number | null;
}

export interface IdentityCandidateView {
  registryVersion: number;
  brandRef: string;
  productRef: string;
  variantRef: string;
  canonicalModel: string;
  evidenceRefs: string[];
}

export interface IdentityHypothesisOperationView {
  opId: string;
  kind: "SET_QUOTE_TARGET";
  sourceMessageOrdinal: number;
  target: QuoteTargetProposal;
  identityHypothesis?: IdentityHypothesis;
}

function violation(operation: IdentityHypothesisOperationView, code: string, path: string, observed: unknown, alternative: string): QuotePlanPolicyViolation {
  return {
    code,
    operationId: operation.opId,
    path: `ops.${operation.opId}.identityHypothesis.${path}`,
    observed,
    admissibleAlternatives: [alternative],
  };
}

function validateClaim(
  operation: IdentityHypothesisOperationView,
  claim: IdentitySourceClaim,
  rawText: string,
  path: string,
): QuotePlanPolicyViolation[] {
  const span = claim?.span;
  if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
    || span.start < 0 || span.end <= span.start || span.end > rawText.length) {
    return [violation(operation, "IDENTITY_SOURCE_SPAN_INVALID", `${path}.span`, span, "Cite an exact in-bounds span from the current user message.")];
  }
  const cited = rawText.slice(span.start, span.end).normalize("NFKC");
  const value = String(claim.value ?? "").normalize("NFKC");
  if (!value.trim() || cited !== value) {
    return [violation(operation, "IDENTITY_SOURCE_TEXT_MISMATCH", path, { cited, value }, "Copy the exact source substring and its offsets without rewriting it.")];
  }
  return [];
}

function sameClaim(targetValue: string | null, claim: IdentitySourceClaim | null): boolean {
  if (targetValue === null) return claim === null;
  return claim !== null && identityLexicalKey(targetValue) === identityLexicalKey(claim.value);
}

function qualifiersMatch(targetValues: readonly string[], claims: readonly IdentitySourceClaim[]): boolean {
  const expected = [...new Set(targetValues.map(identityLexicalKey))].sort();
  const actual = [...new Set(claims.map((claim) => identityLexicalKey(claim.value)))].sort();
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function overlappingClaims(claims: readonly IdentitySourceClaim[]): boolean {
  const ordered = [...claims].sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  return ordered.some((claim, index) => index > 0 && claim.span.start < ordered[index - 1]!.span.end);
}

export function validateIdentityCandidates(candidates: readonly IdentityCandidateView[]): IdentityCandidateView[] {
  const values = structuredClone(candidates);
  const refs = values.map((candidate) => candidate.variantRef.normalize("NFKC").trim());
  if (refs.some((ref) => !ref) || new Set(refs).size !== refs.length) throw new Error("IDENTITY_CANDIDATE_ALLOWLIST_INVALID");
  for (const candidate of values) {
    if (!Number.isSafeInteger(candidate.registryVersion) || candidate.registryVersion < 1
      || !candidate.brandRef.trim() || !candidate.productRef.trim() || !candidate.canonicalModel.trim()
      || candidate.evidenceRefs.length === 0) {
      throw new Error("IDENTITY_CANDIDATE_ALLOWLIST_INVALID");
    }
  }
  return [...values];
}

function exactClaim(rawText: string, value: string): IdentitySourceClaim {
  const start = rawText.indexOf(value);
  if (start < 0) throw new Error(`IDENTITY_FIXTURE_TEXT_NOT_FOUND:${value}`);
  return { value, span: { start, end: start + value.length } };
}

/** Deterministic exact-text path used by non-LLM callers and eval fixtures; it cannot infer or rewrite a claim. */
export function createLexicallyGroundedIdentityHypothesis(
  rawText: string,
  sourceMessageOrdinal: number,
  target: QuoteTargetProposal,
  selectedVariantRef: string | null = null,
): IdentityHypothesis {
  return {
    sourceMessageOrdinal,
    model: exactClaim(rawText, target.proposedModel),
    brand: target.brand ? exactClaim(rawText, target.brand) : null,
    productType: target.productType ? exactClaim(rawText, target.productType) : null,
    qualifiers: target.requiredQualifiers.map((qualifier) => exactClaim(rawText, qualifier)),
    selectedVariantRef,
    confidence: null,
  };
}

export function reviewIdentityHypothesis(
  operation: IdentityHypothesisOperationView,
  currentUserMessages: readonly string[],
  candidatesInput: readonly IdentityCandidateView[],
  providerOperationRequested: boolean,
): QuotePlanPolicyViolation[] {
  const hypothesis = operation.identityHypothesis;
  if (!hypothesis) return [violation(operation, "IDENTITY_HYPOTHESIS_REQUIRED", "", null, "Provide source-spanned identity claims for SET_QUOTE_TARGET.")];
  const rawText = currentUserMessages[hypothesis.sourceMessageOrdinal];
  if (rawText === undefined || hypothesis.sourceMessageOrdinal !== operation.sourceMessageOrdinal) {
    return [violation(operation, "IDENTITY_SOURCE_MESSAGE_MISMATCH", "sourceMessageOrdinal", hypothesis.sourceMessageOrdinal, "Use the same current message ordinal as SET_QUOTE_TARGET.")];
  }
  const claims = [hypothesis.model, ...(hypothesis.brand ? [hypothesis.brand] : []), ...(hypothesis.productType ? [hypothesis.productType] : []), ...hypothesis.qualifiers];
  const failures = claims.flatMap((claim, index) => validateClaim(operation, claim, rawText, `claims.${index}`));
  if (overlappingClaims(claims)) failures.push(violation(operation, "IDENTITY_SOURCE_SPANS_OVERLAP", "claims", claims, "Use non-overlapping source spans for model, brand, product type, and qualifiers."));
  if (!sameClaim(operation.target.brand, hypothesis.brand)) failures.push(violation(operation, "IDENTITY_BRAND_CLAIM_MISMATCH", "brand", hypothesis.brand, "Keep brand null or copy the exact grounded brand claim."));
  if (!sameClaim(operation.target.productType, hypothesis.productType)) failures.push(violation(operation, "IDENTITY_PRODUCT_TYPE_CLAIM_MISMATCH", "productType", hypothesis.productType, "Keep productType null or copy the exact grounded product-type claim."));
  if (!qualifiersMatch(operation.target.requiredQualifiers, hypothesis.qualifiers)) failures.push(violation(operation, "IDENTITY_QUALIFIER_CLAIM_MISMATCH", "qualifiers", hypothesis.qualifiers, "Every required qualifier must have one exact source span."));

  const modelChanged = identityLexicalKey(operation.target.proposedModel) !== identityLexicalKey(hypothesis.model.value);
  if (modelChanged && providerOperationRequested) {
    failures.push(violation(operation, "IDENTITY_LOOKUP_REQUIRES_MODEL_LITERAL", "model", {
      literal: hypothesis.model.value,
      proposed: operation.target.proposedModel,
    }, "Remove the Provider operation and ask for confirmation, or use the exact source model literal."));
  }
  const candidates = validateIdentityCandidates(candidatesInput);
  if (hypothesis.selectedVariantRef) {
    const selected = candidates.find((candidate) => candidate.variantRef === hypothesis.selectedVariantRef);
    if (!selected) failures.push(violation(operation, "IDENTITY_CANDIDATE_NOT_ALLOWED", "selectedVariantRef", hypothesis.selectedVariantRef, "Choose only a variantRef present in identityCandidates, or use null."));
    else if (identityLexicalKey(selected.canonicalModel) !== identityLexicalKey(operation.target.proposedModel)) {
      failures.push(violation(operation, "IDENTITY_CANDIDATE_MODEL_CONFLICT", "selectedVariantRef", {
        selected: selected.canonicalModel,
        proposed: operation.target.proposedModel,
      }, "Use the selected host candidate's canonical model only as a clarification proposal."));
    }
  }
  if (hypothesis.confidence !== null && (!Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1)) {
    failures.push(violation(operation, "IDENTITY_CONFIDENCE_INVALID", "confidence", hypothesis.confidence, "Use null or a finite informational value from 0 to 1."));
  }
  return failures;
}
