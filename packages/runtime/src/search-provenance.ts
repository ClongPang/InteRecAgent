import { createHash } from "node:crypto";

import {
  createWorkingSet,
  type CandidateView,
  type ClaimEvidenceRef,
  type ComparableOffer,
  type RankedOfferSet,
  type RetrievedListing,
  type SearchCoverage,
  type GroundedClaim,
  type WorkingSet,
} from "@interec/domain";

import type { MarketSearchResult } from "./providers.js";

export const PROVIDER_SCHEMA_VERSION = "buywhere-v1";
export const GROUNDING_POLICY_VERSION = "source-grounding-v3";

export interface NormalizedSourceField {
  sourceFactRef: string;
  offerRef: string | null;
  artifactRef: string;
  factKind: string;
  jsonPath: string;
  canonicalValue: unknown;
  evidenceStatus: "OBSERVED" | "DERIVED" | "UNKNOWN" | "CONFLICTED" | "EXPIRED";
  providerSchemaVersion: string;
  policyVersion: string;
  observedAt: string;
  derivation: "OBSERVED" | "DERIVED";
  fxSnapshotId?: string;
}

export interface SearchProvenanceBundle {
  workingSet: WorkingSet;
  claims: GroundedClaim[];
  sourceFacts: NormalizedSourceField[];
}

