import {
  DomainError,
  canonicalProductModel,
  resolveCategoryRecommendationCapability,
  resolveCategoryContract,
  resolveMarketContract,
  tokenizeDiscoveryText,
  type ConversationState,
  type Goal,
  type Market,
  type ProductTarget,
  type ResearchCoverage,
  type ShoppingGoal,
  type VerifiedClaim,
  type WorldOperation,
} from "@interec/domain";
import type { TurnWorldPort, WorldOperationResult } from "@interec/agent";

import type { ClaimedConversationTurn, ConversationRepository } from "./conversation-repository-types.js";
import { PostgresConversationResearchRepository } from "./conversation-research-repository.js";
import { DurableGovernedFxPort, DurableGovernedProductSearchPort } from "./governed-providers.js";
import { PostgresProviderGovernor } from "./provider-governor.js";
import { PostgresObservedCandidateRepository, type ObservedCandidateRepository } from "./observed-candidate-repository.js";
import type { FxPort, ProductSearchPort } from "./providers.js";
import { buildResearchProofBundle } from "./research-proof.js";
import { runResearchCampaign } from "./search-service.js";
import { runtimeMetrics } from "./telemetry.js";

function proofTarget(goal: ShoppingGoal): ProductTarget {
  if (!goal.target) throw new DomainError("RESEARCH_TARGET_REQUIRED", "Research requires a resolved shopping target");
  const capability = resolveCategoryRecommendationCapability(goal.target.categoryId, goal.target.targetText);
  const contract = capability.adapter;
  return {
    categoryId: capability.categoryId,
    targetText: goal.target.targetText ?? goal.target.categoryId,
    canonicalModel: goal.target.canonicalModel
      ? contract
        ? canonicalProductModel(goal.target.canonicalModel, contract.categoryId) ?? goal.target.canonicalModel.toUpperCase()
        : goal.target.canonicalModel.normalize("NFKC").trim()
      : null,
    itemRole: goal.target.itemRole,
    conditionPreference: goal.target.condition === "ANY" ? "ANY" : goal.target.condition,
  };
}

