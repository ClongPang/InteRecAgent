CREATE TABLE interec_agent.quote_lead_sets (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  quote_lead_set_ref text NOT NULL,
  target_ref text NOT NULL,
  target_json jsonb NOT NULL,
  canonical_query text NOT NULL CHECK (length(btrim(canonical_query)) > 0),
  contract_version text NOT NULL CHECK (contract_version = 'quote-leads-sg-v1'),
  outcome text NOT NULL CHECK (outcome IN ('QUOTE_LEADS', 'NO_QUOTE_LEADS', 'DEGRADED')),
  reason_codes jsonb NOT NULL,
  provider_status text NOT NULL CHECK (provider_status IN ('OK_RESULTS', 'OK_EMPTY', 'DEGRADED', 'FAILED')),
  provider_failure_code text,
  provider_retryable boolean,
  provider_meta_json jsonb NOT NULL,
  provider_contract_version text NOT NULL,
  artifact_ref text NOT NULL,
  lead_set_json jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  published_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, attempt, quote_lead_set_ref),
  UNIQUE (id, conversation_id),
  CONSTRAINT quote_lead_sets_turn_attempt_fk
    FOREIGN KEY (turn_id, attempt) REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE,
  CONSTRAINT quote_lead_sets_publication_pair_check
    CHECK ((status = 'PUBLISHED') = (published_revision IS NOT NULL))
);

CREATE TABLE interec_agent.quote_provider_artifacts (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL UNIQUE REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  artifact_ref text NOT NULL,
  provider text NOT NULL CHECK (provider = 'buywhere'),
  provider_contract_version text NOT NULL,
  payload_json jsonb,
  payload_sha256 text NOT NULL CHECK (length(payload_sha256) = 64),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
  retention_policy text NOT NULL,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lead_set_id, artifact_ref),
  CHECK ((payload_json IS NULL) = (purged_at IS NOT NULL))
);

CREATE TABLE interec_agent.quote_observations (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES interec_agent.quote_provider_artifacts(id) ON DELETE RESTRICT,
  observation_ref text NOT NULL,
  record_index integer NOT NULL CHECK (record_index >= 0),
  json_path text NOT NULL,
  raw_record_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  admission_status text NOT NULL CHECK (admission_status IN ('ELIGIBLE', 'REJECTED', 'INSUFFICIENT_EVIDENCE')),
  admission_reason_codes jsonb NOT NULL,
  admission_policy_version text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lead_set_id, observation_ref),
  UNIQUE (lead_set_id, record_index),
  UNIQUE (id, lead_set_id)
);

CREATE TABLE interec_agent.quote_fx_snapshots (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  fx_snapshot_ref text NOT NULL,
  base text NOT NULL,
  quote text NOT NULL CHECK (quote = 'CNY'),
  rate numeric NOT NULL CHECK (rate > 0),
  provider text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lead_set_id, fx_snapshot_ref),
  UNIQUE (id, lead_set_id)
);

CREATE TABLE interec_agent.quote_leads (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  quote_lead_ref text NOT NULL,
  merchant_target_url text NOT NULL,
  condition text NOT NULL CHECK (condition IN ('NEW', 'REFURBISHED', 'USED', 'UNKNOWN')),
  lead_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lead_set_id, quote_lead_ref),
  UNIQUE (id, lead_set_id)
);

CREATE TABLE interec_agent.quote_lead_observations (
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  quote_lead_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (quote_lead_id, observation_id),
  UNIQUE (quote_lead_id, ordinal),
  CONSTRAINT quote_lead_observations_lead_fk
    FOREIGN KEY (quote_lead_id, lead_set_id) REFERENCES interec_agent.quote_leads(id, lead_set_id) ON DELETE CASCADE,
  CONSTRAINT quote_lead_observations_observation_fk
    FOREIGN KEY (observation_id, lead_set_id) REFERENCES interec_agent.quote_observations(id, lead_set_id) ON DELETE RESTRICT
);

CREATE TABLE interec_agent.quote_source_facts (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  quote_lead_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  source_fact_ref text NOT NULL,
  fact_kind text NOT NULL,
  json_path text NOT NULL,
  canonical_value jsonb NOT NULL,
  evidence_status text NOT NULL CHECK (evidence_status IN ('OBSERVED', 'DERIVED')),
  observed_at timestamptz NOT NULL,
  derivation text NOT NULL CHECK (derivation IN ('OBSERVED', 'DERIVED')),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lead_set_id, source_fact_ref),
  UNIQUE (id, lead_set_id),
  CONSTRAINT quote_source_facts_lead_fk
    FOREIGN KEY (quote_lead_id, lead_set_id) REFERENCES interec_agent.quote_leads(id, lead_set_id) ON DELETE CASCADE,
  CONSTRAINT quote_source_facts_observation_fk
    FOREIGN KEY (observation_id, lead_set_id) REFERENCES interec_agent.quote_observations(id, lead_set_id) ON DELETE RESTRICT
);

