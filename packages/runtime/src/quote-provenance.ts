import { createHash } from "node:crypto";

import type { QuoteLeadSet, QuoteObservation } from "@retail-price/domain";

export const QUOTE_PROVENANCE_POLICY_VERSION = "quote-provenance-v1" as const;

export type QuoteSourceFactKind =
  | "TITLE"
  | "ORIGINAL_PRICE"
  | "MERCHANT_TARGET_URL"
  | "OUTBOUND_URL"
  | "CONDITION"
  | "SYSTEM_OBSERVED_AT"
  | "PROVIDER_UPDATED_AT";

export interface QuoteSourceFact {
  sourceFactRef: string;
  quoteLeadRef: string;
  observationRef: string;
  artifactRef: string;
  factKind: QuoteSourceFactKind;
  jsonPath: string;
  canonicalValue: unknown;
  evidenceStatus: "OBSERVED" | "DERIVED";
  observedAt: string;
  derivation: "OBSERVED" | "DERIVED";
  policyVersion: typeof QUOTE_PROVENANCE_POLICY_VERSION;
}

export interface QuoteClaimEvidenceRef {
  sourceFactRef: string;
  fxSnapshotId: string | null;
}

export interface QuoteGroundedClaim {
  claimRef: string;
  quoteLeadRef: string;
  kind:
    | "TITLE"
    | "ORIGINAL_PRICE_RANGE"
    | "CNY_ESTIMATE_RANGE"
    | "MERCHANT_DOMAIN"
    | "MERCHANT_TARGET_URL"
    | "OUTBOUND_URL"
    | "CONDITION"
    | "OBSERVATION_COUNT"
    | "OBSERVED_AT_RANGE"
    | "PROVIDER_UPDATED_AT";
  canonicalValue: unknown;
  evidenceRefs: QuoteClaimEvidenceRef[];
}

export interface QuoteProvenanceBundle {
  policyVersion: typeof QUOTE_PROVENANCE_POLICY_VERSION;
  sourceFacts: QuoteSourceFact[];
  claims: QuoteGroundedClaim[];
}

function factRef(leadRef: string, observationRef: string, kind: QuoteSourceFactKind): string {
  return `qf_${createHash("sha256").update(`${leadRef}\u0000${observationRef}\u0000${kind}`).digest("hex").slice(0, 24)}`;
}

function claimRef(leadRef: string, kind: QuoteGroundedClaim["kind"], discriminator = ""): string {
  return `qc_${createHash("sha256").update(`${leadRef}\u0000${kind}\u0000${discriminator}`).digest("hex").slice(0, 24)}`;
}

function recordPath(observation: QuoteObservation, preferred: readonly string[]): string {
  const selected = preferred.find((key) => Object.hasOwn(observation.rawRecord, key));
  return `${observation.jsonPath}.${selected ?? preferred[0]}`;
}

function factsForObservation(quoteLeadRef: string, observation: QuoteObservation): QuoteSourceFact[] {
  const values: Array<{ kind: QuoteSourceFactKind; value: unknown; path: string; derivation: "OBSERVED" | "DERIVED" }> = [];
  if (observation.title !== null) values.push({ kind: "TITLE", value: observation.title, path: `${observation.jsonPath}.title`, derivation: "OBSERVED" });
  if (observation.originalMoney !== null) values.push({ kind: "ORIGINAL_PRICE", value: observation.originalMoney, path: `${observation.jsonPath}.price`, derivation: "OBSERVED" });
  if (observation.merchantTargetUrl !== null) values.push({ kind: "MERCHANT_TARGET_URL", value: observation.merchantTargetUrl, path: recordPath(observation, ["url", "merchant_url"]), derivation: "OBSERVED" });
  if (observation.outboundUrl !== null) values.push({ kind: "OUTBOUND_URL", value: observation.outboundUrl, path: recordPath(observation, ["outbound_url", "click_url", "url"]), derivation: "OBSERVED" });
  values.push({ kind: "CONDITION", value: observation.condition, path: recordPath(observation, ["condition", "title"]), derivation: "DERIVED" });
  values.push({ kind: "SYSTEM_OBSERVED_AT", value: observation.observedAt, path: "$.__system.observed_at", derivation: "OBSERVED" });
  if (observation.providerUpdatedAt !== null) values.push({ kind: "PROVIDER_UPDATED_AT", value: observation.providerUpdatedAt, path: `${observation.jsonPath}.updated_at`, derivation: "OBSERVED" });
  return values.map((value) => ({
    sourceFactRef: factRef(quoteLeadRef, observation.observationRef, value.kind),
    quoteLeadRef,
    observationRef: observation.observationRef,
    artifactRef: observation.artifactRef,
    factKind: value.kind,
    jsonPath: value.path,
    canonicalValue: structuredClone(value.value),
    evidenceStatus: value.derivation,
    observedAt: observation.observedAt,
    derivation: value.derivation,
    policyVersion: QUOTE_PROVENANCE_POLICY_VERSION,
  }));
}

function evidence(facts: readonly QuoteSourceFact[], kind: QuoteSourceFactKind, observationRefs?: readonly string[]): QuoteClaimEvidenceRef[] {
  const allowed = observationRefs ? new Set(observationRefs) : null;
  return facts
    .filter((fact) => fact.factKind === kind && (!allowed || allowed.has(fact.observationRef)))
    .map((fact) => ({ sourceFactRef: fact.sourceFactRef, fxSnapshotId: null }));
}

