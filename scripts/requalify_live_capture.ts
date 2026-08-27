import pg from "pg";

import {
  buildComparisonSet,
  canonicalModels,
  qualifyListing,
  resolveCategoryContract,
  resolveMarketContract,
  resolveProductIdentity,
  type DiscoveredListing,
  type FxSnapshot,
  type Goal,
  type Market,
  type ShoppingGoal,
} from "@interec/domain";

if (process.env["INTEREC_LIVE_INSPECT_CONFIRM"] !== "authorized-local-evidence") {
  throw new Error("INTEREC_LIVE_INSPECT_CONFIRM_MUST_BE_authorized-local-evidence");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function proofGoal(shopping: ShoppingGoal): Goal {
  if (!shopping.target) throw new Error("REQUALIFY_TARGET_REQUIRED");
  const contract = resolveCategoryContract(shopping.target.categoryId);
  if (!contract) throw new Error("REQUALIFY_CATEGORY_CONTRACT_REQUIRED");
  const markets = shopping.retrievalMarkets.map((value) => {
    const market = resolveMarketContract(value);
    if (!market) throw new Error(`REQUALIFY_MARKET_CONTRACT_REQUIRED:${value}`);
    return market.marketId as Market;
  });
  return {
    query: [shopping.target.canonicalModel, shopping.target.categoryId].filter(Boolean).join(" "),
    target: {
      categoryId: contract.categoryId,
      canonicalModel: shopping.target.canonicalModel
        ? canonicalModels(shopping.target.canonicalModel, contract.categoryId)[0] ?? shopping.target.canonicalModel.toUpperCase()
        : null,
      itemRole: shopping.target.itemRole,
      conditionPreference: shopping.target.condition === "ANY"
        ? "ANY"
        : shopping.target.condition === "NEW" ? "NEW_OR_UNSPECIFIED" : shopping.target.condition,
    },
    markets,
    budgetCny: shopping.budget?.amount ?? null,
    stockPreference: shopping.stockPreference,
    excludedOfferRefs: shopping.exclusions.filter((item) => item.kind === "OFFER").map((item) => item.value),
    hardConstraints: shopping.hardConstraints.map(({ source: _source, ...constraint }) => constraint),
  };
}

const tenantId = process.env["INTEREC_LIVE_INSPECT_TENANT"]?.trim() || "live-acceptance";
const ownerId = process.env["INTEREC_LIVE_INSPECT_OWNER"]?.trim() || "browser-acceptance";
const pool = new pg.Pool({ connectionString: required("INTEREC_DATABASE_URL") });

try {
  const conversation = await pool.query<{ id: string }>(
    `SELECT id FROM interec_agent.conversations
      WHERE tenant_id = $1 AND owner_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, ownerId],
  );
  const conversationId = conversation.rows[0]?.id;
  if (!conversationId) throw new Error("LIVE_CONVERSATION_NOT_FOUND");
  const goalResult = await pool.query<{ goal_json: ShoppingGoal }>(
    `SELECT goal_json FROM interec_agent.goal_versions
      WHERE conversation_id = $1 ORDER BY revision DESC LIMIT 1`,
    [conversationId],
  );
  const shoppingGoal = goalResult.rows[0]?.goal_json;
  if (!shoppingGoal) throw new Error("LIVE_GOAL_NOT_FOUND");
  const listings = (await pool.query<{ listing_json: DiscoveredListing }>(
    `SELECT listing_json FROM interec_agent.source_listings WHERE conversation_id = $1 ORDER BY listing_ref`,
    [conversationId],
  )).rows.map((row) => row.listing_json);
  const fxSnapshots = (await pool.query<FxSnapshot>(
    `SELECT id, base, quote, rate::text AS rate, provider,
            observed_at AS "observedAt", expires_at AS "expiresAt"
       FROM interec_agent.fx_snapshots WHERE conversation_id = $1 ORDER BY observed_at DESC`,
    [conversationId],
  )).rows;
  const latestFxByCurrency = new Map<string, FxSnapshot>();
  for (const fx of fxSnapshots) if (!latestFxByCurrency.has(fx.base)) latestFxByCurrency.set(fx.base, fx);
  const goal = proofGoal(shoppingGoal);
  const reidentified = listings.map((listing) => {
    const title = listing.title.value ?? "";
    const classification = [
      ...(listing.categoryPath.value ?? []),
      listing.providerProductType.value,
    ].filter((value): value is string => Boolean(value)).join(" ");
    const evidence = [
      ...listing.title.evidence,
      ...listing.categoryPath.evidence,
      ...listing.providerProductType.evidence,
    ];
    return {
      ...listing,
      identity: resolveProductIdentity(title, classification, goal.target, evidence),
    };
  });
  const qualifications = reidentified.map((listing) => qualifyListing(listing, goal, latestFxByCurrency));
  const reasonCounts = new Map<string, number>();
  for (const qualification of qualifications) {
    for (const reason of qualification.reasonCodes) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const comparison = buildComparisonSet(reidentified, goal, latestFxByCurrency);
  process.stdout.write(`${JSON.stringify({
    conversationId,
    listingCount: listings.length,
    comparableCount: qualifications.filter((item) => item.status === "COMPARABLE").length,
    reasonCounts: Object.fromEntries([...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    rankedOffers: comparison.rankedOffers.slice(0, 8).map(({ offer, rank }) => ({
      rank,
      offerRef: offer.offerRef,
      title: offer.title,
      canonicalModel: offer.productIdentity.canonicalModel.value,
      market: offer.retrievalMarket,
      merchantDomain: offer.merchantDomain,
      comparisonKey: offer.productIdentity.comparisonKey,
      cnyAmount: offer.cnyEstimate.amount,
      condition: offer.condition,
    })),
    externalCalls: 0,
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
