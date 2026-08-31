ALTER TABLE interec_agent.assistant_responses
  DROP CONSTRAINT assistant_responses_outcome_check;

-- DISCOVERY was the historical name for evidence-backed search results that
-- are not yet a recommendation. Normalize durable projections before making
-- the database constraint match the current domain protocol.
UPDATE interec_agent.assistant_responses
   SET outcome = 'SEARCH_RESULTS'
 WHERE outcome = 'DISCOVERY';

UPDATE interec_agent.assistant_envelopes
   SET envelope_json = jsonb_set(envelope_json, '{outcome}', '"SEARCH_RESULTS"'::jsonb)
 WHERE envelope_json->>'outcome' = 'DISCOVERY';

UPDATE interec_agent.messages
   SET payload_json = jsonb_set(payload_json, '{outcome}', '"SEARCH_RESULTS"'::jsonb)
 WHERE role = 'ASSISTANT' AND payload_json->>'outcome' = 'DISCOVERY';

ALTER TABLE interec_agent.assistant_responses
  ADD CONSTRAINT assistant_responses_outcome_check
    CHECK (outcome IN ('CHAT', 'CLARIFICATION', 'SEARCH_RESULTS', 'RECOMMENDATION', 'NO_MATCH', 'DEGRADED'));
