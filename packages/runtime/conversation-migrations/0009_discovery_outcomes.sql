ALTER TABLE interec_agent.offer_qualifications
  DROP CONSTRAINT offer_qualifications_status_check,
  DROP CONSTRAINT offer_qualifications_check;

ALTER TABLE interec_agent.offer_qualifications
  ADD CONSTRAINT offer_qualifications_status_check
    CHECK (status IN ('COMPARABLE', 'DISCOVERABLE', 'INELIGIBLE', 'INSUFFICIENT_EVIDENCE')),
  ADD CONSTRAINT offer_qualifications_payload_check CHECK (
    (status = 'COMPARABLE' AND offer_ref IS NOT NULL AND comparison_key IS NOT NULL AND comparable_offer_json IS NOT NULL)
    OR (status = 'DISCOVERABLE' AND offer_ref IS NOT NULL AND comparison_key IS NULL AND comparable_offer_json IS NOT NULL)
    OR (status IN ('INELIGIBLE', 'INSUFFICIENT_EVIDENCE') AND offer_ref IS NULL AND comparison_key IS NULL AND comparable_offer_json IS NULL)
  );

ALTER TABLE interec_agent.assistant_responses
  DROP CONSTRAINT assistant_responses_outcome_check;

ALTER TABLE interec_agent.assistant_responses
  ADD CONSTRAINT assistant_responses_outcome_check
    CHECK (outcome IN ('CHAT', 'CLARIFICATION', 'DISCOVERY', 'RECOMMENDATION', 'NO_MATCH', 'DEGRADED'));
