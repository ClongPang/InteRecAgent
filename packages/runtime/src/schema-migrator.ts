import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type pg from "pg";

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_ID = "497281340126";
const REQUIRED_TABLES: Readonly<Record<string, readonly string[]>> = {
  conversations: ["id", "tenant_id", "owner_id", "contract_version", "current_revision", "next_message_seq", "next_event_seq", "active_turn_id"],
  conversation_revisions: ["conversation_id", "revision", "parent_revision", "base_revision", "goal_version_id", "dialogue_state_version_id", "working_set_id", "quote_state_version_id"],
  messages: ["conversation_id", "seq", "role", "payload_json", "consumed_by_turn_id", "assistant_response_id"],
  turns: ["conversation_id", "client_turn_id", "request_hash", "base_revision", "status", "attempt", "fence_token", "lease_expires_at", "trace_id", "trace_root_observation_id", "trace_id_source"],
  turn_attempts: ["turn_id", "attempt", "fence_token", "status", "plan_json", "draft_json", "evidence_keys", "trace_id", "root_observation_id", "trace_id_source"],
  turn_plan_reviews: ["turn_id", "attempt", "proposal_number", "decision", "policy_version", "proposal_json", "reviewed_plan_json", "violations_json", "approved_plan_json"],
  goal_versions: ["conversation_id", "revision", "goal_json", "operations_json"],
  dialogue_state_versions: ["conversation_id", "revision", "state_json"],
  working_sets: ["conversation_id", "revision", "state_json", "proof_comparison_set_id"],
  working_set_items: ["working_set_id", "offer_ref", "candidate_json", "is_displayed", "is_rejected"],
  assistant_responses: ["conversation_id", "turn_id", "outcome", "rendered_text"],
  assistant_envelopes: ["response_id", "envelope_json"],
  claim_ledgers: ["response_id", "ledger_json"],
  turn_events: ["conversation_id", "turn_id", "seq", "event_type", "public_payload"],
  outbox: ["event_id", "topic", "payload", "published_at", "attempt_count", "locked_by", "locked_until", "dead_lettered_at"],
  tool_executions: ["turn_id", "attempt", "step_key", "request_hash", "status"],
  research_waves: ["conversation_id", "turn_id", "attempt", "wave_no", "query_hash", "coverage_json", "top_reason_code"],
  market_searches: ["research_wave_id", "market", "status", "result_count", "error_code", "artifact_ref"],
  provider_artifacts: ["conversation_id", "turn_id", "attempt", "artifact_ref", "provider_schema_version", "payload_json", "payload_sha256", "expires_at", "promoted_revision", "purged_at"],
  fx_snapshots: ["conversation_id", "turn_id", "attempt", "base", "quote", "rate", "promoted_revision"],
  source_facts: ["conversation_id", "turn_id", "attempt", "artifact_id", "source_fact_ref", "json_path", "canonical_value", "fx_snapshot_id", "promoted_revision"],
  source_listings: ["conversation_id", "turn_id", "attempt", "artifact_id", "listing_ref", "listing_json"],
  offer_qualifications: ["conversation_id", "turn_id", "attempt", "source_listing_id", "offer_ref", "comparison_key", "status", "reason_codes", "relevance_label", "relevance_json", "admission_cohort", "relevance_policy_version"],
  comparison_sets: ["conversation_id", "turn_id", "attempt", "version", "bound_goal_version", "status", "candidate_refs_hash", "coverage_json", "promoted_revision"],
  comparison_set_items: ["comparison_set_id", "qualification_id", "offer_ref", "rank", "candidate_json"],
  attempt_claims: ["conversation_id", "turn_id", "attempt", "claim_ref", "offer_ref", "kind", "canonical_value"],
  attempt_claim_evidence: ["attempt_claim_id", "source_fact_id", "fx_snapshot_id"],
  published_claims: ["response_id", "claim_id", "kind", "canonical_value"],
  published_claim_evidence: ["published_claim_id", "source_fact_id", "fx_snapshot_id"],
  provider_circuits: ["provider", "consecutive_failures", "open_until"],
  provider_permits: ["tenant_id", "provider", "turn_id", "attempt", "step_key", "is_retry", "status", "expires_at"],
  observed_candidates: ["tenant_id", "owner_id", "candidate_ref", "source_listing_id", "retrieval_market", "search_tokens", "candidate_json", "support_level", "observed_at", "expires_at"],
  candidate_feedback_events: ["tenant_id", "owner_id", "conversation_id", "turn_id", "attempt", "kind", "operation_id", "offer_refs", "payload_json"],
  quote_lead_sets: ["conversation_id", "turn_id", "attempt", "quote_lead_set_ref", "target_ref", "canonical_query", "contract_version", "outcome", "provider_status", "provider_meta_json", "artifact_ref", "lead_set_json", "observed_at", "status", "published_revision"],
  quote_provider_artifacts: ["conversation_id", "lead_set_id", "artifact_ref", "provider_contract_version", "payload_json", "payload_sha256", "observed_at", "expires_at", "purged_at"],
  quote_observations: ["conversation_id", "lead_set_id", "artifact_id", "observation_ref", "record_index", "raw_record_json", "observation_json", "admission_status", "admission_reason_codes", "admission_policy_version"],
  quote_fx_snapshots: ["conversation_id", "lead_set_id", "fx_snapshot_ref", "base", "quote", "rate", "snapshot_json"],
  quote_leads: ["conversation_id", "lead_set_id", "quote_lead_ref", "merchant_target_url", "condition", "lead_json"],
  quote_lead_observations: ["conversation_id", "lead_set_id", "quote_lead_id", "observation_id", "ordinal"],
  quote_source_facts: ["conversation_id", "lead_set_id", "quote_lead_id", "observation_id", "source_fact_ref", "fact_kind", "json_path", "canonical_value"],
  quote_claims: ["conversation_id", "lead_set_id", "quote_lead_id", "claim_ref", "kind", "canonical_value"],
  quote_claim_evidence: ["conversation_id", "lead_set_id", "quote_claim_id", "source_fact_id", "quote_fx_snapshot_id"],
  quote_state_versions: ["conversation_id", "revision", "state_json", "quote_lead_set_id", "committed_by_turn_id"],
  product_identity_registry_versions: ["registry_version", "schema_version", "status", "checksum", "source_ref", "activated_at"],
  product_brands: ["registry_version", "brand_ref", "canonical_name", "aliases_json", "source_ref"],
  canonical_products: ["registry_version", "product_ref", "brand_ref", "canonical_name", "product_type", "source_ref"],
  product_variants: ["registry_version", "variant_ref", "product_ref", "canonical_model", "attributes_json", "status", "source_ref"],
  product_identifiers: ["registry_version", "identifier_ref", "variant_ref", "brand_ref", "scheme", "normalized_value", "approval_status", "source_ref"],
  product_aliases: ["registry_version", "alias_ref", "variant_ref", "purpose", "display_value", "normalized_key", "approval_status", "priority", "source_ref"],
  product_relationships: ["registry_version", "relationship_ref", "from_variant_ref", "to_variant_ref", "kind", "source_ref"],
};
const REQUIRED_CONSTRAINTS = [
  "conversations_active_turn_fk",
  "conversations_status_check",
  "messages_conversation_id_seq_key",
  "messages_role_check",
  "turns_conversation_id_client_turn_id_key",
  "turns_status_check",
  "turns_conversation_id_id_key",
  "turn_attempts_pkey",
  "turn_attempts_status_check",
  "turn_plan_reviews_turn_id_attempt_proposal_number_key",
  "offer_qualifications_relevance_label_check",
  "offer_qualifications_admission_cohort_check",
  "turns_trace_id_check",
  "turns_trace_root_observation_id_check",
  "turn_attempts_trace_id_check",
  "turn_attempts_observation_id_check",
  "turns_trace_identity_provenance_check",
  "turn_attempts_trace_identity_provenance_check",
  "turn_input_messages_turn_id_ordinal_key",
  "assistant_responses_turn_id_key",
  "turn_events_conversation_id_seq_key",
  "outbox_event_id_key",
  "outbox_lock_pair_check",
  "tool_executions_turn_id_step_key_key",
  "working_sets_proof_comparison_set_fk",
  "comparison_sets_conversation_id_version_key",
  "provider_permits_turn_id_step_key_key",
  "quote_lead_sets_turn_attempt_fk",
  "quote_lead_sets_publication_pair_check",
  "quote_lead_observations_lead_fk",
  "quote_lead_observations_observation_fk",
  "quote_source_facts_lead_fk",
  "quote_source_facts_observation_fk",
  "quote_claims_lead_fk",
  "quote_claim_evidence_claim_fk",
  "quote_claim_evidence_fact_fk",
  "quote_claim_evidence_fx_fk",
  "conversations_contract_version_check",
  "quote_state_contract_check",
  "quote_state_lead_set_fk",
  "conversation_revisions_quote_state_fk",
  "product_identity_registry_activation_check",
  "canonical_products_brand_fk",
  "product_variants_product_fk",
  "product_identifiers_variant_fk",
  "product_identifiers_brand_fk",
  "product_aliases_variant_fk",
  "product_relationships_from_variant_fk",
  "product_relationships_to_variant_fk",
] as const;
const REQUIRED_INDEXES = [
  "conversations_owner_updated_idx",
  "turns_claim_idx",
  "messages_timeline_idx",
  "events_cursor_idx",
  "outbox_pending_idx",
  "outbox_claim_idx",
  "tool_executions_attempt_idx",
  "turn_plan_reviews_attempt_idx",
  "offer_qualifications_relevance_idx",
  "artifacts_expiry_idx",
  "source_facts_ref_idx",
  "comparison_sets_promotion_idx",
  "provider_permits_active_idx",
  "observed_candidates_search_tokens_idx",
  "observed_candidates_owner_market_expiry_idx",
  "candidate_feedback_owner_timeline_idx",
  "turns_trace_id_idx",
  "quote_lead_sets_conversation_timeline_idx",
  "quote_observations_lead_set_idx",
  "quote_leads_lead_set_idx",
  "quote_source_facts_ref_idx",
  "quote_artifacts_expiry_idx",
  "quote_state_versions_conversation_revision_idx",
  "product_identity_one_active_version_idx",
  "product_identifiers_approved_gtin_unique_idx",
  "product_identifiers_approved_brand_mpn_unique_idx",
  "product_identifiers_lookup_idx",
  "product_aliases_resolution_idx",
  "product_aliases_provider_priority_unique_idx",
] as const;
const REQUIRED_TRIGGERS = [
  "source_facts_promoted_immutable",
  "fx_snapshots_promoted_immutable",
  "comparison_sets_promoted_immutable",
  "provider_artifacts_promoted_restricted",
  "published_claims_immutable",
  "published_claim_evidence_immutable",
  "candidate_feedback_append_only",
  "turn_plan_reviews_append_only",
  "quote_lead_sets_update_guard",
  "quote_provider_artifacts_update_guard",
  "quote_observations_immutable",
  "quote_fx_snapshots_immutable",
  "quote_leads_immutable",
  "quote_lead_observations_immutable",
  "quote_source_facts_immutable",
  "quote_claims_immutable",
  "quote_claim_evidence_immutable",
  "quote_state_versions_immutable",
  "product_identity_registry_version_guard",
  "product_brands_version_guard",
  "canonical_products_version_guard",
  "product_variants_version_guard",
  "product_identifiers_version_guard",
  "product_aliases_version_guard",
  "product_relationships_version_guard",
] as const;
const REQUIRED_RLS_TABLES = [
  "conversations",
  "messages",
  "turns",
  "turn_attempts",
  "turn_plan_reviews",
  "conversation_revisions",
  "goal_versions",
  "dialogue_state_versions",
  "working_sets",
  "assistant_responses",
  "assistant_envelopes",
  "claim_ledgers",
  "turn_events",
  "research_waves",
  "provider_artifacts",
  "source_facts",
  "comparison_sets",
  "observed_candidates",
  "candidate_feedback_events",
  "quote_lead_sets",
  "quote_provider_artifacts",
  "quote_observations",
  "quote_fx_snapshots",
  "quote_leads",
  "quote_lead_observations",
  "quote_source_facts",
  "quote_claims",
  "quote_claim_evidence",
  "quote_state_versions",
  "product_identity_registry_versions",
  "product_brands",
  "canonical_products",
  "product_variants",
  "product_identifiers",
  "product_aliases",
  "product_relationships",
] as const;

