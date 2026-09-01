ALTER TABLE interec_agent.conversations
  ADD COLUMN contract_version text NOT NULL DEFAULT 'legacy-shopping-v1';

ALTER TABLE interec_agent.conversations
  ADD CONSTRAINT conversations_contract_version_check
    CHECK (contract_version IN ('legacy-shopping-v1', 'quote-leads-sg-v1'));

CREATE TABLE interec_agent.quote_state_versions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  state_json jsonb NOT NULL,
  quote_lead_set_id uuid,
  committed_by_turn_id uuid NOT NULL REFERENCES interec_agent.turns(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, revision),
  UNIQUE (id, conversation_id),
  CONSTRAINT quote_state_contract_check
    CHECK (state_json->>'contractVersion' = 'quote-leads-sg-v1'),
  CONSTRAINT quote_state_lead_set_fk
    FOREIGN KEY (quote_lead_set_id, conversation_id)
      REFERENCES interec_agent.quote_lead_sets(id, conversation_id) ON DELETE RESTRICT
);

ALTER TABLE interec_agent.conversation_revisions
  ADD COLUMN quote_state_version_id uuid;

ALTER TABLE interec_agent.conversation_revisions
  ADD CONSTRAINT conversation_revisions_quote_state_fk
    FOREIGN KEY (quote_state_version_id, conversation_id)
      REFERENCES interec_agent.quote_state_versions(id, conversation_id) ON DELETE RESTRICT;

ALTER TABLE interec_agent.assistant_responses
  DROP CONSTRAINT assistant_responses_outcome_check;

ALTER TABLE interec_agent.assistant_responses
  ADD CONSTRAINT assistant_responses_outcome_check
    CHECK (outcome IN (
      'CHAT', 'CLARIFICATION', 'SEARCH_RESULTS', 'RECOMMENDATION', 'NO_MATCH', 'DEGRADED',
      'QUOTE_LEADS', 'NO_QUOTE_LEADS'
    ));

CREATE INDEX quote_state_versions_conversation_revision_idx
  ON interec_agent.quote_state_versions (conversation_id, revision DESC);

CREATE TRIGGER quote_state_versions_immutable
  BEFORE UPDATE ON interec_agent.quote_state_versions
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_quote_evidence_update();

ALTER TABLE interec_agent.quote_state_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_state_versions_owner_policy ON interec_agent.quote_state_versions
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));
