import { createHash, randomUUID } from "node:crypto";

import type { QuoteLeadSet } from "@retail-price/domain";
import type pg from "pg";

import type { ClaimedConversationTurn, OwnerClaims } from "./conversation-repository-types.js";
import type { QuoteLookupExecution } from "./quote-lookup-service.js";
import type { QuoteProvenanceBundle } from "./quote-provenance.js";
import { withOwnerSnapshotTransaction } from "./postgres-conversation-storage.js";

export interface SavedQuoteLookup {
  quoteLeadSetId: string;
  quoteLeadSetRef: string;
  replayed: boolean;
}

export type CompletedQuoteLookupExecution = Extract<QuoteLookupExecution, { status: "LOOKUP_COMPLETED" }>;

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("QUOTE_PAYLOAD_NOT_JSON_SERIALIZABLE");
  return serialized;
}

function assertPersistenceBundle(execution: CompletedQuoteLookupExecution, provenance: QuoteProvenanceBundle): void {
  const { artifact, leadSet } = execution;
  const sha = createHash("sha256").update(json(artifact.rawPayload)).digest("hex");
  if (artifact.payloadSha256 !== sha || artifact.artifactRef !== `sha256:${sha}`) throw new Error("QUOTE_ARTIFACT_HASH_MISMATCH");
  if (leadSet.observations.some((observation) => observation.artifactRef !== artifact.artifactRef)) {
    throw new Error("QUOTE_OBSERVATION_ARTIFACT_MISMATCH");
  }
  const observations = new Set(leadSet.observations.map((observation) => observation.observationRef));
  if (observations.size !== leadSet.observations.length) throw new Error("DUPLICATE_QUOTE_OBSERVATION_REF");
  const admissionRefs = new Set(leadSet.admissions.map((admission) => admission.observationRef));
  if (admissionRefs.size !== leadSet.admissions.length || admissionRefs.size !== observations.size || [...observations].some((ref) => !admissionRefs.has(ref))) {
    throw new Error("QUOTE_ADMISSION_COVERAGE_INCOMPLETE");
  }
  const eligible = new Set(leadSet.admissions.filter((admission) => admission.status === "ELIGIBLE").map((admission) => admission.observationRef));
  const leadRefs = new Set(leadSet.leads.map((lead) => lead.quoteLeadRef));
  if (leadRefs.size !== leadSet.leads.length) throw new Error("DUPLICATE_QUOTE_LEAD_REF");
  for (const lead of leadSet.leads) {
    if (lead.observationRefs.length === 0 || lead.observationRefs.some((ref) => !observations.has(ref) || !eligible.has(ref))) {
      throw new Error("QUOTE_LEAD_HAS_INELIGIBLE_OBSERVATION");
    }
  }
  const factRefs = new Set(provenance.sourceFacts.map((fact) => fact.sourceFactRef));
  const fxRefs = new Set(leadSet.fxSnapshots.map((snapshot) => snapshot.id));
  if (provenance.sourceFacts.some((fact) => !observations.has(fact.observationRef) || !leadRefs.has(fact.quoteLeadRef))) {
    throw new Error("QUOTE_SOURCE_FACT_RELATION_MISMATCH");
  }
  if (provenance.claims.some((claim) => !leadRefs.has(claim.quoteLeadRef)
    || claim.evidenceRefs.length === 0
    || claim.evidenceRefs.some((evidence) => !factRefs.has(evidence.sourceFactRef) || (evidence.fxSnapshotId !== null && !fxRefs.has(evidence.fxSnapshotId))))) {
    throw new Error("QUOTE_CLAIM_EVIDENCE_INCOMPLETE");
  }
}

export class PostgresQuoteLookupRepository {
  public constructor(public readonly pool: pg.Pool) {}

