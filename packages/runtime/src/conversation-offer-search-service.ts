import {
  DomainError,
  canonicalProductModel,
  resolveCategoryValidationCapability,
  resolveCategoryValidationPolicy,
  resolveMarketDefinition,
  tokenizeSearchText,
  type ConversationState,
  type SearchGoalSnapshot,
  type Market,
  type SearchTargetSnapshot,
  type SearchCoverage,
  type ShoppingGoal,
  type GroundedClaim,
  type TurnAction,
} from "@interec/domain";
import type { ShoppingDataPort, TurnActionResult } from "@interec/agent";

import type { ClaimedConversationTurn, ConversationRepository } from "./conversation-repository-types.js";
import { PostgresConversationSearchRepository } from "./conversation-search-repository.js";
import { ControlledFxClient, ControlledProductSearchClient } from "./controlled-provider-clients.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";
import { PostgresCandidateCacheRepository, type CandidateCacheRepository } from "./candidate-cache-repository.js";
import type { FxPort, ProductSearchPort } from "./providers.js";
import { buildSearchProvenanceBundle } from "./search-provenance.js";
import { runOfferSearchBatch } from "./search-service.js";
import { runtimeMetrics } from "./telemetry.js";
import type { SemanticRelevancePort } from "./semantic-relevance-classifier.js";

function searchTargetFromGoal(goal: ShoppingGoal): SearchTargetSnapshot {
  if (!goal.target) throw new DomainError("SEARCH_TARGET_REQUIRED", "Offer search requires a resolved shopping target");
  const capability = resolveCategoryValidationCapability(goal.target.categoryId, goal.target.targetText);
  const categoryPolicy = capability.policy;
  return {
    categoryId: capability.categoryId,
    targetText: goal.target.targetText ?? goal.target.categoryId,
    canonicalModel: goal.target.canonicalModel
      ? categoryPolicy
        ? canonicalProductModel(goal.target.canonicalModel, categoryPolicy.categoryId) ?? goal.target.canonicalModel.toUpperCase()
        : goal.target.canonicalModel.normalize("NFKC").trim()
      : null,
    itemRole: goal.target.itemRole,
    conditionPreference: goal.target.condition === "ANY" ? "ANY" : goal.target.condition,
  };
}

export function toSearchGoal(state: ConversationState, marketScope?: string[]): SearchGoalSnapshot {
  const shopping = state.goalRevision?.goal;
  if (!shopping) throw new DomainError("SEARCH_GOAL_REQUIRED", "Offer search requires a committed shopping goal");
  if (shopping.budget && shopping.budget.currency.toUpperCase() !== "CNY") {
    throw new DomainError("BUDGET_CURRENCY_UNSUPPORTED", "Offer eligibility currently requires a CNY budget");
  }
  const requestedMarkets = shopping.retrievalMarkets.length > 0 ? shopping.retrievalMarkets : (marketScope ?? []);
  const unsupportedMarkets = requestedMarkets.filter((market) => !resolveMarketDefinition(market));
  if (unsupportedMarkets.length > 0) throw new DomainError("UNSUPPORTED_MARKET", unsupportedMarkets.join(","));
  const markets = requestedMarkets.map((market) => resolveMarketDefinition(market)!.marketId as Market);
  if (markets.length === 0) throw new DomainError("SEARCH_MARKETS_REQUIRED", "Offer search requires at least one supported retrieval market");
  const target = searchTargetFromGoal(shopping);
  const categoryPolicy = resolveCategoryValidationPolicy(target.categoryId);
  const constraintTerms = shopping.hardConstraints.flatMap((constraint) =>
    categoryPolicy?.attributeValidationRules.find((rule) =>
      rule.key === constraint.key
      && rule.value === constraint.value
      && constraint.operator === "EQ"
    )?.queryTerms ?? [Array.isArray(constraint.value) ? constraint.value.join(" ") : String(constraint.value)]
  );
  return {
    query: [...new Set([target.canonicalModel ?? resolveCategoryValidationCapability(target.categoryId, target.targetText).queryTerm, ...constraintTerms])].join(" "),
    target,
    markets,
    budgetCny: shopping.budget?.amount ?? null,
    stockPreference: shopping.stockPreference,
    excludedOfferRefs: [...new Set([
      ...shopping.exclusions.filter((item) => item.kind === "OFFER").map((item) => item.value),
      ...(state.workingSet?.rejectedOfferRefs ?? []),
    ])],
    hardConstraints: shopping.hardConstraints.map(({ source: _source, ...constraint }) => constraint),
    preferenceHints: shopping.preferences.map(({ source: _source, ...preference }) => preference),
  };
}

