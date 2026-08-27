ALTER TABLE interec_agent.turns
  ADD CONSTRAINT turns_conversation_id_id_key UNIQUE (conversation_id, id);

CREATE TABLE interec_agent.candidate_feedback_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  kind text NOT NULL CHECK (kind IN ('IMPRESSION', 'FOCUS', 'COMPARE', 'REJECT', 'RESTORE', 'ACCEPT', 'OUTBOUND_CLICK', 'CRITIQUE')),
  operation_id text NOT NULL,
  offer_refs text[] NOT NULL DEFAULT '{}',
  payload_json jsonb NOT NULL DEFAULT '{}',
  goal_version bigint,
  working_set_version bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, attempt, operation_id, kind),
  FOREIGN KEY (tenant_id, owner_id, conversation_id)
    REFERENCES interec_agent.conversations(tenant_id, owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, turn_id)
    REFERENCES interec_agent.turns(conversation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, attempt)
    REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE INDEX candidate_feedback_owner_timeline_idx
  ON interec_agent.candidate_feedback_events (tenant_id, owner_id, conversation_id, created_at, id);

CREATE FUNCTION interec_agent.reject_candidate_feedback_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'candidate feedback is append-only';
END;
$$;

CREATE TRIGGER candidate_feedback_append_only
  BEFORE UPDATE OR DELETE ON interec_agent.candidate_feedback_events
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_candidate_feedback_mutation();

ALTER TABLE interec_agent.candidate_feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY candidate_feedback_owner_policy ON interec_agent.candidate_feedback_events
  USING (
    tenant_id = current_setting('interec.tenant_id', true)
    AND owner_id = current_setting('interec.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('interec.tenant_id', true)
    AND owner_id = current_setting('interec.owner_id', true)
  );
