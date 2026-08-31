CREATE TABLE interec_agent.turn_plan_reviews (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  proposal_number integer NOT NULL CHECK (proposal_number > 0 AND proposal_number <= 3),
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REPAIR_REQUIRED', 'REJECTED')),
  policy_version text NOT NULL,
  proposal_json jsonb NOT NULL,
  reviewed_plan_json jsonb NOT NULL,
  violations_json jsonb NOT NULL DEFAULT '[]',
  approved_plan_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, attempt, proposal_number),
  FOREIGN KEY (turn_id, attempt)
    REFERENCES interec_agent.turn_attempts(turn_id, attempt) ON DELETE CASCADE
);

CREATE INDEX turn_plan_reviews_attempt_idx
  ON interec_agent.turn_plan_reviews (turn_id, attempt, proposal_number);

CREATE FUNCTION interec_agent.reject_turn_plan_review_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'turn plan reviews are append-only';
END;
$$;

CREATE TRIGGER turn_plan_reviews_append_only
  BEFORE UPDATE OR DELETE ON interec_agent.turn_plan_reviews
  FOR EACH ROW EXECUTE FUNCTION interec_agent.reject_turn_plan_review_mutation();

ALTER TABLE interec_agent.turn_plan_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY turn_plan_reviews_owner_policy ON interec_agent.turn_plan_reviews
  USING (interec_agent.current_owner_has_turn(turn_id))
  WITH CHECK (interec_agent.current_owner_has_turn(turn_id));