export function queryVariants(operation: Extract<TurnAction, { kind: "SEARCH_OFFERS" }>, goal: SearchGoalSnapshot): string[] {
  const requiredTerms = resolveCategoryValidationPolicy(goal.target.categoryId)?.attributeValidationRules
    .filter((rule) => goal.hardConstraints?.some((constraint) =>
      constraint.key === rule.key
      && constraint.value === rule.value
      && constraint.operator === "EQ"
    ))
    .flatMap((rule) => rule.queryTerms) ?? [];
  const withRequiredTerms = (value: string) => [...new Set([value.trim(), ...requiredTerms].filter(Boolean))].join(" ");
  const primary = goal.query.trim();
  const requested = operation.queryVariant?.trim();
  const broader = [...new Set([goal.target.canonicalModel, goal.target.targetText, resolveCategoryValidationPolicy(goal.target.categoryId)?.broaderQueryTerm, goal.target.categoryId]
    .filter(Boolean))]
    .join(" ")
    .trim();
  return [...new Set([primary, requested ? withRequiredTerms(requested) : "", withRequiredTerms(broader)].filter(Boolean))];
}

function disclosureCodes(coverage: SearchCoverage, claims: readonly GroundedClaim[]): string[] {
  const codes = new Set<string>();
  if (coverage.failedMarkets.length > 0 && coverage.completedMarkets.length > 0) codes.add("PARTIAL_PROVIDER_COVERAGE");
  if (coverage.completedMarkets.length === 0) codes.add("PROVIDER_UNAVAILABLE");
  if (claims.some((claim) => claim.kind === "PRICE")) {
    codes.add("FX_ESTIMATE");
    codes.add("EXCLUDES_TAX_SHIPPING_PAYMENT");
    codes.add("MERCHANT_CHECKOUT_FINAL");
    codes.add("DETERMINISTIC_OFFER_ORDER_NOT_PRODUCT_QUALITY");
  }
  if (claims.some((claim) => claim.kind === "STOCK" && claim.canonicalValue === "UNKNOWN")) codes.add("STOCK_UNKNOWN");
  if (claims.some((claim) => claim.kind === "CONDITION" && claim.canonicalValue === "UNKNOWN")) codes.add("CONDITION_UNKNOWN");
  if (!coverage.adequate && coverage.completedMarkets.length > 0) codes.add("UNVERIFIED_RESULTS_NOT_RECOMMENDED");
  if (claims.length > 0 && claims.every((claim) => claim.kind !== "MODEL")) codes.add("LISTING_LEVEL_IDENTITY_ONLY");
  return [...codes];
}

function claimKindForField(field: Extract<TurnAction, { kind: "INSPECT_WORKING_SET" }>["fields"][number]): GroundedClaim["kind"] | null {
  switch (field) {
    case "PRICE": return "PRICE";
    case "MERCHANT": return "MERCHANT";
    case "MARKET": return "MARKET";
    case "STOCK": return "STOCK";
    case "MODEL": return "MODEL";
    case "CONDITION": return "CONDITION";
    case "RANKING_REASON": return "RANKING_REASON";
    case "WARRANTY": return null;
  }
}

export class ConversationOfferSearchService implements ShoppingDataPort {
  private readonly candidateCache: CandidateCacheRepository;

  public constructor(
    private readonly claimed: ClaimedConversationTurn,
    private readonly turnRepository: ConversationRepository,
    private readonly searchRepository: PostgresConversationSearchRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly productSource: ProductSearchPort,
    private readonly fxSource: FxPort,
    candidateCache?: CandidateCacheRepository,
    private readonly semanticRelevance?: SemanticRelevancePort,
  ) {
    this.candidateCache = candidateCache ?? new PostgresCandidateCacheRepository(searchRepository.pool);
  }

