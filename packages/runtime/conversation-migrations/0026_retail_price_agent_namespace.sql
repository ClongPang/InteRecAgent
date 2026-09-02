DO $$
BEGIN
  IF to_regnamespace('retail_price_agent') IS NULL THEN
    ALTER SCHEMA interec_agent RENAME TO retail_price_agent;
  ELSIF to_regnamespace('interec_agent') IS NOT NULL THEN
    RAISE EXCEPTION 'RETAIL_PRICE_AGENT_SCHEMA_CONFLICT';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION retail_price_agent.current_owner_has_conversation(target_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, retail_price_agent
AS $$
  SELECT EXISTS (
    SELECT 1 FROM retail_price_agent.conversations c
    WHERE c.id = target_conversation_id
      AND c.tenant_id = current_setting('retail_price.tenant_id', true)
      AND c.owner_id = current_setting('retail_price.owner_id', true)
  )
$$;

CREATE OR REPLACE FUNCTION retail_price_agent.current_owner_has_turn(target_turn_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, retail_price_agent
AS $$
  SELECT EXISTS (
    SELECT 1 FROM retail_price_agent.turns t
    WHERE t.id = target_turn_id
      AND retail_price_agent.current_owner_has_conversation(t.conversation_id)
  )
$$;

CREATE OR REPLACE FUNCTION retail_price_agent.current_owner_has_response(target_response_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, retail_price_agent
AS $$
  SELECT EXISTS (
    SELECT 1 FROM retail_price_agent.assistant_responses r
    WHERE r.id = target_response_id
      AND retail_price_agent.current_owner_has_conversation(r.conversation_id)
  )
$$;

CREATE OR REPLACE FUNCTION retail_price_agent.product_identity_record_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'PRODUCT_IDENTITY_RECORD_IMMUTABLE';
  END IF;
  SELECT status INTO parent_status
  FROM retail_price_agent.product_identity_registry_versions
  WHERE registry_version = NEW.registry_version;
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'PRODUCT_IDENTITY_VERSION_NOT_DRAFT';
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY conversations_owner_policy ON retail_price_agent.conversations;
CREATE POLICY conversations_owner_policy ON retail_price_agent.conversations
  USING (
    tenant_id = current_setting('retail_price.tenant_id', true)
    AND owner_id = current_setting('retail_price.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('retail_price.tenant_id', true)
    AND owner_id = current_setting('retail_price.owner_id', true)
  );

DROP POLICY observed_candidates_owner_policy ON retail_price_agent.observed_candidates;
CREATE POLICY observed_candidates_owner_policy ON retail_price_agent.observed_candidates
  USING (
    tenant_id = current_setting('retail_price.tenant_id', true)
    AND owner_id = current_setting('retail_price.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('retail_price.tenant_id', true)
    AND owner_id = current_setting('retail_price.owner_id', true)
  );

DROP POLICY candidate_feedback_owner_policy ON retail_price_agent.candidate_feedback_events;
CREATE POLICY candidate_feedback_owner_policy ON retail_price_agent.candidate_feedback_events
  USING (
    tenant_id = current_setting('retail_price.tenant_id', true)
    AND owner_id = current_setting('retail_price.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('retail_price.tenant_id', true)
    AND owner_id = current_setting('retail_price.owner_id', true)
  );
