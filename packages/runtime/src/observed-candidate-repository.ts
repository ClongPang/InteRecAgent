import type { RecommendationSupportLevel } from "@interec/domain";
import type pg from "pg";

import type { OwnerClaims } from "./conversation-repository-types.js";
import type { MarketSearchResult } from "./providers.js";

export interface ObservedCandidate {
  candidateRef: string;
  sourceListingId: string;
  provider: string;
  providerListingId: string;
  retrievalMarket: string;
  title: string;
  categoryHint: string | null;
  productType: string | null;
  searchTokens: string[];
  candidate: Record<string, unknown>;
  supportLevel: RecommendationSupportLevel;
  identityKey: string | null;
  observedAt: string;
  expiresAt: string;
}

export interface ObservedCandidateSearch {
  tokens: string[];
  markets?: string[];
  limit?: number;
  now?: string;
}

export interface RankedObservedCandidate extends ObservedCandidate {
  matchedTokenCount: number;
  tokenCoverage: number;
}

export interface ObservedCandidateRepository {
  upsert(owner: OwnerClaims, candidates: readonly ObservedCandidate[]): Promise<number>;
  search(owner: OwnerClaims, input: ObservedCandidateSearch): Promise<RankedObservedCandidate[]>;
  loadArtifacts(owner: OwnerClaims, candidateRefs: readonly string[], now?: string): Promise<MarketSearchResult[]>;
  deleteExpired(owner: OwnerClaims, batchSize?: number): Promise<number>;
}

type CandidateRow = {
  candidate_ref: string;
  source_listing_id: string;
  provider: string;
  provider_listing_id: string;
  retrieval_market: string;
  title: string;
  category_hint: string | null;
  product_type: string | null;
  search_tokens: string[];
  candidate_json: Record<string, unknown>;
  support_level: RecommendationSupportLevel;
  identity_key: string | null;
  observed_at: Date | string;
  expires_at: Date | string;
  matched_token_count?: number;
};

