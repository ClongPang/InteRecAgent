ALTER TABLE interec_agent.offer_qualifications
  ADD COLUMN relevance_label text NOT NULL DEFAULT 'UNRESOLVED',
  ADD COLUMN relevance_json jsonb NOT NULL DEFAULT '{"label":"UNRESOLVED","policyVersion":"esci-admission-v1","reasonCodes":["LEGACY_UNASSESSED"],"evidence":[]}',
  ADD COLUMN admission_cohort text NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
  ADD COLUMN relevance_policy_version text NOT NULL DEFAULT 'esci-admission-v1';

ALTER TABLE interec_agent.offer_qualifications
  ADD CONSTRAINT offer_qualifications_relevance_label_check
    CHECK (relevance_label IN ('EXACT', 'SUBSTITUTE', 'COMPLEMENT', 'IRRELEVANT', 'UNRESOLVED')),
  ADD CONSTRAINT offer_qualifications_admission_cohort_check
    CHECK (admission_cohort IN ('MAIN_RECOMMENDATION', 'ALTERNATIVE_COHORT', 'RELATED_COHORT', 'INELIGIBLE', 'INSUFFICIENT_EVIDENCE'));

CREATE INDEX offer_qualifications_relevance_idx
  ON interec_agent.offer_qualifications (turn_id, attempt, relevance_label, admission_cohort);

