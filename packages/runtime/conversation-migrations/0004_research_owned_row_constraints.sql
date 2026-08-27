ALTER TABLE interec_agent.source_facts
  DROP CONSTRAINT source_facts_artifact_id_fkey,
  ADD CONSTRAINT source_facts_artifact_id_fkey
    FOREIGN KEY (artifact_id) REFERENCES interec_agent.provider_artifacts(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.source_facts
  DROP CONSTRAINT source_facts_fx_snapshot_id_fkey,
  ADD CONSTRAINT source_facts_fx_snapshot_id_fkey
    FOREIGN KEY (fx_snapshot_id) REFERENCES interec_agent.fx_snapshots(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.source_listings
  DROP CONSTRAINT source_listings_artifact_id_fkey,
  ADD CONSTRAINT source_listings_artifact_id_fkey
    FOREIGN KEY (artifact_id) REFERENCES interec_agent.provider_artifacts(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.offer_qualifications
  DROP CONSTRAINT offer_qualifications_source_listing_id_fkey,
  ADD CONSTRAINT offer_qualifications_source_listing_id_fkey
    FOREIGN KEY (source_listing_id) REFERENCES interec_agent.source_listings(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.comparison_set_items
  DROP CONSTRAINT comparison_set_items_qualification_id_fkey,
  ADD CONSTRAINT comparison_set_items_qualification_id_fkey
    FOREIGN KEY (qualification_id) REFERENCES interec_agent.offer_qualifications(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.working_sets
  DROP CONSTRAINT working_sets_proof_comparison_set_fk,
  ADD CONSTRAINT working_sets_proof_comparison_set_fk
    FOREIGN KEY (proof_comparison_set_id) REFERENCES interec_agent.comparison_sets(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.attempt_claim_evidence
  DROP CONSTRAINT attempt_claim_evidence_source_fact_id_fkey,
  ADD CONSTRAINT attempt_claim_evidence_source_fact_id_fkey
    FOREIGN KEY (source_fact_id) REFERENCES interec_agent.source_facts(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.attempt_claim_evidence
  DROP CONSTRAINT attempt_claim_evidence_fx_snapshot_id_fkey,
  ADD CONSTRAINT attempt_claim_evidence_fx_snapshot_id_fkey
    FOREIGN KEY (fx_snapshot_id) REFERENCES interec_agent.fx_snapshots(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.published_claim_evidence
  DROP CONSTRAINT published_claim_evidence_source_fact_id_fkey,
  ADD CONSTRAINT published_claim_evidence_source_fact_id_fkey
    FOREIGN KEY (source_fact_id) REFERENCES interec_agent.source_facts(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE interec_agent.published_claim_evidence
  DROP CONSTRAINT published_claim_evidence_fx_snapshot_id_fkey,
  ADD CONSTRAINT published_claim_evidence_fx_snapshot_id_fkey
    FOREIGN KEY (fx_snapshot_id) REFERENCES interec_agent.fx_snapshots(id)
    DEFERRABLE INITIALLY DEFERRED;
