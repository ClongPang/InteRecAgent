import { createHash } from "node:crypto";

import { compareDecimal } from "./money.js";
import {
  MERCHANT_PAGE_CONFIRMATION,
  QUOTE_ADMISSION_POLICY_VERSION,
  QUOTE_GROUPING_POLICY_VERSION,
  type QuoteAdmissionDecision,
  type QuoteLead,
  type QuoteObservation,
  type QuotePriceRange,
  type QuoteTarget,
} from "./quote-types.js";

const TRACKING_PARAMETER = /^(?:utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|tag|linkcode|ascsubtag|aff_id|affiliate_id|irclickid)$/iu;

export function normalizeMerchantTargetUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function priceRanges(observations: readonly QuoteObservation[]): QuotePriceRange[] {
  const grouped = new Map<string, QuoteObservation[]>();
  for (const observation of observations) {
    if (!observation.originalMoney) continue;
    const values = grouped.get(observation.originalMoney.currency) ?? [];
    values.push(observation);
    grouped.set(observation.originalMoney.currency, values);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, "en-US")).map(([currency, values]) => {
    const sorted = [...values].sort((left, right) => compareDecimal(left.originalMoney!.amount, right.originalMoney!.amount));
    return {
      currency,
      minAmount: sorted[0]!.originalMoney!.amount,
      maxAmount: sorted.at(-1)!.originalMoney!.amount,
      observationRefs: values.map((value) => value.observationRef),
      cnyEstimate: null,
    };
  });
}

function latestTimestamp(values: readonly (string | null)[]): string | null {
  const valid = values.filter((value): value is string => value !== null).sort((left, right) => Date.parse(left) - Date.parse(right));
  return valid.at(-1) ?? null;
}

function stableLeadRef(target: QuoteTarget, normalizedUrl: string, condition: string): string {
  return `ql_${createHash("sha256").update(`${target.targetRef}\u0000${normalizedUrl}\u0000${condition}`).digest("hex").slice(0, 24)}`;
}

export function groupQuoteObservations(
  target: QuoteTarget,
  observations: readonly QuoteObservation[],
  admissions: readonly QuoteAdmissionDecision[],
): QuoteLead[] {
  const admissionByRef = new Map(admissions.map((decision) => [decision.observationRef, decision]));
  const groups = new Map<string, { normalizedUrl: string; observations: QuoteObservation[] }>();
  for (const observation of observations) {
    if (admissionByRef.get(observation.observationRef)?.status !== "ELIGIBLE" || !observation.merchantTargetUrl) continue;
    const normalizedUrl = normalizeMerchantTargetUrl(observation.merchantTargetUrl);
    const key = `${normalizedUrl}\u0000${observation.condition}`;
    const group = groups.get(key) ?? { normalizedUrl, observations: [] };
    group.observations.push(observation);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((left, right) => `${left.normalizedUrl}\u0000${left.observations[0]!.condition}`.localeCompare(`${right.normalizedUrl}\u0000${right.observations[0]!.condition}`, "en-US"))
    .map(({ normalizedUrl, observations: values }) => {
      const representative = values[0]!;
      const eligibleAdmissions = values.map((value) => admissionByRef.get(value.observationRef)!).filter(Boolean);
      const identityStrength = eligibleAdmissions
        .map((value) => value.identityStrength)
        .sort((left, right) => {
          const rank = { EXACT_LEXICAL_MATCH: 0, CURATED_TITLE_ALIAS_MATCH: 1, STRONG_IDENTIFIER_MATCH: 2 } as const;
          return (rank[left as keyof typeof rank] ?? -1) - (rank[right as keyof typeof rank] ?? -1);
        })[0] as "EXACT_LEXICAL_MATCH" | "CURATED_TITLE_ALIAS_MATCH" | "STRONG_IDENTIFIER_MATCH";
      const observed = values.map((value) => value.observedAt).sort((left, right) => Date.parse(left) - Date.parse(right));
      return {
        quoteLeadRef: stableLeadRef(target, normalizedUrl, representative.condition),
        targetRef: target.targetRef,
        canonicalModel: target.canonicalModel,
        representativeTitle: representative.title!,
        condition: representative.condition,
        merchantLabel: representative.merchantLabel ?? representative.merchantDomain!,
        merchantDomain: representative.merchantDomain!,
        merchantTargetUrl: normalizedUrl,
        outboundUrl: representative.outboundUrl!,
        priceRanges: priceRanges(values),
        observationRefs: values.map((value) => value.observationRef),
        observationCount: values.length,
        firstObservedAt: observed[0]!,
        latestObservedAt: observed.at(-1)!,
        latestProviderUpdatedAt: latestTimestamp(values.map((value) => value.providerUpdatedAt)),
        disclosureCode: MERCHANT_PAGE_CONFIRMATION,
        groupingPolicyVersion: QUOTE_GROUPING_POLICY_VERSION,
        admissionPolicyVersion: QUOTE_ADMISSION_POLICY_VERSION,
        identityStrength,
        identityEvidenceRefs: [...new Set(eligibleAdmissions.flatMap((value) => value.identityEvidenceRefs))].sort(),
      };
    });
}
