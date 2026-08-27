import type { ComparisonSet, DiscoveredListing, Market } from "./types.js";

export interface ResearchMarketOutcome {
  market: Market;
  status: "COMPLETED" | "FAILED";
  resultCount: number;
  errorCode: string | null;
}

export type ResearchStopReason =
  | "CONTINUE"
  | "COVERAGE_SATISFIED"
  | "ALL_PROVIDERS_FAILED"
  | "NO_NEW_COMPARABLES"
  | "MAX_WAVES_REACHED";

export interface ResearchCoverage {
  requestedMarkets: Market[];
  completedMarkets: Market[];
  failedMarkets: Market[];
  discoveredCount: number;
  comparableCount: number;
  ineligibleCount: number;
  insufficientEvidenceCount: number;
  rejectionReasonCounts: Record<string, number>;
  topReasonCode: string | null;
  stopReason: ResearchStopReason;
  adequate: boolean;
}

export function mergeDiscoveredListings(
  current: readonly DiscoveredListing[],
  incoming: readonly DiscoveredListing[],
): DiscoveredListing[] {
  const byRef = new Map(current.map((listing) => [listing.listingRef, structuredClone(listing)]));
  for (const listing of incoming) {
    const existing = byRef.get(listing.listingRef);
    if (!existing || existing.observedAt < listing.observedAt) byRef.set(listing.listingRef, structuredClone(listing));
  }
  return [...byRef.values()].sort((left, right) => left.listingRef.localeCompare(right.listingRef));
}

export function assessResearchCoverage(input: {
  requestedMarkets: readonly Market[];
  outcomes: readonly ResearchMarketOutcome[];
  listings: readonly DiscoveredListing[];
  comparisonSet: ComparisonSet;
  previousComparableCount: number;
  waveNo: number;
  maxWaves: number;
  minimumComparableOffers?: number;
}): ResearchCoverage {
  const completedMarkets = [...new Set(input.outcomes.filter((item) => item.status === "COMPLETED").map((item) => item.market))];
  const failedMarkets = [...new Set(input.outcomes.filter((item) => item.status === "FAILED").map((item) => item.market))];
  const reasonCounts: Record<string, number> = {};
  let ineligibleCount = 0;
  let insufficientEvidenceCount = 0;
  for (const qualification of input.comparisonSet.qualifications) {
    if (qualification.status === "INELIGIBLE") ineligibleCount += 1;
    if (qualification.status === "INSUFFICIENT_EVIDENCE") insufficientEvidenceCount += 1;
    for (const code of qualification.reasonCodes) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  }
  let topReasonCode = Object.entries(reasonCounts)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => rightCount - leftCount || leftCode.localeCompare(rightCode))[0]?.[0] ?? null;
  const comparableCount = input.comparisonSet.rankedOffers.length;
  const minimum = input.minimumComparableOffers ?? 3;
  let stopReason: ResearchStopReason = "CONTINUE";
  if (completedMarkets.length === 0) {
    stopReason = "ALL_PROVIDERS_FAILED";
    topReasonCode = "ALL_PROVIDERS_FAILED";
  }
  else if (comparableCount >= minimum) stopReason = "COVERAGE_SATISFIED";
  else if (input.waveNo > 1 && comparableCount <= input.previousComparableCount) stopReason = "NO_NEW_COMPARABLES";
  else if (input.waveNo >= input.maxWaves) stopReason = "MAX_WAVES_REACHED";
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
