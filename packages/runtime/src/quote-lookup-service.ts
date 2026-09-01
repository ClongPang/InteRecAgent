import { createHash } from "node:crypto";

import {
  QUOTE_LEAD_CONTRACT_VERSION,
  admitQuoteObservation,
  convertToCny,
  createQuoteObservation,
  groupQuoteObservations,
  type FxSnapshot,
  type ProductIdentitySnapshot,
  type QuoteLead,
  type QuoteLeadSet,
  type QuoteProviderSummary,
  type QuoteTargetResolution,
} from "@interec/domain";

import type { FxPort } from "./fx-provider.js";
import { recordIdentityResolution } from "./identity-resolution-observability.js";
import type { QuoteProvider, QuoteProviderResult } from "./quote-provider.js";

export interface QuoteLookupArtifact {
  artifactRef: string;
  provider: "buywhere";
  providerContractVersion: string;
  payloadSha256: string;
  rawPayload: unknown;
  observedAt: string;
}

export type QuoteLookupExecution =
  | {
      status: "TARGET_CONFIRMATION_REQUIRED";
      reasonCodes: string[];
      leadSet: null;
      artifact: null;
    }
  | {
      status: "LOOKUP_COMPLETED";
      reasonCodes: string[];
      leadSet: QuoteLeadSet;
      artifact: QuoteLookupArtifact;
    };

function canonicalPayload(value: unknown): string {
  return JSON.stringify(value);
}

function payloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalPayload(value)).digest("hex");
}

function artifactFrom(result: QuoteProviderResult): QuoteLookupArtifact {
  const sha = payloadSha256(result.rawPayload);
  const expected = `sha256:${sha}`;
  if (result.artifactRef !== null && result.artifactRef !== expected) throw new Error("QUOTE_PROVIDER_ARTIFACT_HASH_MISMATCH");
  return {
    artifactRef: expected,
    provider: "buywhere",
    providerContractVersion: result.providerContractVersion,
    payloadSha256: sha,
    rawPayload: structuredClone(result.rawPayload),
    observedAt: new Date(result.observedAt).toISOString(),
  };
}

function providerSummary(result: QuoteProviderResult): QuoteProviderSummary {
  return {
    status: result.status,
    failureCode: result.failure?.code ?? null,
    retryable: result.failure?.retryable ?? null,
    contractVersion: result.providerContractVersion,
    meta: {
      status: result.meta.status,
      emptinessReason: result.meta.emptinessReason,
      confidence: result.meta.confidence,
      engineStatus: result.meta.engineStatus,
      raw: structuredClone(result.meta.raw),
    },
  };
}

function leadSetRef(targetRef: string, artifactRef: string, observedAt: string): string {
  return `qls_${createHash("sha256").update(`${targetRef}\u0000${artifactRef}\u0000${observedAt}`).digest("hex").slice(0, 24)}`;
}

function withFxEstimate(leads: readonly QuoteLead[], fxByCurrency: ReadonlyMap<string, FxSnapshot>): QuoteLead[] {
  return leads.map((lead) => ({
    ...lead,
    priceRanges: lead.priceRanges.map((range) => {
      if (range.currency === "CNY") return range;
      const fx = fxByCurrency.get(range.currency);
      if (!fx) return range;
      try {
        return {
          ...range,
          cnyEstimate: {
            minAmount: convertToCny({ amount: range.minAmount, currency: range.currency }, fx),
            maxAmount: convertToCny({ amount: range.maxAmount, currency: range.currency }, fx),
            fxSnapshotId: fx.id,
            fxObservedAt: fx.observedAt,
            fxExpiresAt: fx.expiresAt,
          },
        };
      } catch {
        return range;
      }
    }),
  }));
}

async function collectFx(
  leads: readonly QuoteLead[],
  fxSource: FxPort | undefined,
  signal?: AbortSignal,
): Promise<FxSnapshot[]> {
  if (!fxSource) return [];
  const currencies = [...new Set(leads.flatMap((lead) => lead.priceRanges.map((range) => range.currency)))]
    .filter((currency) => currency !== "CNY")
    .sort();
  const settled = await Promise.allSettled(currencies.map((currency) => fxSource.getRate(currency, signal)));
  return settled.flatMap((result, index): FxSnapshot[] => {
    if (result.status !== "fulfilled") return [];
    const currency = currencies[index];
    const snapshot = result.value;
    if (!currency || snapshot.base.toUpperCase() !== currency || snapshot.quote !== "CNY") return [];
    const observedAt = Date.parse(snapshot.observedAt);
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (!snapshot.id.trim() || !snapshot.provider.trim() || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt <= observedAt) return [];
    return [snapshot];
  });
}

export class QuoteLookupService {
  public constructor(
    private readonly provider: QuoteProvider,
    private readonly fxSource?: FxPort,
    private readonly identitySnapshot?: ProductIdentitySnapshot,
  ) {}

  public async lookup(resolution: QuoteTargetResolution, signal?: AbortSignal): Promise<QuoteLookupExecution> {
    if (resolution.status !== "RESOLVED") {
      return {
        status: "TARGET_CONFIRMATION_REQUIRED",
        reasonCodes: [...resolution.reasonCodes],
        leadSet: null,
        artifact: null,
      };
    }

    const providerResult = await this.provider.lookup({ canonicalQuery: resolution.target.canonicalQuery }, signal);
    const artifact = artifactFrom(providerResult);
    const observations = providerResult.records.map((rawRecord, recordIndex) => createQuoteObservation({
      rawRecord,
      recordIndex,
      artifactRef: artifact.artifactRef,
      observedAt: providerResult.observedAt,
    }));
    const admissions = observations.map((observation) => admitQuoteObservation(observation, resolution.target, this.identitySnapshot));
    admissions.forEach(recordIdentityResolution);
    const grouped = providerResult.status === "OK_RESULTS"
      ? groupQuoteObservations(resolution.target, observations, admissions)
      : [];
    const fxSnapshots = await collectFx(grouped, this.fxSource, signal);
    const fxByCurrency = new Map(fxSnapshots.map((snapshot) => [snapshot.base.toUpperCase(), snapshot]));
    const leads = withFxEstimate(grouped, fxByCurrency);

    let outcome: QuoteLeadSet["outcome"];
    let reasonCodes: string[];
    if (providerResult.status === "DEGRADED" || providerResult.status === "FAILED") {
      outcome = "DEGRADED";
      reasonCodes = [providerResult.failure?.code ?? "QUOTE_PROVIDER_UNAVAILABLE"];
    } else if (providerResult.status === "OK_EMPTY") {
      outcome = "NO_QUOTE_LEADS";
      reasonCodes = ["PROVIDER_RETURNED_EMPTY"];
    } else if (leads.length === 0) {
      outcome = "NO_QUOTE_LEADS";
      reasonCodes = ["ALL_RECORDS_REJECTED"];
    } else {
      outcome = "QUOTE_LEADS";
      reasonCodes = [];
    }

    const leadSet: QuoteLeadSet = {
      contractVersion: QUOTE_LEAD_CONTRACT_VERSION,
      quoteLeadSetRef: leadSetRef(resolution.target.targetRef, artifact.artifactRef, artifact.observedAt),
      target: resolution.target,
      outcome,
      reasonCodes,
      provider: providerSummary(providerResult),
      observations,
      admissions,
      leads,
      fxSnapshots,
      observedAt: artifact.observedAt,
    };
    return { status: "LOOKUP_COMPLETED", reasonCodes, leadSet, artifact };
  }
}
