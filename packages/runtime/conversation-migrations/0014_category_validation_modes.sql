ALTER TABLE interec_agent.observed_candidates
  DROP CONSTRAINT IF EXISTS observed_candidates_support_level_check;

UPDATE interec_agent.observed_candidates
SET support_level = CASE support_level
  WHEN 'DISCOVERY' THEN 'SEARCH_ONLY'
  WHEN 'VERIFIED' THEN 'RULE_VALIDATED'
  ELSE support_level
END
WHERE support_level IN ('DISCOVERY', 'VERIFIED');

ALTER TABLE interec_agent.observed_candidates
  ADD CONSTRAINT observed_candidates_support_level_check
  CHECK (support_level IN ('SEARCH_ONLY', 'RULE_VALIDATED'));
