import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { tokenizeSearchText, type ClaimEvidenceRef, type SearchCoverage, type GroundedClaim } from "@interec/domain";

import type { ClaimedConversationTurn, OwnerClaims } from "./conversation-repository-types.js";
import { candidateRefsHash, type SearchProvenanceBundle } from "./search-provenance.js";
import type { OfferSearchBatchResult } from "./search-service.js";

export interface SavedSearchProvenance {
  rankedOfferSetId: string;
  version: number;
}

export interface HistoricalSearchCoverage {
  turnId: string;
  attempt: number;
  attemptNo: number;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  completedAt: string;
  publishedRevision: number;
  coverage: SearchCoverage;
  marketOutcomes: Array<{
    market: string;
    status: "COMPLETED" | "FAILED";
    resultCount: number;
  }>;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function timestampIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function attemptStatus(coverage: SearchCoverage): "COMPLETED" | "PARTIAL" | "FAILED" {
  if (coverage.completedMarkets.length === 0) return "FAILED";
  return coverage.failedMarkets.length > 0 ? "PARTIAL" : "COMPLETED";
}

export class PostgresConversationSearchRepository {
  public constructor(public readonly pool: pg.Pool) {}

  public async saveSearchBatch(
    claimed: ClaimedConversationTurn,
    boundGoalVersion: number,
    batch: OfferSearchBatchResult,
    provenance: SearchProvenanceBundle,
  ): Promise<SavedSearchProvenance> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)",
        [claimed.owner.tenantId, claimed.owner.ownerId],
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtext('interec-agent-artifact-cleaner'))");
      await client.query(
        `UPDATE interec_agent.tool_executions te
         SET result_json = jsonb_build_object(
           'purged', true,
           'provider', te.request_json->'provider',
           'market', te.request_json->'market',
           'queryHash', te.request_json->'queryHash'
         )
         WHERE te.status = 'SUCCEEDED'
           AND (te.step_key LIKE 'search:%:market:%' OR te.step_key LIKE 'research:%:market:%')
           AND EXISTS (
             SELECT 1 FROM interec_agent.provider_artifacts pa
             WHERE pa.turn_id = te.turn_id AND pa.promoted_revision IS NOT NULL
               AND pa.expires_at <= clock_timestamp()
           )`,
      );
      const valid = await client.query(
        `SELECT c.current_revision
         FROM interec_agent.turns t
         JOIN interec_agent.conversations c ON c.id = t.conversation_id
         JOIN interec_agent.turn_attempts ta ON ta.turn_id = t.id AND ta.attempt = t.attempt
         WHERE t.id = $1 AND t.conversation_id = $2 AND t.attempt = $3 AND t.fence_token = $4::bigint
           AND t.status = 'RUNNING' AND ta.status = 'RUNNING'
           AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()
         FOR UPDATE OF c, t, ta`,
        [claimed.id, claimed.conversationId, claimed.attempt, claimed.fenceToken],
      );
      if (valid.rowCount !== 1) throw new Error("SEARCH_FENCE_REJECTED");

      const artifactIds = new Map<string, string>();
      const attemptIds = new Map<number, string>();
      for (const attempt of batch.attempts) {
        const attemptId = randomUUID();
        attemptIds.set(attempt.attemptNo, attemptId);
        await client.query(
          `INSERT INTO interec_agent.research_waves
             (id, conversation_id, turn_id, attempt, wave_no, query_hash, status, coverage_json, top_reason_code, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, clock_timestamp())`,
          [attemptId, claimed.conversationId, claimed.id, claimed.attempt, attempt.attemptNo, queryHash(attempt.queryVariant), attemptStatus(attempt.coverage), JSON.stringify(attempt.coverage), attempt.coverage.topReasonCode],
        );
        for (const artifact of attempt.result.artifacts) {
          const sha = payloadHash(artifact.rawPayload);
          if (artifact.artifactRef !== `sha256:${sha}`) throw new Error("PROVIDER_ARTIFACT_HASH_MISMATCH");
          const artifactId = randomUUID();
          artifactIds.set(artifact.artifactRef, artifactId);
          await client.query(
            `INSERT INTO interec_agent.provider_artifacts
               (id, conversation_id, turn_id, attempt, research_wave_id, artifact_ref, provider,
                provider_schema_version, retrieval_market, payload_json, payload_sha256, observed_at,
                expires_at, retention_policy)
             VALUES ($1, $2, $3, $4, $5, $6, 'buywhere', 'buywhere-v1', $7, $8::jsonb, $9, $10,
                     $10::timestamptz + interval '7 days', 'buywhere-7d-v1')`,
            [artifactId, claimed.conversationId, claimed.id, claimed.attempt, attemptId, artifact.artifactRef, artifact.market, JSON.stringify(artifact.rawPayload), sha, artifact.observedAt],
          );
        }
        for (const market of attempt.result.markets) {
          await client.query(
            `INSERT INTO interec_agent.market_searches
               (id, research_wave_id, market, status, result_count, error_code, artifact_ref)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [randomUUID(), attemptId, market.market, market.status, market.resultCount, market.errorCode, market.artifactRef],
          );
        }
      }

      const fxIds = new Set<string>();
      for (const fx of batch.fxSnapshots) {
        if (fxIds.has(fx.id)) continue;
        fxIds.add(fx.id);
        await client.query(
          `INSERT INTO interec_agent.fx_snapshots
             (id, conversation_id, turn_id, attempt, base, quote, rate, provider, observed_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)`,
          [fx.id, claimed.conversationId, claimed.id, claimed.attempt, fx.base, fx.quote, fx.rate, fx.provider, fx.observedAt, fx.expiresAt],
        );
      }

      const listingIds = new Map<string, string>();
      for (const listing of batch.listings) {
        const artifactId = artifactIds.get(listing.rawArtifactRef);
        if (!artifactId) throw new Error(`LISTING_ARTIFACT_NOT_FOUND:${listing.rawArtifactRef}`);
        const artifact = batch.artifacts.find((item) => item.artifactRef === listing.rawArtifactRef);
        const attempt = batch.attempts.find((item) => item.result.artifacts.some((itemArtifact) => itemArtifact.artifactRef === listing.rawArtifactRef));
        if (!artifact || !attempt) throw new Error("LISTING_SEARCH_ATTEMPT_NOT_FOUND");
        const id = randomUUID();
        listingIds.set(listing.listingRef, id);
        await client.query(
          `INSERT INTO interec_agent.source_listings
             (id, conversation_id, turn_id, attempt, research_wave_id, artifact_id, listing_ref, provider, retrieval_market, listing_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [id, claimed.conversationId, claimed.id, claimed.attempt, attemptIds.get(attempt.attemptNo), artifactId, listing.listingRef, listing.provider, listing.retrievalMarket, JSON.stringify(listing)],
        );
      }

      const eligibilityIds = new Map<string, string>();
      for (const eligibility of batch.rankedOfferSet.eligibilityResults) {
        const sourceListingId = listingIds.get(eligibility.listing.listingRef);
        if (!sourceListingId) throw new Error("ELIGIBILITY_LISTING_NOT_FOUND");
        const id = randomUUID();
        await client.query(
          `INSERT INTO interec_agent.offer_qualifications
             (id, conversation_id, turn_id, attempt, source_listing_id, offer_ref, comparison_key,
              status, reason_codes, comparable_offer_json, policy_version, relevance_label,
              relevance_json, admission_cohort, relevance_policy_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13::jsonb, $14, $15)`,
          [
            id, claimed.conversationId, claimed.id, claimed.attempt, sourceListingId,
            eligibility.offer?.offerRef ?? null,
            eligibility.offer?.productIdentity.comparisonKey ?? null,
            eligibility.status,
            JSON.stringify(eligibility.reasonCodes),
            eligibility.offer ? JSON.stringify(eligibility.offer) : null,
            batch.rankedOfferSet.policyVersion,
            eligibility.queryProductRelevance.label,
            JSON.stringify(eligibility.queryProductRelevance),
            eligibility.candidateAdmission.cohort,
            eligibility.candidateAdmission.policyVersion,
          ],
        );
        if (eligibility.offer) eligibilityIds.set(eligibility.offer.offerRef, id);
      }

      const candidateByRef = new Map(provenance.workingSet.pool.map((candidate) => [candidate.offerRef, candidate]));
      for (const eligibility of batch.rankedOfferSet.eligibilityResults) {
        const offer = eligibility.offer;
        if (!offer) continue;
        const sourceListingId = listingIds.get(eligibility.listing.listingRef);
        const candidate = candidateByRef.get(offer.offerRef);
        if (!sourceListingId || !candidate) throw new Error("OBSERVED_CANDIDATE_PROJECTION_NOT_FOUND");
        const categoryHint = batch.goal.target.targetText ?? batch.goal.target.categoryId;
        const searchTokens = tokenizeSearchText([
          eligibility.listing.title.value,
          ...(eligibility.listing.categoryPath.value ?? []),
          eligibility.listing.providerProductType.value,
          categoryHint,
        ].filter(Boolean).join(" "));
        await client.query(
          `INSERT INTO interec_agent.observed_candidates
             (tenant_id, owner_id, candidate_ref, source_listing_id, provider, provider_listing_id,
              retrieval_market, title, category_hint, product_type, search_tokens, candidate_json,
              support_level, identity_key, observed_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13, $14, $15,
                   $15::timestamptz + interval '7 days')
           ON CONFLICT (tenant_id, owner_id, candidate_ref) DO UPDATE SET
             source_listing_id = EXCLUDED.source_listing_id,
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
            claimed.owner.tenantId,
            claimed.owner.ownerId,
            offer.offerRef,
            sourceListingId,
            eligibility.listing.provider,
            eligibility.listing.providerListingId,
            eligibility.listing.retrievalMarket,
            offer.title,
            categoryHint,
            eligibility.listing.providerProductType.value,
            searchTokens,
            JSON.stringify(candidate),
            offer.validationMode,
            offer.ranking.identityKey,
            eligibility.listing.observedAt,
          ],
        );
      }

      const sourceFactIds = new Map<string, string>();
      for (const fact of provenance.sourceFacts) {
        const artifactId = artifactIds.get(fact.artifactRef);
        if (!artifactId) throw new Error(`SOURCE_FACT_ARTIFACT_NOT_FOUND:${fact.artifactRef}`);
        const id = randomUUID();
        sourceFactIds.set(fact.sourceFactRef, id);
        await client.query(
          `INSERT INTO interec_agent.source_facts
             (id, conversation_id, turn_id, attempt, artifact_id, source_fact_ref, offer_ref, fact_kind,
              json_path, canonical_value, evidence_status, provider_schema_version, policy_version,
              observed_at, derivation, fx_snapshot_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16)`,
          [id, claimed.conversationId, claimed.id, claimed.attempt, artifactId, fact.sourceFactRef, fact.offerRef, fact.factKind, fact.jsonPath, JSON.stringify(fact.canonicalValue), fact.evidenceStatus, fact.providerSchemaVersion, fact.policyVersion, fact.observedAt, fact.derivation, fact.fxSnapshotId ?? null],
        );
      }

      const versionResult = await client.query<{ version: string }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM interec_agent.comparison_sets WHERE conversation_id = $1`,
        [claimed.conversationId],
      );
      const rankedOfferSetId = randomUUID();
      const version = Number(versionResult.rows[0]!.version);
      await client.query(
        `INSERT INTO interec_agent.comparison_sets
           (id, conversation_id, turn_id, attempt, version, bound_goal_version, policy_version, status,
            candidate_refs_hash, coverage_json, top_reason_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9::jsonb, $10)`,
        [rankedOfferSetId, claimed.conversationId, claimed.id, claimed.attempt, version, boundGoalVersion, batch.rankedOfferSet.policyVersion, candidateRefsHash(provenance.workingSet.pool.map((item) => item.offerRef)), JSON.stringify(batch.coverage), batch.coverage.topReasonCode],
      );
      for (const ranked of batch.rankedOfferSet.rankedOffers) {
        const eligibilityId = eligibilityIds.get(ranked.offer.offerRef);
        const candidate = provenance.workingSet.pool.find((item) => item.offerRef === ranked.offer.offerRef);
        if (!eligibilityId || !candidate) throw new Error("RANKED_OFFER_SOURCE_NOT_FOUND");
        await client.query(
          `INSERT INTO interec_agent.comparison_set_items
             (comparison_set_id, qualification_id, offer_ref, rank, ranking_reason_codes, candidate_json)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [rankedOfferSetId, eligibilityId, ranked.offer.offerRef, ranked.rank, JSON.stringify(ranked.rankingReasonCodes), JSON.stringify(candidate)],
        );
      }

      for (const claim of provenance.claims) {
        const claimId = randomUUID();
        await client.query(
          `INSERT INTO interec_agent.attempt_claims
             (id, conversation_id, turn_id, attempt, claim_ref, offer_ref, kind, canonical_value, rendered_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [claimId, claimed.conversationId, claimed.id, claimed.attempt, claim.claimId, claim.offerRefs[0] ?? null, claim.kind, JSON.stringify(claim.canonicalValue), claim.renderedText],
        );
        for (const evidence of claim.evidenceRefs) {
          const sourceFactId = sourceFactIds.get(evidence.sourceFactRef);
          if (!sourceFactId) throw new Error(`CLAIM_SOURCE_FACT_NOT_FOUND:${evidence.sourceFactRef}`);
          await client.query(
            `INSERT INTO interec_agent.attempt_claim_evidence (attempt_claim_id, source_fact_id, fx_snapshot_id)
             VALUES ($1, $2, $3)`,
            [claimId, sourceFactId, evidence.fxSnapshotId ?? null],
          );
        }
      }
      await client.query("COMMIT");
      return { rankedOfferSetId, version };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async loadPublishedClaims(conversationId: string, offerRefs: readonly string[]): Promise<GroundedClaim[]> {
    if (offerRefs.length === 0) return [];
    const rows = await this.pool.query<Record<string, unknown>>(
      `SELECT ac.claim_ref, ac.kind, ac.canonical_value, ac.rendered_text, ac.offer_ref,
              sf.source_fact_ref, pa.artifact_ref, sf.json_path, sf.canonical_value AS evidence_value,
              sf.provider_schema_version, sf.policy_version, sf.observed_at, sf.derivation,
              ace.fx_snapshot_id
       FROM interec_agent.attempt_claims ac
       JOIN interec_agent.attempt_claim_evidence ace ON ace.attempt_claim_id = ac.id
       JOIN interec_agent.source_facts sf ON sf.id = ace.source_fact_id
       JOIN interec_agent.provider_artifacts pa ON pa.id = sf.artifact_id
       WHERE ac.conversation_id = $1 AND ac.offer_ref = ANY($2::text[])
         AND sf.promoted_revision IS NOT NULL
       ORDER BY ac.claim_ref, sf.source_fact_ref`,
      [conversationId, offerRefs],
    );
    const byClaim = new Map<string, GroundedClaim>();
    for (const row of rows.rows) {
      const claimRef = String(row["claim_ref"]);
      const evidence: ClaimEvidenceRef = {
        artifactRef: String(row["artifact_ref"]),
        jsonPath: String(row["json_path"]),
        source: "buywhere",
        observedAt: timestampIso(row["observed_at"]),
        sourceFactRef: String(row["source_fact_ref"]),
        canonicalValue: row["evidence_value"],
        providerSchemaVersion: String(row["provider_schema_version"]),
        policyVersion: String(row["policy_version"]),
        derivation: String(row["derivation"]) as ClaimEvidenceRef["derivation"],
        ...(row["fx_snapshot_id"] ? { fxSnapshotId: String(row["fx_snapshot_id"]) } : {}),
      };
      const existing = byClaim.get(claimRef);
      if (existing) existing.evidenceRefs.push(evidence);
      else byClaim.set(claimRef, {
        claimId: claimRef,
        kind: String(row["kind"]) as GroundedClaim["kind"],
        canonicalValue: row["canonical_value"],
        renderedText: String(row["rendered_text"]),
        evidenceRefs: [evidence],
        offerRefs: [String(row["offer_ref"])],
      });
    }
    return [...byClaim.values()];
  }

  public async loadLatestPublishedSearchCoverage(
    owner: OwnerClaims,
    conversationId: string,
  ): Promise<HistoricalSearchCoverage | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "SELECT set_config('interec.tenant_id', $1, true), set_config('interec.owner_id', $2, true)",
        [owner.tenantId, owner.ownerId],
      );
      const result = await client.query<Record<string, unknown>>(
        `SELECT rw.turn_id, rw.attempt, rw.wave_no, rw.status, rw.completed_at,
                cs.promoted_revision, rw.coverage_json,
                COALESCE(
                  jsonb_agg(jsonb_build_object(
                    'market', ms.market,
                    'status', ms.status,
                    'resultCount', ms.result_count
                  ) ORDER BY ms.market) FILTER (WHERE ms.id IS NOT NULL),
                  '[]'::jsonb
                ) AS market_outcomes
         FROM interec_agent.comparison_sets cs
         JOIN interec_agent.conversations c ON c.id = cs.conversation_id
         JOIN interec_agent.turns t ON t.id = cs.turn_id
         JOIN interec_agent.research_waves rw
           ON rw.turn_id = cs.turn_id AND rw.attempt = cs.attempt
         LEFT JOIN interec_agent.market_searches ms ON ms.research_wave_id = rw.id
         WHERE cs.conversation_id = $3
           AND c.tenant_id = $1 AND c.owner_id = $2
           AND cs.status = 'PROMOTED' AND cs.promoted_revision IS NOT NULL
           AND t.status = 'COMPLETED' AND rw.completed_at IS NOT NULL
         GROUP BY rw.id, cs.promoted_revision
         ORDER BY cs.promoted_revision DESC, rw.wave_no DESC
         LIMIT 1`,
        [owner.tenantId, owner.ownerId, conversationId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) return null;
      return {
        turnId: String(row["turn_id"]),
        attempt: Number(row["attempt"]),
        attemptNo: Number(row["wave_no"]),
        status: String(row["status"]) as HistoricalSearchCoverage["status"],
        completedAt: timestampIso(row["completed_at"]),
        publishedRevision: Number(row["promoted_revision"]),
        coverage: structuredClone(row["coverage_json"]) as SearchCoverage,
        marketOutcomes: structuredClone(row["market_outcomes"] ?? []) as HistoricalSearchCoverage["marketOutcomes"],
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async cleanExpiredArtifacts(batchSize = 100): Promise<{ purged: number; deletedAttempts: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const purged = await client.query(
        `UPDATE interec_agent.provider_artifacts
         SET payload_json = NULL, purged_at = clock_timestamp()
         WHERE id IN (
           SELECT id FROM interec_agent.provider_artifacts
           WHERE promoted_revision IS NOT NULL AND expires_at <= clock_timestamp() AND purged_at IS NULL
           ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
         )`,
        [batchSize],
      );
      const attempts = await client.query<{ turn_id: string; attempt: number }>(
        `SELECT DISTINCT pa.turn_id, pa.attempt
         FROM interec_agent.provider_artifacts pa
         JOIN interec_agent.turn_attempts ta ON ta.turn_id = pa.turn_id AND ta.attempt = pa.attempt
         WHERE pa.promoted_revision IS NULL AND pa.expires_at <= clock_timestamp()
           AND ta.status IN ('ABANDONED', 'FAILED')
           AND NOT EXISTS (
             SELECT 1 FROM interec_agent.provider_artifacts newer
             WHERE newer.turn_id = pa.turn_id AND newer.attempt = pa.attempt
               AND newer.expires_at > clock_timestamp()
           )
         ORDER BY pa.turn_id, pa.attempt LIMIT $1`,
        [batchSize],
      );
      for (const attempt of attempts.rows) {
        const values = [attempt.turn_id, attempt.attempt];
        await client.query(`DELETE FROM interec_agent.comparison_sets WHERE turn_id = $1 AND attempt = $2 AND status <> 'PROMOTED'`, values);
        await client.query(`DELETE FROM interec_agent.attempt_claims WHERE turn_id = $1 AND attempt = $2`, values);
        await client.query(`DELETE FROM interec_agent.offer_qualifications WHERE turn_id = $1 AND attempt = $2`, values);
        await client.query(`DELETE FROM interec_agent.source_listings WHERE turn_id = $1 AND attempt = $2`, values);
        await client.query(`DELETE FROM interec_agent.source_facts WHERE turn_id = $1 AND attempt = $2 AND promoted_revision IS NULL`, values);
        await client.query(`DELETE FROM interec_agent.provider_artifacts WHERE turn_id = $1 AND attempt = $2 AND promoted_revision IS NULL`, values);
        await client.query(`DELETE FROM interec_agent.fx_snapshots WHERE turn_id = $1 AND attempt = $2 AND promoted_revision IS NULL`, values);
        await client.query(`DELETE FROM interec_agent.research_waves WHERE turn_id = $1 AND attempt = $2`, values);
      }
      await client.query("COMMIT");
      return { purged: purged.rowCount ?? 0, deletedAttempts: attempts.rowCount ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
