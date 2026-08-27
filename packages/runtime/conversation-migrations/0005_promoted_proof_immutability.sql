CREATE FUNCTION interec_agent.reject_promoted_proof_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.promoted_revision IS NOT NULL THEN
    RAISE EXCEPTION 'PROMOTED_PROOF_IMMUTABLE:%', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION interec_agent.restrict_promoted_artifact_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.promoted_revision IS NOT NULL THEN
    IF NEW.payload_json IS NULL
       AND OLD.payload_json IS NOT NULL
       AND NEW.purged_at IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['payload_json', 'purged_at']) = (to_jsonb(OLD) - ARRAY['payload_json', 'purged_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PROMOTED_ARTIFACT_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION interec_agent.reject_published_claim_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PUBLISHED_CLAIM_IMMUTABLE:%', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER source_facts_promoted_immutable
  BEFORE UPDATE ON interec_agent.source_facts
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_promoted_proof_update();

CREATE TRIGGER fx_snapshots_promoted_immutable
  BEFORE UPDATE ON interec_agent.fx_snapshots
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_promoted_proof_update();

CREATE TRIGGER comparison_sets_promoted_immutable
  BEFORE UPDATE ON interec_agent.comparison_sets
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_promoted_proof_update();

CREATE TRIGGER provider_artifacts_promoted_restricted
  BEFORE UPDATE ON interec_agent.provider_artifacts
  FOR EACH ROW EXECUTE FUNCTION interec_agent.restrict_promoted_artifact_update();

CREATE TRIGGER published_claims_immutable
  BEFORE UPDATE ON interec_agent.published_claims
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_published_claim_update();

CREATE TRIGGER published_claim_evidence_immutable
  BEFORE UPDATE ON interec_agent.published_claim_evidence
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_published_claim_update();
