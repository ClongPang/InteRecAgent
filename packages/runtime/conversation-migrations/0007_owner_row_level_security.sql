CREATE FUNCTION interec_agent.current_owner_has_conversation(target_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, interec_agent
AS $$
  SELECT EXISTS (
    SELECT 1 FROM interec_agent.conversations c
    WHERE c.id = target_conversation_id
      AND c.tenant_id = current_setting('interec.tenant_id', true)
      AND c.owner_id = current_setting('interec.owner_id', true)
  )
$$;

CREATE FUNCTION interec_agent.current_owner_has_turn(target_turn_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, interec_agent
AS $$
  SELECT EXISTS (
    SELECT 1 FROM interec_agent.turns t
    WHERE t.id = target_turn_id AND interec_agent.current_owner_has_conversation(t.conversation_id)
  )
$$;

CREATE FUNCTION interec_agent.current_owner_has_response(target_response_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, interec_agent
AS $$
  SELECT EXISTS (
    SELECT 1 FROM interec_agent.assistant_responses r
    WHERE r.id = target_response_id AND interec_agent.current_owner_has_conversation(r.conversation_id)
  )
$$;

ALTER TABLE interec_agent.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner_policy ON interec_agent.conversations
  USING (tenant_id = current_setting('interec.tenant_id', true) AND owner_id = current_setting('interec.owner_id', true))
  WITH CHECK (tenant_id = current_setting('interec.tenant_id', true) AND owner_id = current_setting('interec.owner_id', true));

ALTER TABLE interec_agent.conversation_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_revisions_owner_policy ON interec_agent.conversation_revisions
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.goal_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY goal_versions_owner_policy ON interec_agent.goal_versions
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.dialogue_state_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY dialogue_state_versions_owner_policy ON interec_agent.dialogue_state_versions
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.working_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY working_sets_owner_policy ON interec_agent.working_sets
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_owner_policy ON interec_agent.messages
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.turns ENABLE ROW LEVEL SECURITY;
CREATE POLICY turns_owner_policy ON interec_agent.turns
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.assistant_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY assistant_responses_owner_policy ON interec_agent.assistant_responses
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.turn_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY turn_events_owner_policy ON interec_agent.turn_events
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.undo_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY undo_entries_owner_policy ON interec_agent.undo_entries
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.research_waves ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_waves_owner_policy ON interec_agent.research_waves
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.provider_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_artifacts_owner_policy ON interec_agent.provider_artifacts
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.fx_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY fx_snapshots_owner_policy ON interec_agent.fx_snapshots
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.source_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY source_facts_owner_policy ON interec_agent.source_facts
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.source_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY source_listings_owner_policy ON interec_agent.source_listings
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.offer_qualifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY offer_qualifications_owner_policy ON interec_agent.offer_qualifications
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.comparison_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY comparison_sets_owner_policy ON interec_agent.comparison_sets
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.attempt_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY attempt_claims_owner_policy ON interec_agent.attempt_claims
  USING (interec_agent.current_owner_has_conversation(conversation_id))
  WITH CHECK (interec_agent.current_owner_has_conversation(conversation_id));

ALTER TABLE interec_agent.turn_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY turn_attempts_owner_policy ON interec_agent.turn_attempts
  USING (interec_agent.current_owner_has_turn(turn_id))
  WITH CHECK (interec_agent.current_owner_has_turn(turn_id));

ALTER TABLE interec_agent.turn_input_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY turn_input_messages_owner_policy ON interec_agent.turn_input_messages
  USING (interec_agent.current_owner_has_turn(turn_id))
  WITH CHECK (interec_agent.current_owner_has_turn(turn_id));

ALTER TABLE interec_agent.tool_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_executions_owner_policy ON interec_agent.tool_executions
  USING (interec_agent.current_owner_has_turn(turn_id))
  WITH CHECK (interec_agent.current_owner_has_turn(turn_id));

ALTER TABLE interec_agent.provider_permits ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_permits_owner_policy ON interec_agent.provider_permits
  USING (interec_agent.current_owner_has_turn(turn_id))
  WITH CHECK (interec_agent.current_owner_has_turn(turn_id));

ALTER TABLE interec_agent.assistant_envelopes ENABLE ROW LEVEL SECURITY;
CREATE POLICY assistant_envelopes_owner_policy ON interec_agent.assistant_envelopes
  USING (interec_agent.current_owner_has_response(response_id))
  WITH CHECK (interec_agent.current_owner_has_response(response_id));

ALTER TABLE interec_agent.claim_ledgers ENABLE ROW LEVEL SECURITY;
CREATE POLICY claim_ledgers_owner_policy ON interec_agent.claim_ledgers
  USING (interec_agent.current_owner_has_response(response_id))
  WITH CHECK (interec_agent.current_owner_has_response(response_id));

ALTER TABLE interec_agent.published_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY published_claims_owner_policy ON interec_agent.published_claims
  USING (interec_agent.current_owner_has_response(response_id))
  WITH CHECK (interec_agent.current_owner_has_response(response_id));

ALTER TABLE interec_agent.decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY decisions_owner_policy ON interec_agent.decisions
  USING (interec_agent.current_owner_has_response(response_id))
  WITH CHECK (interec_agent.current_owner_has_response(response_id));

ALTER TABLE interec_agent.outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_owner_policy ON interec_agent.outbox
  USING (EXISTS (
    SELECT 1 FROM interec_agent.turn_events e
    WHERE e.id = event_id AND interec_agent.current_owner_has_conversation(e.conversation_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM interec_agent.turn_events e
    WHERE e.id = event_id AND interec_agent.current_owner_has_conversation(e.conversation_id)
  ));