  public async saveQuoteLookup(
    claimed: ClaimedConversationTurn,
    execution: CompletedQuoteLookupExecution,
    provenance: QuoteProvenanceBundle,
  ): Promise<SavedQuoteLookup> {
    assertPersistenceBundle(execution, provenance);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('retail_price.tenant_id', $1, true), set_config('retail_price.owner_id', $2, true)",
        [claimed.owner.tenantId, claimed.owner.ownerId],
      );
      const valid = await client.query(
        `SELECT t.id
         FROM retail_price_agent.turns t
         JOIN retail_price_agent.turn_attempts ta ON ta.turn_id = t.id AND ta.attempt = t.attempt
         WHERE t.id = $1 AND t.conversation_id = $2 AND t.attempt = $3 AND t.fence_token = $4::bigint
           AND t.status = 'RUNNING' AND ta.status = 'RUNNING'
           AND t.lease_expires_at > clock_timestamp() AND t.deadline_at > clock_timestamp()
         FOR UPDATE OF t, ta`,
        [claimed.id, claimed.conversationId, claimed.attempt, claimed.fenceToken],
      );
      if (valid.rowCount !== 1) throw new Error("QUOTE_LOOKUP_FENCE_REJECTED");

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM retail_price_agent.quote_lead_sets
         WHERE turn_id = $1 AND attempt = $2 AND quote_lead_set_ref = $3`,
        [claimed.id, claimed.attempt, execution.leadSet.quoteLeadSetRef],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return {
          quoteLeadSetId: existing.rows[0].id,
          quoteLeadSetRef: execution.leadSet.quoteLeadSetRef,
          replayed: true,
        };
      }

      const leadSetId = randomUUID();
      const { artifact, leadSet } = execution;
      await client.query(
        `INSERT INTO retail_price_agent.quote_lead_sets
           (id, conversation_id, turn_id, attempt, quote_lead_set_ref, target_ref, target_json,
            canonical_query, contract_version, outcome, reason_codes, provider_status,
            provider_failure_code, provider_retryable, provider_meta_json, provider_contract_version,
            artifact_ref, lead_set_json, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12,
                 $13, $14, $15::jsonb, $16, $17, $18::jsonb, $19)` ,
        [
          leadSetId,
          claimed.conversationId,
          claimed.id,
          claimed.attempt,
          leadSet.quoteLeadSetRef,
          leadSet.target.targetRef,
          json(leadSet.target),
          leadSet.target.canonicalQuery,
          leadSet.contractVersion,
          leadSet.outcome,
          json(leadSet.reasonCodes),
          leadSet.provider.status,
          leadSet.provider.failureCode,
          leadSet.provider.retryable,
          json(leadSet.provider.meta),
          leadSet.provider.contractVersion,
          artifact.artifactRef,
          json(leadSet),
          leadSet.observedAt,
        ],
      );

      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO retail_price_agent.quote_provider_artifacts
           (id, conversation_id, lead_set_id, artifact_ref, provider, provider_contract_version,
            payload_json, payload_sha256, observed_at, expires_at, retention_policy)
         VALUES ($1, $2, $3, $4, 'buywhere', $5, $6::jsonb, $7, $8,
                 $8::timestamptz + interval '7 days', 'buywhere-quote-raw-7d-v1')`,
        [artifactId, claimed.conversationId, leadSetId, artifact.artifactRef, artifact.providerContractVersion, json(artifact.rawPayload), artifact.payloadSha256, artifact.observedAt],
      );

      const fxIds = new Map<string, string>();
      for (const snapshot of leadSet.fxSnapshots) {
        const id = randomUUID();
        fxIds.set(snapshot.id, id);
        await client.query(
          `INSERT INTO retail_price_agent.quote_fx_snapshots
             (id, conversation_id, lead_set_id, fx_snapshot_ref, base, quote, rate, provider,
              observed_at, expires_at, snapshot_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11::jsonb)`,
          [id, claimed.conversationId, leadSetId, snapshot.id, snapshot.base, snapshot.quote, snapshot.rate, snapshot.provider, snapshot.observedAt, snapshot.expiresAt, json(snapshot)],
        );
      }

      const admissionByRef = new Map(leadSet.admissions.map((admission) => [admission.observationRef, admission]));
      const observationIds = new Map<string, string>();
      for (const observation of leadSet.observations) {
        const admission = admissionByRef.get(observation.observationRef)!;
        const id = randomUUID();
        observationIds.set(observation.observationRef, id);
        await client.query(
          `INSERT INTO retail_price_agent.quote_observations
             (id, conversation_id, lead_set_id, artifact_id, observation_ref, record_index, json_path,
              raw_record_json, observation_json, admission_status, admission_reason_codes,
              admission_policy_version, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13)`,
          [id, claimed.conversationId, leadSetId, artifactId, observation.observationRef, observation.recordIndex, observation.jsonPath, json(observation.rawRecord), json(observation), admission.status, json(admission.reasonCodes), admission.policyVersion, observation.observedAt],
        );
      }

      const leadIds = new Map<string, string>();
      for (const lead of leadSet.leads) {
        const id = randomUUID();
        leadIds.set(lead.quoteLeadRef, id);
        await client.query(
          `INSERT INTO retail_price_agent.quote_leads
             (id, conversation_id, lead_set_id, quote_lead_ref, merchant_target_url, condition, lead_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [id, claimed.conversationId, leadSetId, lead.quoteLeadRef, lead.merchantTargetUrl, lead.condition, json(lead)],
        );
        for (const [index, observationRef] of lead.observationRefs.entries()) {
          await client.query(
            `INSERT INTO retail_price_agent.quote_lead_observations
               (conversation_id, lead_set_id, quote_lead_id, observation_id, ordinal)
             VALUES ($1, $2, $3, $4, $5)`,
            [claimed.conversationId, leadSetId, id, observationIds.get(observationRef), index + 1],
          );
        }
      }

      const sourceFactIds = new Map<string, string>();
      for (const fact of provenance.sourceFacts) {
        const id = randomUUID();
        sourceFactIds.set(fact.sourceFactRef, id);
        await client.query(
          `INSERT INTO retail_price_agent.quote_source_facts
             (id, conversation_id, lead_set_id, quote_lead_id, observation_id, source_fact_ref,
              fact_kind, json_path, canonical_value, evidence_status, observed_at, derivation, policy_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)`,
          [id, claimed.conversationId, leadSetId, leadIds.get(fact.quoteLeadRef), observationIds.get(fact.observationRef), fact.sourceFactRef, fact.factKind, fact.jsonPath, json(fact.canonicalValue), fact.evidenceStatus, fact.observedAt, fact.derivation, fact.policyVersion],
        );
      }

      for (const claim of provenance.claims) {
        const claimId = randomUUID();
        await client.query(
          `INSERT INTO retail_price_agent.quote_claims
             (id, conversation_id, lead_set_id, quote_lead_id, claim_ref, kind, canonical_value)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [claimId, claimed.conversationId, leadSetId, leadIds.get(claim.quoteLeadRef), claim.claimRef, claim.kind, json(claim.canonicalValue)],
        );
        for (const evidence of claim.evidenceRefs) {
          await client.query(
            `INSERT INTO retail_price_agent.quote_claim_evidence
               (conversation_id, lead_set_id, quote_claim_id, source_fact_id, quote_fx_snapshot_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [claimed.conversationId, leadSetId, claimId, sourceFactIds.get(evidence.sourceFactRef), evidence.fxSnapshotId === null ? null : fxIds.get(evidence.fxSnapshotId)],
          );
        }
      }

      await client.query("COMMIT");
      return { quoteLeadSetId: leadSetId, quoteLeadSetRef: leadSet.quoteLeadSetRef, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async loadQuoteLeadSet(owner: OwnerClaims, conversationId: string, quoteLeadSetRef: string): Promise<QuoteLeadSet | null> {
    return withOwnerSnapshotTransaction(this.pool, owner, async (client) => {
      const result = await client.query<{ lead_set_json: QuoteLeadSet }>(
        `SELECT lead_set_json FROM retail_price_agent.quote_lead_sets
         WHERE conversation_id = $1 AND quote_lead_set_ref = $2
         ORDER BY observed_at DESC LIMIT 1`,
        [conversationId, quoteLeadSetRef],
      );
      return result.rows[0]?.lead_set_json ?? null;
    });
  }
}
