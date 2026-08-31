import {
  assessSearchCoverage,
  buildRankedOfferSet,
  ingestBuyWhereListing,
  mergeRetrievedListings,
  type RankedOfferSet,
  type RetrievedListing,
  type FxSnapshot,
  type SearchGoalSnapshot,
  type Market,
  type SearchCoverage,
  type SearchMarketOutcome,
} from "@interec/domain";

import type { FxPort, MarketSearchResult, ProductSearchPort } from "./providers.js";
import type { SemanticRelevancePort } from "./semantic-relevance-classifier.js";
import { runtimeMetrics } from "./telemetry.js";

export type SemanticRelevanceFailureCode = "PROTOCOL_INVALID" | "MODEL_STOPPED" | "PROVIDER_ERROR";

export type SemanticRelevanceEvaluation =
  | { outcome: "NOT_REQUESTED"; attempts: 0; failureCode: null }
  | { outcome: "SUCCEEDED"; attempts: number; failureCode: null }
  | { outcome: "FAILED"; attempts: number; failureCode: SemanticRelevanceFailureCode };

export interface SearchAttemptResult {
  availability: "AVAILABLE" | "UNAVAILABLE";
  listings: RetrievedListing[];
  rankedOfferSet: RankedOfferSet;
  markets: Array<{
    market: Market;
    status: "COMPLETED" | "FAILED";
    resultCount: number;
    errorCode: string | null;
    artifactRef: string | null;
  }>;
  artifacts: MarketSearchResult[];
  fxSnapshots: FxSnapshot[];
  semanticSignals: ReadonlyMap<string, import("@interec/domain").SemanticRelevanceSignal>;
  semanticEvaluation: SemanticRelevanceEvaluation;
}

export interface OfferSearchAttempt {
  attemptNo: number;
  queryVariant: string;
  result: SearchAttemptResult;
  coverage: SearchCoverage;
}

export interface OfferSearchBatchResult {
  goal: SearchGoalSnapshot;
  attempts: OfferSearchAttempt[];
  listings: RetrievedListing[];
  artifacts: MarketSearchResult[];
  fxSnapshots: FxSnapshot[];
  rankedOfferSet: RankedOfferSet;
  coverage: SearchCoverage;
  semanticEvaluation: SemanticRelevanceEvaluation;
}

function semanticRelevanceFailureCode(error: unknown): SemanticRelevanceFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("SEMANTIC_RELEVANCE_MODEL_")) return "MODEL_STOPPED";
  if (message.startsWith("SEMANTIC_RELEVANCE_")) return "PROTOCOL_INVALID";
  return "PROVIDER_ERROR";
}

export async function evaluateSemanticRelevance(
  semanticRelevance: SemanticRelevancePort | undefined,
  goal: SearchGoalSnapshot,
  listings: readonly RetrievedListing[],
  signal?: AbortSignal,
  maxAttempts = 2,
): Promise<{
  signals: ReadonlyMap<string, import("@interec/domain").SemanticRelevanceSignal>;
  evaluation: SemanticRelevanceEvaluation;
}> {
  if (!semanticRelevance || listings.length === 0) {
    return { signals: new Map(), evaluation: { outcome: "NOT_REQUESTED", attempts: 0, failureCode: null } };
  }
  let failureCode: SemanticRelevanceFailureCode = "PROVIDER_ERROR";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const signals = await semanticRelevance.classify(goal, listings, signal);
      if (signals.size !== listings.length || listings.some((listing) => !signals.has(listing.listingRef))) {
        throw new Error("SEMANTIC_RELEVANCE_ASSESSMENTS_INCOMPLETE");
      }
      runtimeMetrics.semanticRelevanceAttempts.add(1, { outcome: "SUCCEEDED", failure_code: "NONE" });
      return { signals, evaluation: { outcome: "SUCCEEDED", attempts: attempt, failureCode: null } };
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      failureCode = semanticRelevanceFailureCode(error);
      runtimeMetrics.semanticRelevanceAttempts.add(1, { outcome: "FAILED", failure_code: failureCode });
    }
  }
  return {
    signals: new Map(),
    evaluation: { outcome: "FAILED", attempts: maxAttempts, failureCode },
  };
}