export interface MigrationResult {
  applied: string[];
  verifiedTables: number;
}

async function bootstrapMigrationLedger(client: pg.PoolClient): Promise<void> {
  const schema = await client.query<{ exists: boolean }>("SELECT to_regnamespace('interec_agent') IS NOT NULL AS exists");
  if (!schema.rows[0]?.exists) await client.query("CREATE SCHEMA interec_agent");
  const ledger = await client.query<{ exists: boolean }>("SELECT to_regclass('interec_agent.schema_migrations') IS NOT NULL AS exists");
  if (!ledger.rows[0]?.exists) {
    await client.query(`CREATE TABLE interec_agent.schema_migrations (
      version integer PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
  }
}

export async function verifyConversationSchema(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'interec_agent'`,
  );
  const found = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const columns = found.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    found.set(row.table_name, columns);
  }
  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    const actual = found.get(table);
    if (!actual) throw new Error(`SCHEMA_DRIFT: missing table interec_agent.${table}`);
    for (const column of columns) {
      if (!actual.has(column)) throw new Error(`SCHEMA_DRIFT: missing column interec_agent.${table}.${column}`);
    }
  }
  const constraints = await client.query<{ conname: string }>(
    `SELECT c.conname
     FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'interec_agent'`,
  );
  const constraintNames = new Set(constraints.rows.map((row) => row.conname));
  for (const constraint of REQUIRED_CONSTRAINTS) {
    if (!constraintNames.has(constraint)) throw new Error(`SCHEMA_DRIFT: missing constraint interec_agent.${constraint}`);
  }
  const indexes = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'interec_agent'",
  );
  const indexNames = new Set(indexes.rows.map((row) => row.indexname));
  for (const index of REQUIRED_INDEXES) {
    if (!indexNames.has(index)) throw new Error(`SCHEMA_DRIFT: missing index interec_agent.${index}`);
  }
  const triggers = await client.query<{ tgname: string }>(
    `SELECT t.tgname
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'interec_agent' AND NOT t.tgisinternal`,
  );
  const triggerNames = new Set(triggers.rows.map((row) => row.tgname));
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!triggerNames.has(trigger)) throw new Error(`SCHEMA_DRIFT: missing trigger interec_agent.${trigger}`);
  }
  const rls = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'interec_agent' AND c.relrowsecurity`,
  );
  const rlsTables = new Set(rls.rows.map((row) => row.relname));
  for (const table of REQUIRED_RLS_TABLES) {
    if (!rlsTables.has(table)) throw new Error(`SCHEMA_DRIFT: RLS is disabled on interec_agent.${table}`);
  }
  return Object.keys(REQUIRED_TABLES).length;
}

export async function runConversationMigrations(pool: pg.Pool, migrationUrl = new URL("../conversation-migrations/", import.meta.url)): Promise<MigrationResult> {
  const migrationPath = fileURLToPath(migrationUrl);
  const files = (await readdir(migrationPath)).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("NO_CONVERSATION_MIGRATIONS");
  const client = await pool.connect();
  const applied: string[] = [];
  await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
  try {
    await bootstrapMigrationLedger(client);
    for (const filename of files) {
      const match = filename.match(MIGRATION_NAME);
      if (!match) throw new Error(`INVALID_MIGRATION_FILENAME: ${filename}`);
      const version = Number(match[1]);
      const sql = await readFile(new URL(filename, migrationUrl), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const recorded = await client.query<{ checksum: string; filename: string }>(
        "SELECT checksum, filename FROM interec_agent.schema_migrations WHERE version = $1",
        [version],
      );
      if (recorded.rows[0]) {
        if (recorded.rows[0].checksum !== checksum || recorded.rows[0].filename !== filename) {
          throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${filename}`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO interec_agent.schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)",
          [version, filename, checksum],
        );
        await client.query("COMMIT");
        applied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied, verifiedTables: await verifyConversationSchema(client) };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}
