CREATE OR REPLACE FUNCTION interec_agent.reject_turn_plan_review_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'turn plan reviews are append-only';
END;
$$;