function requiredText(value: string, code: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function boundedTokens(tokens: readonly string[]): string[] {
  const values = [...new Set(tokens.map((token) => token.normalize("NFKC").trim().toLocaleLowerCase("en-US")).filter(Boolean))];
  if (values.length < 1 || values.length > 128) throw new Error("INVALID_OBSERVED_CANDIDATE_TOKENS");
  return values;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_OBSERVED_CANDIDATE_TIMESTAMP");
  return date.toISOString();
}

function candidateFromRow(row: CandidateRow, queryTokenCount: number): RankedObservedCandidate {
  const matchedTokenCount = Number(row.matched_token_count ?? 0);
  return {
    candidateRef: row.candidate_ref,
    sourceListingId: row.source_listing_id,
    provider: row.provider,
    providerListingId: row.provider_listing_id,
    retrievalMarket: row.retrieval_market,
    title: row.title,
    categoryHint: row.category_hint,
    productType: row.product_type,
    searchTokens: row.search_tokens,
    candidate: row.candidate_json,
    supportLevel: row.support_level,
    identityKey: row.identity_key,
    observedAt: timestamp(row.observed_at),
    expiresAt: timestamp(row.expires_at),
    matchedTokenCount,
    tokenCoverage: queryTokenCount === 0 ? 0 : matchedTokenCount / queryTokenCount,
  };
}

async function withOwnerTransaction<T>(pool: pg.Pool, owner: OwnerClaims, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)",
      [requiredText(owner.tenantId, "INVALID_TENANT_ID"), requiredText(owner.ownerId, "INVALID_OWNER_ID")],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresObservedCandidateRepository implements ObservedCandidateRepository {
  public constructor(private readonly pool: pg.Pool) {}

  public async upsert(owner: OwnerClaims, candidates: readonly ObservedCandidate[]): Promise<number> {
    if (candidates.length === 0) return 0;
    return withOwnerTransaction(this.pool, owner, async (client) => {
      let changed = 0;
      for (const candidate of candidates) {
        const observedAt = timestamp(candidate.observedAt);
        const expiresAt = timestamp(candidate.expiresAt);
        if (Date.parse(expiresAt) <= Date.parse(observedAt)) throw new Error("INVALID_OBSERVED_CANDIDATE_EXPIRY");
        const result = await client.query(
          `INSERT INTO interec_agent.observed_candidates
             (tenant_id, owner_id, candidate_ref, source_listing_id, provider, provider_listing_id,
              retrieval_market, title, category_hint, product_type, search_tokens, candidate_json,
              support_level, identity_key, observed_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13, $14, $15, $16)
           ON CONFLICT (tenant_id, owner_id, candidate_ref) DO UPDATE SET
             source_listing_id = EXCLUDED.source_listing_id,
             provider = EXCLUDED.provider,
             provider_listing_id = EXCLUDED.provider_listing_id,
             retrieval_market = EXCLUDED.retrieval_market,
             title = EXCLUDED.title,
             category_hint = EXCLUDED.category_hint,
             product_type = EXCLUDED.product_type,
             search_tokens = EXCLUDED.search_tokens,
             candidate_json = EXCLUDED.candidate_json,
             support_level = EXCLUDED.support_level,
             identity_key = EXCLUDED.identity_key,
             observed_at = EXCLUDED.observed_at,
             expires_at = EXCLUDED.expires_at,
             updated_at = clock_timestamp()
           WHERE EXCLUDED.observed_at >= interec_agent.observed_candidates.observed_at`,
          [
            owner.tenantId,
            owner.ownerId,
            requiredText(candidate.candidateRef, "INVALID_CANDIDATE_REF"),
            requiredText(candidate.sourceListingId, "INVALID_SOURCE_LISTING_ID"),
            requiredText(candidate.provider, "INVALID_CANDIDATE_PROVIDER"),
            requiredText(candidate.providerListingId, "INVALID_PROVIDER_LISTING_ID"),
            requiredText(candidate.retrievalMarket, "INVALID_RETRIEVAL_MARKET").toUpperCase(),
            requiredText(candidate.title, "INVALID_CANDIDATE_TITLE"),
            candidate.categoryHint?.trim() || null,
            candidate.productType?.trim() || null,
            boundedTokens(candidate.searchTokens),
            JSON.stringify(candidate.candidate),
            candidate.supportLevel,
            candidate.identityKey?.trim() || null,
            observedAt,
            expiresAt,
          ],
        );
        changed += result.rowCount ?? 0;
      }
      return changed;
    });
  }

  public async search(owner: OwnerClaims, input: ObservedCandidateSearch): Promise<RankedObservedCandidate[]> {
    const tokens = boundedTokens(input.tokens);
    const markets = [...new Set((input.markets ?? []).map((market) => requiredText(market, "INVALID_RETRIEVAL_MARKET").toUpperCase()))];
    const limit = input.limit ?? 24;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_OBSERVED_CANDIDATE_LIMIT");
    const now = input.now ? timestamp(input.now) : new Date().toISOString();
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<CandidateRow>(
        `SELECT oc.*,
                (SELECT count(DISTINCT token)::int
                 FROM unnest(oc.search_tokens) AS token
                 WHERE token = ANY($3::text[])) AS matched_token_count
         FROM interec_agent.observed_candidates oc
         WHERE oc.tenant_id = $1 AND oc.owner_id = $2
           AND oc.expires_at > $4::timestamptz
           AND oc.search_tokens && $3::text[]
           AND (cardinality($5::text[]) = 0 OR oc.retrieval_market = ANY($5::text[]))
         ORDER BY matched_token_count DESC, oc.observed_at DESC, oc.candidate_ref
         LIMIT $6`,
        [owner.tenantId, owner.ownerId, tokens, now, markets, limit],
      );
      return result.rows.map((row) => candidateFromRow(row, tokens.length));
    });
  }

  public async loadArtifacts(owner: OwnerClaims, candidateRefs: readonly string[], now?: string): Promise<MarketSearchResult[]> {
    const refs = [...new Set(candidateRefs.map((ref) => requiredText(ref, "INVALID_CANDIDATE_REF")))];
    if (refs.length === 0) return [];
    const effectiveNow = now ? timestamp(now) : new Date().toISOString();
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT DISTINCT ON (pa.artifact_ref)
                pa.artifact_ref, pa.retrieval_market, pa.payload_json, pa.observed_at
         FROM interec_agent.observed_candidates oc
         JOIN interec_agent.source_listings sl ON sl.id = oc.source_listing_id
         JOIN interec_agent.provider_artifacts pa ON pa.id = sl.artifact_id
         WHERE oc.tenant_id = $1 AND oc.owner_id = $2
           AND oc.candidate_ref = ANY($3::text[])
           AND oc.expires_at > $4::timestamptz
           AND pa.expires_at > $4::timestamptz
           AND pa.payload_json IS NOT NULL
         ORDER BY pa.artifact_ref, pa.observed_at DESC`,
        [owner.tenantId, owner.ownerId, refs, effectiveNow],
      );
      return result.rows.flatMap((row): MarketSearchResult[] => {
        const payload = row["payload_json"];
        const products = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)["data"]
          : null;
        if (!Array.isArray(products)) return [];
        return [{
          market: String(row["retrieval_market"]).toUpperCase() as MarketSearchResult["market"],
          products,
          artifactRef: String(row["artifact_ref"]),
          rawPayload: payload,
          observedAt: timestamp(String(row["observed_at"])),
        }];
      });
    });
  }

  public async deleteExpired(owner: OwnerClaims, batchSize = 100): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new Error("INVALID_OBSERVED_CANDIDATE_BATCH_SIZE");
    return withOwnerTransaction(this.pool, owner, async (client) => {
      const result = await client.query(
        `DELETE FROM interec_agent.observed_candidates
         WHERE (tenant_id, owner_id, candidate_ref) IN (
           SELECT tenant_id, owner_id, candidate_ref
           FROM interec_agent.observed_candidates
           WHERE tenant_id = $1 AND owner_id = $2 AND expires_at <= clock_timestamp()
           ORDER BY expires_at, candidate_ref
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )`,
        [owner.tenantId, owner.ownerId, batchSize],
      );
      return result.rowCount ?? 0;
    });
  }
}