  public async inspect(
    operation: Extract<TurnAction, { kind: "INSPECT_WORKING_SET" }>,
    offerRefs: string[],
    _state: ConversationState,
  ): Promise<TurnActionResult> {
    const available = await this.searchRepository.loadPublishedClaims(this.claimed.conversationId, offerRefs);
    const requestedKinds = new Set(operation.fields.flatMap((field) => {
      const kind = claimKindForField(field);
      return kind ? [kind] : [];
    }));
    const claims = available.filter((claim) => requestedKinds.has(claim.kind));
    const unknownFields = operation.fields.filter((field) => {
      const kind = claimKindForField(field);
      return kind === null || !claims.some((claim) => claim.kind === kind);
    });
    const disclosureCodes = [
      ...(claims.some((claim) => claim.kind === "PRICE") ? ["FX_ESTIMATE", "EXCLUDES_TAX_SHIPPING_PAYMENT", "MERCHANT_CHECKOUT_FINAL"] : []),
      ...unknownFields.map((field) => `${field}_UNKNOWN`),
    ];
    return {
      claims,
      disclosureCodes,
      publicResult: {
        offers: offerRefs,
        claims: claims.map((claim) => ({ claimId: claim.claimId, kind: claim.kind, renderedText: claim.renderedText, offerRefs: claim.offerRefs })),
        unknownFields,
      },
    };
  }

  public async inspectSearchCoverage(
    _operation: Extract<TurnAction, { kind: "INSPECT_SEARCH_COVERAGE" }>,
    _state: ConversationState,
  ): Promise<TurnActionResult> {
    const historical = await this.searchRepository.loadLatestPublishedSearchCoverage(
      this.claimed.owner,
      this.claimed.conversationId,
    );
    if (!historical) {
      return {
        claims: [],
        disclosureCodes: ["SEARCH_COVERAGE_UNKNOWN"],
        publicResult: { found: false },
      };
    }
    const failedMarkets = [...new Set(historical.coverage.failedMarkets)].sort();
    return {
      claims: [],
      disclosureCodes: failedMarkets.length > 0
        ? [`SEARCH_COVERAGE_INCOMPLETE:${failedMarkets.join(",")}`]
        : [],
      publicResult: {
        found: true,
        attemptNo: historical.attemptNo,
        status: historical.status,
        completedAt: historical.completedAt,
        publishedRevision: historical.publishedRevision,
        coverage: historical.coverage,
        marketOutcomes: historical.marketOutcomes,
        interpretation: failedMarkets.length > 0
          ? "INCOMPLETE_COVERAGE_DOES_NOT_PROVE_MARKET_ABSENCE"
          : "COVERAGE_COMPLETED",
      },
    };
  }