export function buildQuoteProvenance(leadSet: QuoteLeadSet): QuoteProvenanceBundle {
  const observationByRef = new Map(leadSet.observations.map((observation) => [observation.observationRef, observation]));
  const sourceFacts: QuoteSourceFact[] = [];
  const claims: QuoteGroundedClaim[] = [];
  for (const lead of leadSet.leads) {
    const observations = lead.observationRefs.map((ref) => observationByRef.get(ref)).filter((value): value is QuoteObservation => Boolean(value));
    if (observations.length !== lead.observationRefs.length) throw new Error("QUOTE_LEAD_OBSERVATION_NOT_FOUND");
    const leadFacts = observations.flatMap((observation) => factsForObservation(lead.quoteLeadRef, observation));
    sourceFacts.push(...leadFacts);
    const firstObservationRef = lead.observationRefs[0]!;
    claims.push(
      {
        claimRef: claimRef(lead.quoteLeadRef, "TITLE"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "TITLE",
        canonicalValue: lead.representativeTitle,
        evidenceRefs: evidence(leadFacts, "TITLE", [firstObservationRef]),
      },
      {
        claimRef: claimRef(lead.quoteLeadRef, "MERCHANT_DOMAIN"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "MERCHANT_DOMAIN",
        canonicalValue: lead.merchantDomain,
        evidenceRefs: evidence(leadFacts, "MERCHANT_TARGET_URL"),
      },
      {
        claimRef: claimRef(lead.quoteLeadRef, "MERCHANT_TARGET_URL"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "MERCHANT_TARGET_URL",
        canonicalValue: lead.merchantTargetUrl,
        evidenceRefs: evidence(leadFacts, "MERCHANT_TARGET_URL"),
      },
      {
        claimRef: claimRef(lead.quoteLeadRef, "OUTBOUND_URL"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "OUTBOUND_URL",
        canonicalValue: lead.outboundUrl,
        evidenceRefs: evidence(leadFacts, "OUTBOUND_URL", [firstObservationRef]),
      },
      {
        claimRef: claimRef(lead.quoteLeadRef, "CONDITION"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "CONDITION",
        canonicalValue: lead.condition,
        evidenceRefs: evidence(leadFacts, "CONDITION"),
      },
      {
        claimRef: claimRef(lead.quoteLeadRef, "OBSERVATION_COUNT"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "OBSERVATION_COUNT",
        canonicalValue: lead.observationCount,
        evidenceRefs: evidence(leadFacts, "SYSTEM_OBSERVED_AT"),
      },
      {
        claimRef: claimRef(lead.quoteLeadRef, "OBSERVED_AT_RANGE"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "OBSERVED_AT_RANGE",
        canonicalValue: { first: lead.firstObservedAt, latest: lead.latestObservedAt },
        evidenceRefs: evidence(leadFacts, "SYSTEM_OBSERVED_AT"),
      },
    );
    if (lead.latestProviderUpdatedAt !== null) {
      claims.push({
        claimRef: claimRef(lead.quoteLeadRef, "PROVIDER_UPDATED_AT"),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "PROVIDER_UPDATED_AT",
        canonicalValue: lead.latestProviderUpdatedAt,
        evidenceRefs: evidence(leadFacts, "PROVIDER_UPDATED_AT"),
      });
    }
    for (const range of lead.priceRanges) {
      const originalEvidence = evidence(leadFacts, "ORIGINAL_PRICE", range.observationRefs);
      claims.push({
        claimRef: claimRef(lead.quoteLeadRef, "ORIGINAL_PRICE_RANGE", range.currency),
        quoteLeadRef: lead.quoteLeadRef,
        kind: "ORIGINAL_PRICE_RANGE",
        canonicalValue: { currency: range.currency, minAmount: range.minAmount, maxAmount: range.maxAmount },
        evidenceRefs: originalEvidence,
      });
      if (range.cnyEstimate) {
        claims.push({
          claimRef: claimRef(lead.quoteLeadRef, "CNY_ESTIMATE_RANGE", range.currency),
          quoteLeadRef: lead.quoteLeadRef,
          kind: "CNY_ESTIMATE_RANGE",
          canonicalValue: {
            currency: "CNY",
            minAmount: range.cnyEstimate.minAmount,
            maxAmount: range.cnyEstimate.maxAmount,
            fxObservedAt: range.cnyEstimate.fxObservedAt,
          },
          evidenceRefs: originalEvidence.map((item) => ({ ...item, fxSnapshotId: range.cnyEstimate!.fxSnapshotId })),
        });
      }
    }
  }
  const factRefs = new Set(sourceFacts.map((fact) => fact.sourceFactRef));
  if (claims.some((claim) => claim.evidenceRefs.length === 0 || claim.evidenceRefs.some((item) => !factRefs.has(item.sourceFactRef)))) {
    throw new Error("QUOTE_PROVENANCE_INCOMPLETE");
  }
  return { policyVersion: QUOTE_PROVENANCE_POLICY_VERSION, sourceFacts, claims };
}