CREATE TABLE interec_agent.quote_claims (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  quote_lead_id uuid NOT NULL,
  claim_ref text NOT NULL,
  kind text NOT NULL,
  canonical_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lead_set_id, claim_ref),
  UNIQUE (id, lead_set_id),
  CONSTRAINT quote_claims_lead_fk
    FOREIGN KEY (quote_lead_id, lead_set_id) REFERENCES interec_agent.quote_leads(id, lead_set_id) ON DELETE CASCADE
);

CREATE TABLE interec_agent.quote_claim_evidence (
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  lead_set_id uuid NOT NULL REFERENCES interec_agent.quote_lead_sets(id) ON DELETE CASCADE,
  quote_claim_id uuid NOT NULL,
  source_fact_id uuid NOT NULL,
  quote_fx_snapshot_id uuid,
  PRIMARY KEY (quote_claim_id, source_fact_id),
  CONSTRAINT quote_claim_evidence_claim_fk
    FOREIGN KEY (quote_claim_id, lead_set_id) REFERENCES interec_agent.quote_claims(id, lead_set_id) ON DELETE CASCADE,
  CONSTRAINT quote_claim_evidence_fact_fk
    FOREIGN KEY (source_fact_id, lead_set_id) REFERENCES interec_agent.quote_source_facts(id, lead_set_id) ON DELETE RESTRICT,
  CONSTRAINT quote_claim_evidence_fx_fk
    FOREIGN KEY (quote_fx_snapshot_id, lead_set_id) REFERENCES interec_agent.quote_fx_snapshots(id, lead_set_id) ON DELETE RESTRICT
);

CREATE INDEX quote_lead_sets_conversation_timeline_idx
  ON interec_agent.quote_lead_sets (conversation_id, observed_at DESC, id);
CREATE INDEX quote_observations_lead_set_idx
  ON interec_agent.quote_observations (lead_set_id, record_index);
CREATE INDEX quote_leads_lead_set_idx
  ON interec_agent.quote_leads (lead_set_id, quote_lead_ref);
CREATE INDEX quote_source_facts_ref_idx
  ON interec_agent.quote_source_facts (conversation_id, source_fact_ref);
CREATE INDEX quote_artifacts_expiry_idx
  ON interec_agent.quote_provider_artifacts (expires_at, id) WHERE purged_at IS NULL;

CREATE FUNCTION interec_agent.reject_quote_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'QUOTE_EVIDENCE_IMMUTABLE:%', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION interec_agent.restrict_quote_artifact_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payload_json IS NULL
     AND OLD.payload_json IS NOT NULL
     AND NEW.purged_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['payload_json', 'purged_at']) = (to_jsonb(OLD) - ARRAY['payload_json', 'purged_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'QUOTE_ARTIFACT_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION interec_agent.restrict_quote_lead_set_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'DRAFT'
     AND OLD.published_revision IS NULL
     AND NEW.status = 'PUBLISHED'
     AND NEW.published_revision IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['status', 'published_revision']) = (to_jsonb(OLD) - ARRAY['status', 'published_revision']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'QUOTE_LEAD_SET_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER quote_lead_sets_update_guard
  BEFORE UPDATE ON interec_agent.quote_lead_sets
  FOR EACH ROW EXECUTE FUNCTION interec_agent.restrict_quote_lead_set_update();
CREATE TRIGGER quote_provider_artifacts_update_guard
  BEFORE UPDATE ON interec_agent.quote_provider_artifacts
  FOR EACH ROW EXECUTE FUNCTION interec_agent.restrict_quote_artifact_update();
CREATE TRIGGER quote_observations_immutable
  BEFORE UPDATE ON interec_agent.quote_observations
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();
CREATE TRIGGER quote_fx_snapshots_immutable
  BEFORE UPDATE ON interec_agent.quote_fx_snapshots
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();
CREATE TRIGGER quote_leads_immutable
  BEFORE UPDATE ON interec_agent.quote_leads
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();
CREATE TRIGGER quote_lead_observations_immutable
  BEFORE UPDATE ON interec_agent.quote_lead_observations
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();
CREATE TRIGGER quote_source_facts_immutable
  BEFORE UPDATE ON interec_agent.quote_source_facts
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();
CREATE TRIGGER quote_claims_immutable
  BEFORE UPDATE ON interec_agent.quote_claims
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();
CREATE TRIGGER quote_claim_evidence_immutable
  BEFORE UPDATE ON interec_agent.quote_claim_evidence
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();

ALTER TABLE interec_agent.quote_lead_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_lead_sets_owner_policy ON interec_agent.quote_lead_sets
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_provider_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_provider_artifacts_owner_policy ON interec_agent.quote_provider_artifacts
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_observations_owner_policy ON interec_agent.quote_observations
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_fx_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_fx_snapshots_owner_policy ON interec_agent.quote_fx_snapshots
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_leads_owner_policy ON interec_agent.quote_leads
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_lead_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_lead_observations_owner_policy ON interec_agent.quote_lead_observations
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_source_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_source_facts_owner_policy ON interec_agent.quote_source_facts
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_claims_owner_policy ON interec_agent.quote_claims
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
ALTER TABLE interec_agent.quote_claim_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_claim_evidence_owner_policy ON interec_agent.quote_claim_evidence
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