function stableHash(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function sourceFactRefFor(input: {
  artifactRef: string;
  jsonPath: string;
  canonicalValue: unknown;
  observedAt: string;
  derivation: "OBSERVED" | "DERIVED";
  fxSnapshotId?: string;
}): string {
  return `fact:${stableHash({
    ...input,
    fxSnapshotId: input.fxSnapshotId ?? null,
    providerSchemaVersion: PROVIDER_SCHEMA_VERSION,
    policyVersion: GROUNDING_POLICY_VERSION,
  })}`;
}

export function candidateRefsHash(offerRefs: readonly string[]): string {
  return stableHash([...offerRefs].sort());
}

function readArtifactPath(payload: unknown, path: string): unknown {
  if (!path.startsWith("$.")) throw new Error(`UNSUPPORTED_EVIDENCE_PATH:${path}`);
  const tokens = path.slice(2).match(/[^.\[\]]+|\[(\d+)\]/g) ?? [];
  let value = payload;
  for (const token of tokens) {
    if (token.startsWith("[")) {
      if (!Array.isArray(value)) return undefined;
      value = value[Number(token.slice(1, -1))];
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      value = (value as Record<string, unknown>)[token];
    }
  }
  return value;
}

function canonicalLeaf(value: unknown): unknown {
  if (value === undefined) throw new Error("EVIDENCE_PATH_NOT_FOUND");
  if (typeof value === "number") return String(value);
  return structuredClone(value);
}

function factFromEvidence(
  offerRef: string,
  factKind: string,
  ref: { artifactRef: string; jsonPath: string; source: string; observedAt: string },
  artifacts: ReadonlyMap<string, MarketSearchResult>,
  derivation: "OBSERVED" | "DERIVED",
  fxSnapshotId?: string,
): NormalizedSourceField {
  const artifact = artifacts.get(ref.artifactRef);
  if (!artifact) throw new Error(`EVIDENCE_ARTIFACT_NOT_FOUND:${ref.artifactRef}`);
  const canonicalValue = canonicalLeaf(readArtifactPath(artifact.rawPayload, ref.jsonPath));
  const sourceFactRef = sourceFactRefFor({
    artifactRef: ref.artifactRef,
    jsonPath: ref.jsonPath,
    canonicalValue,
    observedAt: ref.observedAt,
    derivation,
    ...(fxSnapshotId ? { fxSnapshotId } : {}),
  });
  return {
    sourceFactRef,
    offerRef,
    artifactRef: ref.artifactRef,
    factKind,
    jsonPath: ref.jsonPath,
    canonicalValue,
    evidenceStatus: derivation === "DERIVED" ? "DERIVED" : "OBSERVED",
    providerSchemaVersion: PROVIDER_SCHEMA_VERSION,
    policyVersion: GROUNDING_POLICY_VERSION,
    observedAt: ref.observedAt,
    derivation,
    ...(fxSnapshotId ? { fxSnapshotId } : {}),
  };
}

function claimEvidence(fact: NormalizedSourceField): ClaimEvidenceRef {
  return {
    artifactRef: fact.artifactRef,
    jsonPath: fact.jsonPath,
    source: "buywhere",
    observedAt: fact.observedAt,
    sourceFactRef: fact.sourceFactRef,
    canonicalValue: structuredClone(fact.canonicalValue),
    providerSchemaVersion: fact.providerSchemaVersion,
    policyVersion: fact.policyVersion,
    derivation: fact.derivation,
    ...(fact.fxSnapshotId ? { fxSnapshotId: fact.fxSnapshotId } : {}),
  };
}

function makeClaim(input: Omit<GroundedClaim, "claimId">): GroundedClaim {
  return {
    ...input,
    claimId: `claim:${stableHash([input.kind, input.offerRefs, input.canonicalValue, input.evidenceRefs.map((ref) => ref.sourceFactRef)])}`,
  };
}

function projectionFor(
  eligibility: { offer: ComparableOffer },
  claimIds: string[],
  rankingReasonCodes: string[],
): CandidateView {
  const offer = eligibility.offer;
  return {
    offerRef: offer.offerRef,
    title: offer.title,
    canonicalModel: offer.productIdentity.canonicalModel.value,
    categoryId: offer.validationMode === "SEARCH_ONLY"
      ? offer.targetCategoryId
      : offer.productIdentity.categoryId.value ?? offer.targetCategoryId,
    itemRole: offer.productIdentity.itemRole.value ?? "UNKNOWN",
    condition: offer.condition,
    retrievalMarket: offer.retrievalMarket,
    merchant: offer.merchant,
    cnyAmount: offer.cnyEstimate.amount,
    stock: offer.stock,
    claimIds,
    marketEvidenceLevel: offer.marketEvidence.level,
    rankingReasonCodes,
    ranking: offer.ranking,
    queryProductRelevance: offer.queryProductRelevance,
    candidateAdmission: offer.candidateAdmission,
  };
}

function refsFor(
  listing: RetrievedListing,
  factKind: string,
  refs: readonly { artifactRef: string; jsonPath: string; source: string; observedAt: string }[],
  artifacts: ReadonlyMap<string, MarketSearchResult>,
  derivation: "OBSERVED" | "DERIVED" = "OBSERVED",
  fxSnapshotId?: string,
): NormalizedSourceField[] {
  return refs.flatMap((ref) => {
    try {
      return [factFromEvidence(listing.listingRef, factKind, ref, artifacts, derivation, fxSnapshotId)];
    } catch (error) {
      if (error instanceof Error && error.message === "EVIDENCE_PATH_NOT_FOUND") return [];
      throw error;
    }
  });
}

export function buildSearchProvenanceBundle(input: {
  rankedOfferSet: RankedOfferSet;
  artifacts: readonly MarketSearchResult[];
  coverage: SearchCoverage;
  workingSetVersion: number;
  boundGoalVersion: number;
}): SearchProvenanceBundle {
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.artifactRef, artifact]));
  const claims: GroundedClaim[] = [];
  const facts = new Map<string, NormalizedSourceField>();
  const projections: CandidateView[] = [];
  for (const ranked of input.rankedOfferSet.rankedOffers) {
    const eligibility = input.rankedOfferSet.eligibilityResults.find((item) => item.offer?.offerRef === ranked.offer.offerRef);
    if (!eligibility?.offer) throw new Error(`COMPARABLE_ELIGIBILITY_NOT_FOUND:${ranked.offer.offerRef}`);
    const listing = eligibility.listing;
    const offer = eligibility.offer;
    const claimInputs: Array<{ kind: GroundedClaim["kind"]; canonicalValue: unknown; renderedText: string; sourceFacts: NormalizedSourceField[] }> = [
      {
        kind: "PRICE",
        canonicalValue: { amount: offer.cnyEstimate.amount, currency: "CNY", basis: "FX_ESTIMATE", fxSnapshotId: offer.cnyEstimate.fxSnapshotId },
        renderedText: `${offer.title}：约 ¥${offer.cnyEstimate.amount}`,
        sourceFacts: refsFor(listing, "PRICE", listing.originalMoney.evidence, artifacts, "DERIVED", offer.cnyEstimate.fxSnapshotId),
      },
      {
        kind: "MERCHANT",
        canonicalValue: offer.merchant,
        renderedText: `商家：${offer.merchant}`,
        sourceFacts: refsFor(listing, "MERCHANT", listing.merchantLabel.evidence, artifacts),
      },
      {
        kind: "MARKET",
        canonicalValue: offer.retrievalMarket,
        renderedText: `检索市场：${offer.retrievalMarket}`,
        sourceFacts: refsFor(listing, "MARKET", offer.marketEvidence.evidence, artifacts, offer.marketEvidence.level === "TARGET_DOMAIN_MARKET_CONSISTENT" ? "DERIVED" : "OBSERVED"),
      },
      {
        kind: "STOCK",
        canonicalValue: offer.stock,
        renderedText: `库存状态：${offer.stock}`,
        sourceFacts: refsFor(listing, "STOCK", listing.stock.evidence, artifacts),
      },
      {
        kind: "CONDITION",
        canonicalValue: offer.condition,
        renderedText: `成色：${offer.condition}`,
        sourceFacts: refsFor(listing, "CONDITION", listing.identity.condition.evidence, artifacts, "DERIVED"),
      },
      {
        kind: "RANKING_REASON",
        canonicalValue: ranked.rankingReasonCodes,
        renderedText: `当前排序依据：${ranked.rankingReasonCodes.join("、")}`,
        sourceFacts: [
          ...refsFor(listing, "MARKET", offer.marketEvidence.evidence, artifacts, offer.marketEvidence.level === "TARGET_DOMAIN_MARKET_CONSISTENT" ? "DERIVED" : "OBSERVED"),
          ...refsFor(listing, "STOCK", listing.stock.evidence, artifacts),
          ...refsFor(listing, "PRICE", listing.originalMoney.evidence, artifacts, "DERIVED", offer.cnyEstimate.fxSnapshotId),
        ],
      },
    ];
    if (offer.productIdentity.canonicalModel.value) {
      claimInputs.push({
        kind: "MODEL",
        canonicalValue: offer.productIdentity.canonicalModel.value,
        renderedText: `型号：${offer.productIdentity.canonicalModel.value}`,
        sourceFacts: refsFor(listing, "MODEL", listing.identity.canonicalModel.evidence, artifacts, "DERIVED"),
      });
    }
    const offerClaims = claimInputs.filter((claimInput) => claimInput.sourceFacts.length > 0).map((claimInput) => {
      for (const fact of claimInput.sourceFacts) facts.set(fact.sourceFactRef, fact);
      return makeClaim({
        kind: claimInput.kind,
        canonicalValue: claimInput.canonicalValue,
        renderedText: claimInput.renderedText,
        evidenceRefs: claimInput.sourceFacts.map(claimEvidence),
        offerRefs: [offer.offerRef],
      });
    });
    claims.push(...offerClaims);
    projections.push(projectionFor({ offer }, offerClaims.map((claim) => claim.claimId), ranked.rankingReasonCodes));
  }
  return {
    workingSet: createWorkingSet({
      version: input.workingSetVersion,
      boundGoalVersion: input.boundGoalVersion,
      pool: projections,
      displayOfferRefs: input.rankedOfferSet.rankedOffers.map((item) => item.offer.offerRef),
    }),
    claims,
    sourceFacts: [...facts.values()],
  };
}
