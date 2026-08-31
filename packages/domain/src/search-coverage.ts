import type { RankedOfferSet, RetrievedListing, Market } from "./types.js";

export interface SearchMarketOutcome {
  market: Market;
  status: "COMPLETED" | "FAILED";
  resultCount: number;
  errorCode: string | null;
}

export type SearchStopReason =
  | "CONTINUE"
  | "COVERAGE_SATISFIED"
  | "ALL_PROVIDERS_FAILED"
  | "NO_NEW_COMPARABLES"
  | "MAX_ATTEMPTS_REACHED";

export interface SearchCoverage {
  requestedMarkets: Market[];
  completedMarkets: Market[];
  failedMarkets: Market[];
  discoveredCount: number;
  comparableCount: number;
  ineligibleCount: number;
  insufficientEvidenceCount: number;
  rejectionReasonCounts: Record<string, number>;
  topReasonCode: string | null;
  stopReason: SearchStopReason;
  adequate: boolean;
}

export function mergeRetrievedListings(
  current: readonly RetrievedListing[],
  incoming: readonly RetrievedListing[],
): RetrievedListing[] {
  const byRef = new Map(current.map((listing) => [listing.listingRef, structuredClone(listing)]));
  for (const listing of incoming) {
    const existing = byRef.get(listing.listingRef);
    if (!existing || existing.observedAt < listing.observedAt) byRef.set(listing.listingRef, structuredClone(listing));
  }
  return [...byRef.values()].sort((left, right) => left.listingRef.localeCompare(right.listingRef));
}

export function assessSearchCoverage(input: {
  requestedMarkets: readonly Market[];
  outcomes: readonly SearchMarketOutcome[];
  listings: readonly RetrievedListing[];
  rankedOfferSet: RankedOfferSet;
  previousComparableCount: number;
  attemptNo: number;
  maxAttempts: number;
  minimumComparableOffers?: number;
}): SearchCoverage {
  const completedMarkets = [...new Set(input.outcomes.filter((item) => item.status === "COMPLETED").map((item) => item.market))];
  const failedMarkets = [...new Set(input.outcomes.filter((item) => item.status === "FAILED").map((item) => item.market))];
  const reasonCounts: Record<string, number> = {};
  let ineligibleCount = 0;
  let insufficientEvidenceCount = 0;
  for (const eligibility of input.rankedOfferSet.eligibilityResults) {
    if (eligibility.status === "INELIGIBLE") ineligibleCount += 1;
    if (eligibility.status === "INSUFFICIENT_EVIDENCE") insufficientEvidenceCount += 1;
    for (const code of eligibility.reasonCodes) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  }
  let topReasonCode = Object.entries(reasonCounts)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => rightCount - leftCount || leftCode.localeCompare(rightCode))[0]?.[0] ?? null;
  const comparableCount = input.rankedOfferSet.rankedOffers.length;
  const minimum = input.minimumComparableOffers ?? 3;
  let stopReason: SearchStopReason = "CONTINUE";
  if (completedMarkets.length === 0) {
    stopReason = "ALL_PROVIDERS_FAILED";
    topReasonCode = "ALL_PROVIDERS_FAILED";
  }
  else if (comparableCount >= minimum) stopReason = "COVERAGE_SATISFIED";
  else if (input.attemptNo > 1 && comparableCount <= input.previousComparableCount) stopReason = "NO_NEW_COMPARABLES";
  else if (input.attemptNo >= input.maxAttempts) stopReason = "MAX_ATTEMPTS_REACHED";
  return {
    requestedMarkets: [...input.requestedMarkets],
    completedMarkets,
    failedMarkets,
    discoveredCount: input.listings.length,
    comparableCount,
    ineligibleCount,
    insufficientEvidenceCount,
    rejectionReasonCounts: reasonCounts,
    topReasonCode,
    stopReason,
    adequate: comparableCount > 0,
  };
}
