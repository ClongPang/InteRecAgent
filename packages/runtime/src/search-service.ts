import {
  assessResearchCoverage,
  buildComparisonSet,
  ingestBuyWhereListing,
  mergeDiscoveredListings,
  type ComparisonSet,
  type DiscoveredListing,
  type FxSnapshot,
  type Goal,
  type Market,
  type ResearchCoverage,
  type ResearchMarketOutcome,
} from "@interec/domain";

import type { FxPort, MarketSearchResult, ProductSearchPort } from "./providers.js";

export interface ResearchWaveResult {
  availability: "AVAILABLE" | "UNAVAILABLE";
  listings: DiscoveredListing[];
  comparisonSet: ComparisonSet;
  markets: Array<{
    market: Market;
    status: "COMPLETED" | "FAILED";
    resultCount: number;
    errorCode: string | null;
    artifactRef: string | null;
  }>;
  artifacts: MarketSearchResult[];
  fxSnapshots: FxSnapshot[];
}

export interface ResearchCampaignWave {
  waveNo: number;
  queryVariant: string;
  result: ResearchWaveResult;
  coverage: ResearchCoverage;
}

export interface ResearchCampaignResult {
  goal: Goal;
  waves: ResearchCampaignWave[];
  listings: DiscoveredListing[];
  artifacts: MarketSearchResult[];
  fxSnapshots: FxSnapshot[];
  comparisonSet: ComparisonSet;
  coverage: ResearchCoverage;
}

export async function researchOffers(
  goal: Goal,
  queryVariant: string,
  productSource: ProductSearchPort,
  fxSource: FxPort,
  signal?: AbortSignal,
): Promise<ResearchWaveResult> {
  const settled = await Promise.allSettled(goal.markets.map((market) => productSource.search(queryVariant, market, 8, signal)));
  const artifacts: MarketSearchResult[] = [];
  const markets: ResearchWaveResult["markets"] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const market = goal.markets[index];
    const result = settled[index];
    if (!market || !result) continue;
    if (result.status === "fulfilled") {
      artifacts.push(result.value);
      markets.push({ market, status: "COMPLETED", resultCount: result.value.products.length, errorCode: null, artifactRef: result.value.artifactRef });
    } else {
      const message = result.reason instanceof Error ? result.reason.message : "PROVIDER_FAILED";
      markets.push({ market, status: "FAILED", resultCount: 0, errorCode: message.slice(0, 100), artifactRef: null });
    }
  }
  if (artifacts.length === 0) {
    return {
      availability: "UNAVAILABLE",
      listings: [],
      comparisonSet: buildComparisonSet([], goal, new Map()),
      markets,
      artifacts: [],
      fxSnapshots: [],
    };
  }

  const currencies = new Set<string>();
  for (const artifact of artifacts) {
    for (const product of artifact.products) {
      const currency = product.price && typeof product.price === "object" ? product.price.currency : null;
      if (typeof currency === "string") currencies.add(currency.toUpperCase());
    }
  }
  const fxResults = await Promise.allSettled([...currencies].map(async (currency) => [currency, await fxSource.getRate(currency, signal)] as const));
  const fxByCurrency = new Map(
    fxResults
      .filter((result): result is PromiseFulfilledResult<readonly [string, Awaited<ReturnType<FxPort["getRate"]>>]> => result.status === "fulfilled")
      .map((result) => result.value),
  );
  const listings: DiscoveredListing[] = [];
  for (const artifact of artifacts) {
    for (const [productIndex, product] of artifact.products.entries()) {
      const listing = ingestBuyWhereListing(product, {
        retrievalMarket: artifact.market,
        target: goal.target,
        observedAt: artifact.observedAt,
        rawArtifactRef: artifact.artifactRef,
        jsonPathPrefix: `$.data[${productIndex}]`,
      });
      if (listing) listings.push(listing);
    }
  }
  return {
    availability: "AVAILABLE",
    listings,
    comparisonSet: buildComparisonSet(listings, goal, fxByCurrency),
    markets,
    artifacts,
    fxSnapshots: [...fxByCurrency.values()],
  };
}

export async function runResearchCampaign(
  goal: Goal,
  queryVariants: readonly string[],
  productSource: ProductSearchPort,
  fxSource: FxPort,
  signal?: AbortSignal,
  maxWaves = 2,
): Promise<ResearchCampaignResult> {
  const variants = [...new Set(queryVariants.map((value) => value.trim()).filter(Boolean))].slice(0, maxWaves);
  if (variants.length === 0) throw new Error("RESEARCH_QUERY_REQUIRED");
  let listings: DiscoveredListing[] = [];
  const artifactByRef = new Map<string, MarketSearchResult>();
  const fxById = new Map<string, FxSnapshot>();
  const aggregateMarkets = new Map<string, ResearchMarketOutcome>();
  const waves: ResearchCampaignWave[] = [];
  let comparisonSet = buildComparisonSet([], goal, new Map());
  let coverage: ResearchCoverage | null = null;
  let previousComparableCount = 0;
  for (let index = 0; index < variants.length; index += 1) {
    const queryVariant = variants[index]!;
    const result = await researchOffers(goal, queryVariant, productSource, fxSource, signal);
    listings = mergeDiscoveredListings(listings, result.listings);
    for (const artifact of result.artifacts) artifactByRef.set(artifact.artifactRef, artifact);
    for (const fx of result.fxSnapshots) fxById.set(fx.id, fx);
    for (const market of result.markets) {
      const existing = aggregateMarkets.get(market.market);
      if (!existing || existing.status === "FAILED" || market.status === "COMPLETED") {
        aggregateMarkets.set(market.market, {
          market: market.market,
          status: market.status,
          resultCount: market.resultCount,
          errorCode: market.errorCode,
        });
      }
    }
    const fxByCurrency = new Map([...fxById.values()].map((fx) => [fx.base, fx]));
    comparisonSet = buildComparisonSet(listings, goal, fxByCurrency);
    coverage = assessResearchCoverage({
      requestedMarkets: goal.markets,
      outcomes: [...aggregateMarkets.values()],
      listings,
      comparisonSet,
      previousComparableCount,
      waveNo: index + 1,
      maxWaves: variants.length,
    });
    waves.push({ waveNo: index + 1, queryVariant, result, coverage });
    if (coverage.stopReason !== "CONTINUE") break;
    previousComparableCount = comparisonSet.rankedOffers.length;
  }
  if (!coverage) throw new Error("RESEARCH_CAMPAIGN_EMPTY");
  return {
    goal,
    waves,
    listings,
    artifacts: [...artifactByRef.values()],
    fxSnapshots: [...fxById.values()],
    comparisonSet,
    coverage,
  };
}