function qualificationGoal(state: ConversationState): Goal {
  const shopping = state.goalRevision?.goal;
  if (!shopping) throw new DomainError("RESEARCH_GOAL_REQUIRED", "Research requires a committed shopping goal");
  if (shopping.budget && shopping.budget.currency.toUpperCase() !== "CNY") {
    throw new DomainError("BUDGET_CURRENCY_UNSUPPORTED", "The proof kernel currently requires a CNY budget");
  }
  const unsupportedMarkets = shopping.retrievalMarkets.filter((market) => !resolveMarketContract(market));
  if (unsupportedMarkets.length > 0) throw new DomainError("UNSUPPORTED_MARKET_CONTRACT", unsupportedMarkets.join(","));
  const markets = shopping.retrievalMarkets.map((market) => resolveMarketContract(market)!.marketId as Market);
  if (markets.length === 0) throw new DomainError("RESEARCH_MARKETS_REQUIRED", "Research requires at least one supported retrieval market");
  const target = proofTarget(shopping);
  const contract = resolveCategoryContract(target.categoryId);
  const constraintTerms = shopping.hardConstraints.flatMap((constraint) =>
    contract?.attributeProofs.find((proof) =>
      proof.key === constraint.key
      && proof.value === constraint.value
      && constraint.operator === "EQ"
    )?.queryTerms ?? [Array.isArray(constraint.value) ? constraint.value.join(" ") : String(constraint.value)]
  );
  return {
    query: [...new Set([target.canonicalModel ?? resolveCategoryRecommendationCapability(target.categoryId, target.targetText).queryTerm, ...constraintTerms])].join(" "),
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

export function queryVariants(operation: Extract<WorldOperation, { kind: "RESEARCH_OFFERS" }>, goal: Goal): string[] {
  const requiredTerms = resolveCategoryContract(goal.target.categoryId)?.attributeProofs
    .filter((proof) => goal.hardConstraints?.some((constraint) =>
      constraint.key === proof.key
      && constraint.value === proof.value
      && constraint.operator === "EQ"
    ))
    .flatMap((proof) => proof.queryTerms) ?? [];
  const withRequiredTerms = (value: string) => [...new Set([value.trim(), ...requiredTerms].filter(Boolean))].join(" ");
  const primary = goal.query.trim();
  const requested = operation.queryVariant?.trim();
  const broader = [...new Set([goal.target.canonicalModel, goal.target.targetText, resolveCategoryContract(goal.target.categoryId)?.broaderQueryTerm, goal.target.categoryId]
    .filter(Boolean))]
    .join(" ")
    .trim();
  return [...new Set([primary, requested ? withRequiredTerms(requested) : "", withRequiredTerms(broader)].filter(Boolean))];
}

function disclosureCodes(coverage: ResearchCoverage, claims: readonly VerifiedClaim[]): string[] {
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
  if (claims.length > 0 && claims.every((claim) => claim.kind !== "MODEL")) codes.add("DISCOVERY_OFFER_IDENTITY_ONLY");
  return [...codes];
}

function claimKindForField(field: Extract<WorldOperation, { kind: "INSPECT_WORKING_SET" }>["fields"][number]): VerifiedClaim["kind"] | null {
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

export class ConversationResearchWorld implements TurnWorldPort {
  private readonly observedCandidates: ObservedCandidateRepository;

  public constructor(
    private readonly claimed: ClaimedConversationTurn,
    private readonly turnRepository: ConversationRepository,
    private readonly researchRepository: PostgresConversationResearchRepository,
    private readonly governor: PostgresProviderGovernor,
    private readonly productSource: ProductSearchPort,
    private readonly fxSource: FxPort,
    observedCandidates?: ObservedCandidateRepository,
  ) {
    this.observedCandidates = observedCandidates ?? new PostgresObservedCandidateRepository(researchRepository.pool);
  }

  public async inspect(
    operation: Extract<WorldOperation, { kind: "INSPECT_WORKING_SET" }>,
    offerRefs: string[],
    _state: ConversationState,
  ): Promise<WorldOperationResult> {
    const available = await this.researchRepository.loadPromotedClaims(this.claimed.conversationId, offerRefs);
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

  public async inspectResearchCoverage(
    _operation: Extract<WorldOperation, { kind: "INSPECT_RESEARCH_COVERAGE" }>,
    _state: ConversationState,
  ): Promise<WorldOperationResult> {
    const historical = await this.researchRepository.loadLatestPromotedResearchCoverage(
      this.claimed.owner,
      this.claimed.conversationId,
    );
    if (!historical) {
      return {
        claims: [],
        disclosureCodes: ["RESEARCH_COVERAGE_UNKNOWN"],
        publicResult: { found: false },
      };
    }
    const failedMarkets = [...new Set(historical.coverage.failedMarkets)].sort();
    return {
      claims: [],
      disclosureCodes: failedMarkets.length > 0
        ? [`RESEARCH_COVERAGE_INCOMPLETE:${failedMarkets.join(",")}`]
        : [],
      publicResult: {
        found: true,
        waveNo: historical.waveNo,
        status: historical.status,
        completedAt: historical.completedAt,
        promotedRevision: historical.promotedRevision,
        coverage: historical.coverage,
        marketOutcomes: historical.marketOutcomes,
        interpretation: failedMarkets.length > 0
          ? "INCOMPLETE_COVERAGE_DOES_NOT_PROVE_MARKET_ABSENCE"
          : "COVERAGE_COMPLETED",
      },
    };
  }

  public async research(
    operation: Extract<WorldOperation, { kind: "RESEARCH_OFFERS" }>,
    state: ConversationState,
    signal?: AbortSignal,
  ) {
    const goal = qualificationGoal(state);
    const variants = queryVariants(operation, goal);
    const waveByQuery = new Map(variants.map((query, index) => [query, index + 1]));
    const governedProduct: ProductSearchPort = {
      search: (query, market, limit, callSignal) => new DurableGovernedProductSearchPort(
        this.productSource,
        this.turnRepository,
        this.governor,
        {
          tenantId: this.claimed.owner.tenantId,
          turnId: this.claimed.id,
          attempt: this.claimed.attempt,
          fenceToken: this.claimed.fenceToken,
          operationId: operation.opId,
          waveNo: waveByQuery.get(query) ?? 1,
        },
      ).search(query, market, limit, callSignal),
    };
    const governedFx = new DurableGovernedFxPort(this.fxSource, this.turnRepository, this.governor, {
      tenantId: this.claimed.owner.tenantId,
      turnId: this.claimed.id,
      attempt: this.claimed.attempt,
      fenceToken: this.claimed.fenceToken,
      operationId: operation.opId,
    });
    const cacheTokens = tokenizeDiscoveryText([
      goal.query,
      goal.target.targetText,
      goal.target.categoryId,
      goal.target.canonicalModel,
      ...(goal.preferenceHints ?? []).map((preference) => Array.isArray(preference.value) ? preference.value.join(" ") : String(preference.value)),
    ].filter(Boolean).join(" "));
    let researchSource: "LOCAL_CACHE" | "PROVIDER" = "PROVIDER";
    let selectedProductSource: ProductSearchPort = governedProduct;
    let selectedVariants = variants;
    if (cacheTokens.length > 0) {
      let cacheOutcome: "hit" | "miss" | "error" = "miss";
      try {
        const cached = await this.observedCandidates.search(this.claimed.owner, {
          tokens: cacheTokens,
          markets: goal.markets,
          limit: 24,
        });
        const cachedMarkets = new Set(cached.map((candidate) => candidate.retrievalMarket));
        if (cached.length >= 3 && goal.markets.every((market) => cachedMarkets.has(market))) {
          const artifacts = await this.observedCandidates.loadArtifacts(
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
            researchSource = "LOCAL_CACHE";
            cacheOutcome = "hit";
          }
        }
      } catch {
        // Cache is an optimization. Provider research remains the safe fallback.
        cacheOutcome = "error";
      } finally {
        runtimeMetrics.candidateCacheLookups.add(1, { outcome: cacheOutcome });
      }
    }
    const campaign = await runResearchCampaign(goal, selectedVariants, selectedProductSource, governedFx, signal);
    const boundGoalVersion = state.goalRevision?.version;
    if (!boundGoalVersion) throw new DomainError("RESEARCH_GOAL_REQUIRED", "Research requires a published goal version");
    const proof = buildResearchProofBundle({
      comparisonSet: campaign.comparisonSet,
      artifacts: campaign.artifacts,
      coverage: campaign.coverage,
      workingSetVersion: state.revision,
      boundGoalVersion,
    });
    await this.researchRepository.saveCampaign(this.claimed, boundGoalVersion, campaign, proof);
    const disclosures = disclosureCodes(campaign.coverage, proof.claims);
    if (researchSource === "LOCAL_CACHE") disclosures.push("LOCAL_CANDIDATE_CACHE");
    return {
      workingSet: proof.workingSet,
      result: {
        claims: proof.claims,
        disclosureCodes: disclosures,
        publicResult: {
          coverage: campaign.coverage,
          candidates: proof.workingSet.pool.map((candidate) => ({
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
            discovery: candidate.discovery,
          })),
          claims: proof.claims.map((claim) => ({ claimId: claim.claimId, kind: claim.kind, renderedText: claim.renderedText, offerRefs: claim.offerRefs })),
          topReasonCode: campaign.coverage.topReasonCode,
          researchSource,
        },
      },
    };
  }
}
