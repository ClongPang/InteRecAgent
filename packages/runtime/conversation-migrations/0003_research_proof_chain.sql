CREATE TABLE interec_agent.research_waves (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  wave_no integer NOT NULL CHECK (wave_no > 0 AND wave_no <= 4),
  query_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  coverage_json jsonb NOT NULL DEFAULT '{}',
  top_reason_code text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (turn_id, attempt, wave_no),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE TABLE interec_agent.market_searches (
  id uuid PRIMARY KEY,
  research_wave_id uuid NOT NULL REFERENCES interec_agent.research_waves(id) ON DELETE CASCADE,
  market text NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  error_code text,
  artifact_ref text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (research_wave_id, market)
);

CREATE TABLE interec_agent.provider_artifacts (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  research_wave_id uuid NOT NULL REFERENCES interec_agent.research_waves(id) ON DELETE CASCADE,
  artifact_ref text NOT NULL,
  provider text NOT NULL,
  provider_schema_version text NOT NULL,
  retrieval_market text NOT NULL,
  payload_json jsonb,
  payload_sha256 text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  retention_policy text NOT NULL,
  promoted_revision bigint,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE,
  CHECK ((payload_json IS NULL) = (purged_at IS NOT NULL))
);

CREATE UNIQUE INDEX provider_artifacts_wave_ref_key
  ON interec_agent.provider_artifacts (research_wave_id, artifact_ref);

ALTER TABLE interec_agent.market_searches
  ADD CONSTRAINT market_searches_artifact_fk
  FOREIGN KEY (research_wave_id, artifact_ref)
  REFERENCES interec_agent.provider_artifacts(research_wave_id, artifact_ref)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE interec_agent.fx_snapshots (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  base text NOT NULL,
  quote text NOT NULL CHECK (quote = 'CNY'),
  rate numeric NOT NULL CHECK (rate > 0),
  provider text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  promoted_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE TABLE interec_agent.source_facts (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  artifact_id uuid NOT NULL REFERENCES interec_agent.provider_artifacts(id) ON DELETE RESTRICT,
  source_fact_ref text NOT NULL,
  offer_ref text,
  fact_kind text NOT NULL,
  json_path text NOT NULL,
  canonical_value jsonb NOT NULL,
  evidence_status text NOT NULL CHECK (evidence_status IN ('OBSERVED', 'DERIVED', 'VERIFIED', 'UNKNOWN', 'CONFLICTED', 'EXPIRED')),
  provider_schema_version text NOT NULL,
  policy_version text NOT NULL,
  observed_at timestamptz NOT NULL,
  derivation text NOT NULL CHECK (derivation IN ('OBSERVED', 'DERIVED')),
  fx_snapshot_id uuid REFERENCES interec_agent.fx_snapshots(id) ON DELETE RESTRICT,
  promoted_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, attempt, source_fact_ref),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE TABLE interec_agent.source_listings (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  research_wave_id uuid NOT NULL REFERENCES interec_agent.research_waves(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES interec_agent.provider_artifacts(id) ON DELETE RESTRICT,
  listing_ref text NOT NULL,
  provider text NOT NULL,
  retrieval_market text NOT NULL,
  listing_json jsonb NOT NULL,
  UNIQUE (turn_id, attempt, listing_ref),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE TABLE interec_agent.offer_qualifications (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  source_listing_id uuid NOT NULL REFERENCES interec_agent.source_listings(id) ON DELETE CASCADE,
  offer_ref text,
  comparison_key text,
  status text NOT NULL CHECK (status IN ('COMPARABLE', 'INELIGIBLE', 'INSUFFICIENT_EVIDENCE')),
  reason_codes jsonb NOT NULL,
  comparable_offer_json jsonb,
  policy_version text NOT NULL,
  UNIQUE (turn_id, attempt, source_listing_id),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE,
  CHECK ((status = 'COMPARABLE') = (offer_ref IS NOT NULL AND comparison_key IS NOT NULL AND comparable_offer_json IS NOT NULL))
);

CREATE TABLE interec_agent.comparison_sets (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  version bigint NOT NULL CHECK (version > 0),
  bound_goal_version bigint NOT NULL CHECK (bound_goal_version > 0),
  policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PROMOTED', 'ABANDONED')),
  candidate_refs_hash text NOT NULL,
  coverage_json jsonb NOT NULL,
  top_reason_code text,
  promoted_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, version),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE,
  CHECK ((status = 'PROMOTED') = (promoted_revision IS NOT NULL))
);

CREATE TABLE interec_agent.comparison_set_items (
  comparison_set_id uuid NOT NULL REFERENCES interec_agent.comparison_sets(id) ON DELETE CASCADE,
  qualification_id uuid NOT NULL REFERENCES interec_agent.offer_qualifications(id) ON DELETE RESTRICT,
  offer_ref text NOT NULL,
  rank integer NOT NULL CHECK (rank > 0),
  ranking_reason_codes jsonb NOT NULL,
  candidate_json jsonb NOT NULL,
  PRIMARY KEY (comparison_set_id, offer_ref),
  UNIQUE (comparison_set_id, rank)
);

ALTER TABLE interec_agent.working_sets ADD COLUMN proof_comparison_set_id uuid;
ALTER TABLE interec_agent.working_sets
  ADD CONSTRAINT working_sets_proof_comparison_set_fk
  FOREIGN KEY (proof_comparison_set_id) REFERENCES interec_agent.comparison_sets(id) ON DELETE RESTRICT;

CREATE TABLE interec_agent.attempt_claims (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  claim_ref text NOT NULL,
  offer_ref text,
  kind text NOT NULL,
  canonical_value jsonb NOT NULL,
  rendered_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, attempt, claim_ref),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE TABLE interec_agent.attempt_claim_evidence (
  attempt_claim_id uuid NOT NULL REFERENCES interec_agent.attempt_claims(id) ON DELETE CASCADE,
  source_fact_id uuid NOT NULL REFERENCES interec_agent.source_facts(id) ON DELETE RESTRICT,
  fx_snapshot_id uuid REFERENCES interec_agent.fx_snapshots(id) ON DELETE RESTRICT,
  PRIMARY KEY (attempt_claim_id, source_fact_id)
);

CREATE TABLE interec_agent.published_claims (
  id uuid PRIMARY KEY,
  response_id uuid NOT NULL REFERENCES interec_agent.assistant_responses(id) ON DELETE CASCADE,
  claim_id text NOT NULL,
  kind text NOT NULL,
  canonical_value jsonb NOT NULL,
  rendered_text text NOT NULL,
  UNIQUE (response_id, claim_id)
);

CREATE TABLE interec_agent.published_claim_evidence (
  published_claim_id uuid NOT NULL REFERENCES interec_agent.published_claims(id) ON DELETE CASCADE,
  source_fact_id uuid NOT NULL REFERENCES interec_agent.source_facts(id) ON DELETE RESTRICT,
  fx_snapshot_id uuid REFERENCES interec_agent.fx_snapshots(id) ON DELETE RESTRICT,
  PRIMARY KEY (published_claim_id, source_fact_id)
);

CREATE TABLE interec_agent.provider_circuits (
  provider text PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  open_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE interec_agent.provider_permits (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  provider text NOT NULL,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  step_key text NOT NULL,
  is_retry boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  error_code text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (turn_id, step_key),
  FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE INDEX research_waves_turn_idx ON interec_agent.research_waves (turn_id, attempt, wave_no);
CREATE INDEX artifacts_expiry_idx ON interec_agent.provider_artifacts (expires_at, id) WHERE purged_at IS NULL;
CREATE INDEX source_facts_ref_idx ON interec_agent.source_facts (conversation_id, source_fact_ref);
CREATE INDEX comparison_sets_promotion_idx ON interec_agent.comparison_sets (turn_id, attempt, status, candidate_refs_hash);
CREATE INDEX attempt_claims_ref_idx ON interec_agent.attempt_claims (conversation_id, claim_ref);
CREATE INDEX provider_permits_active_idx ON interec_agent.provider_permits (provider, expires_at) WHERE status = 'ACTIVE';
CREATE INDEX provider_permits_tenant_window_idx ON interec_agent.provider_permits (tenant_id, provider, acquired_at DESC);