  public async search(
    operation: Extract<TurnAction, { kind: "SEARCH_OFFERS" }>,
    state: ConversationState,
    signal?: AbortSignal,
  ) {
    const goal = toSearchGoal(state, operation.marketScope);
    const variants = queryVariants(operation, goal);
    const attemptNoByQuery = new Map(variants.map((query, index) => [query, index + 1]));
    const governedProduct: ProductSearchPort = {
      search: (query, market, limit, callSignal) => new ControlledProductSearchClient(
        this.productSource,
        this.turnRepository,
        this.callController,
        {
          tenantId: this.claimed.owner.tenantId,
          turnId: this.claimed.id,
          attempt: this.claimed.attempt,
          fenceToken: this.claimed.fenceToken,
          operationId: operation.opId,
          attemptNo: attemptNoByQuery.get(query) ?? 1,
        },
      ).search(query, market, limit, callSignal),
    };
    const controlledFx = new ControlledFxClient(this.fxSource, this.turnRepository, this.callController, {
      tenantId: this.claimed.owner.tenantId,
      turnId: this.claimed.id,
      attempt: this.claimed.attempt,
      fenceToken: this.claimed.fenceToken,
      operationId: operation.opId,
    });
    const cacheTokens = tokenizeSearchText([
      goal.query,
      goal.target.targetText,
      goal.target.categoryId,
      goal.target.canonicalModel,
      ...(goal.preferenceHints ?? []).map((preference) => Array.isArray(preference.value) ? preference.value.join(" ") : String(preference.value)),
    ].filter(Boolean).join(" "));
    let searchSource: "LOCAL_CACHE" | "PROVIDER" = "PROVIDER";
    let selectedProductSource: ProductSearchPort = governedProduct;
    let selectedVariants = variants;
    if (cacheTokens.length > 0) {
      let cacheOutcome: "hit" | "miss" | "error" = "miss";
      try {
        const cached = await this.candidateCache.search(this.claimed.owner, {
          tokens: cacheTokens,
          markets: goal.markets,
          limit: 24,
        });
        const cachedMarkets = new Set(cached.map((candidate) => candidate.retrievalMarket));
        if (cached.length >= 3 && goal.markets.every((market) => cachedMarkets.has(market))) {
          const artifacts = await this.candidateCache.loadArtifacts(
            this.claimed.owner,
            cached.map((candidate) => candidate.candidateRef),
          );
          const artifactByMarket = new Map(artifacts
            .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
            .map((artifact) => [artifact.market, artifact]));
          if (goal.markets.every((market) => artifactByMarket.has(market))) {
            selectedProductSource = {
              search: async (_query, market) => {
                const artifact = artifactByMarket.get(market);
                if (!artifact) throw new Error(`LOCAL_CACHE_MARKET_MISS:${market}`);
                return structuredClone(artifact);
              },
            };
            selectedVariants = variants.slice(0, 1);
            searchSource = "LOCAL_CACHE";
            cacheOutcome = "hit";
          }
        }
      } catch {
        // Cache is an optimization. Provider search remains the safe fallback.
        cacheOutcome = "error";
      } finally {
        runtimeMetrics.candidateCacheLookups.add(1, { outcome: cacheOutcome });
      }
    }
    const batch = await runOfferSearchBatch(goal, selectedVariants, selectedProductSource, controlledFx, signal, 2, this.semanticRelevance);
    for (const eligibility of batch.rankedOfferSet.eligibilityResults) {
      runtimeMetrics.candidateAdmissions.add(1, {
        relevance_label: eligibility.queryProductRelevance.label,
        admission_cohort: eligibility.candidateAdmission.cohort,
        status: eligibility.status,
      });
    }
    const boundGoalVersion = state.goalRevision?.version;
    if (!boundGoalVersion) throw new DomainError("SEARCH_GOAL_REQUIRED", "Offer search requires a published goal version");
    const provenance = buildSearchProvenanceBundle({
      rankedOfferSet: batch.rankedOfferSet,
      artifacts: batch.artifacts,
      coverage: batch.coverage,
      workingSetVersion: state.revision,
      boundGoalVersion,
    });
    await this.searchRepository.saveSearchBatch(this.claimed, boundGoalVersion, batch, provenance);
    const disclosures = disclosureCodes(batch.coverage, provenance.claims);
    if (batch.semanticEvaluation.outcome === "FAILED") disclosures.push("SEMANTIC_RELEVANCE_UNAVAILABLE");
    disclosures.push(...(operation.assumptionDisclosureCodes ?? []));
    if (searchSource === "LOCAL_CACHE") disclosures.push("LOCAL_CANDIDATE_CACHE");
    return {
      workingSet: provenance.workingSet,
      result: {
        claims: provenance.claims,
        disclosureCodes: disclosures,
        publicResult: {
          coverage: batch.coverage,
          candidates: provenance.workingSet.pool.map((candidate) => ({
            offerRef: candidate.offerRef,
            title: candidate.title,
            model: candidate.canonicalModel,
            market: candidate.retrievalMarket,
            merchant: candidate.merchant,
            cnyAmount: candidate.cnyAmount,
            stock: candidate.stock,
            claimIds: candidate.claimIds,
            marketEvidenceLevel: candidate.marketEvidenceLevel,
            rankingReasonCodes: candidate.rankingReasonCodes,
            ranking: candidate.ranking,
            queryProductRelevance: candidate.queryProductRelevance,
            candidateAdmission: candidate.candidateAdmission,
          })),
          claims: provenance.claims.map((claim) => ({ claimId: claim.claimId, kind: claim.kind, renderedText: claim.renderedText, offerRefs: claim.offerRefs })),
          topReasonCode: batch.coverage.topReasonCode,
          searchSource,
        },
      },
    };
  }
}