export async function searchOffers(
  goal: SearchGoalSnapshot,
  queryVariant: string,
  productSource: ProductSearchPort,
  fxSource: FxPort,
  signal?: AbortSignal,
  semanticRelevance?: SemanticRelevancePort,
): Promise<SearchAttemptResult> {
  const settled = await Promise.allSettled(goal.markets.map((market) => productSource.search(queryVariant, market, 8, signal)));
  const artifacts: MarketSearchResult[] = [];
  const markets: SearchAttemptResult["markets"] = [];
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
      rankedOfferSet: buildRankedOfferSet([], goal, new Map()),
      markets,
      artifacts: [],
      fxSnapshots: [],
      semanticSignals: new Map(),
      semanticEvaluation: { outcome: "NOT_REQUESTED", attempts: 0, failureCode: null },
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
  const listings: RetrievedListing[] = [];
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
  const semantic = await evaluateSemanticRelevance(semanticRelevance, goal, listings, signal);
  return {
    availability: "AVAILABLE",
    listings,
    rankedOfferSet: buildRankedOfferSet(listings, goal, fxByCurrency, semantic.signals),
    markets,
    artifacts,
    fxSnapshots: [...fxByCurrency.values()],
    semanticSignals: semantic.signals,
    semanticEvaluation: semantic.evaluation,
  };
}

export async function runOfferSearchBatch(
  goal: SearchGoalSnapshot,
  queryVariants: readonly string[],
  productSource: ProductSearchPort,
  fxSource: FxPort,
  signal?: AbortSignal,
  maxAttempts = 2,
  semanticRelevance?: SemanticRelevancePort,
): Promise<OfferSearchBatchResult> {
  const variants = [...new Set(queryVariants.map((value) => value.trim()).filter(Boolean))].slice(0, maxAttempts);
  if (variants.length === 0) throw new Error("SEARCH_QUERY_REQUIRED");
  let listings: RetrievedListing[] = [];
  const artifactByRef = new Map<string, MarketSearchResult>();
  const fxById = new Map<string, FxSnapshot>();
  const semanticSignals = new Map<string, import("@interec/domain").SemanticRelevanceSignal>();
  const aggregateMarkets = new Map<string, SearchMarketOutcome>();
  const attempts: OfferSearchAttempt[] = [];
  let rankedOfferSet = buildRankedOfferSet([], goal, new Map());
  let coverage: SearchCoverage | null = null;
  let previousComparableCount = 0;
  for (let index = 0; index < variants.length; index += 1) {
    const queryVariant = variants[index]!;
    const result = await searchOffers(goal, queryVariant, productSource, fxSource, signal, semanticRelevance);
    listings = mergeRetrievedListings(listings, result.listings);
    for (const artifact of result.artifacts) artifactByRef.set(artifact.artifactRef, artifact);
    for (const fx of result.fxSnapshots) fxById.set(fx.id, fx);
    for (const [listingRef, semanticSignal] of result.semanticSignals) semanticSignals.set(listingRef, semanticSignal);
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
    rankedOfferSet = buildRankedOfferSet(listings, goal, fxByCurrency, semanticSignals);
    coverage = assessSearchCoverage({
      requestedMarkets: goal.markets,
      outcomes: [...aggregateMarkets.values()],
      listings,
      rankedOfferSet,
      previousComparableCount,
      attemptNo: index + 1,
      maxAttempts: variants.length,
    });
    attempts.push({ attemptNo: index + 1, queryVariant, result, coverage });
    if (coverage.stopReason !== "CONTINUE") break;
    previousComparableCount = rankedOfferSet.rankedOffers.length;
  }
  if (!coverage) throw new Error("SEARCH_CAMPAIGN_EMPTY");
  return {
    goal,
    attempts,
    listings,
    artifacts: [...artifactByRef.values()],
    fxSnapshots: [...fxById.values()],
    rankedOfferSet,
    coverage,
    semanticEvaluation: attempts.some((attempt) => attempt.result.semanticEvaluation.outcome === "SUCCEEDED")
      ? attempts.findLast((attempt) => attempt.result.semanticEvaluation.outcome === "SUCCEEDED")!.result.semanticEvaluation
      : attempts.some((attempt) => attempt.result.semanticEvaluation.outcome === "FAILED")
        ? attempts.findLast((attempt) => attempt.result.semanticEvaluation.outcome === "FAILED")!.result.semanticEvaluation
        : { outcome: "NOT_REQUESTED", attempts: 0, failureCode: null },
  };
}
