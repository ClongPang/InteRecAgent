-- A 32-hex value is not sufficient evidence that a Trace exists. Record the
-- observation boundary that produced each retained identifier and remove the
-- synthetic 0012 backfill from current lookup semantics.
ALTER TABLE interec_agent.turns
  ADD COLUMN trace_id_source text;

ALTER TABLE interec_agent.turn_attempts
  ADD COLUMN trace_id_source text;

-- Pre-v3 attempts copied the enqueue identity into every attempt. A real v3
-- attempt root always has its own trace and root observation identity.
UPDATE interec_agent.turn_attempts ta
SET trace_id = NULL,
    root_observation_id = NULL
FROM interec_agent.turns t
WHERE t.id = ta.turn_id
  AND (ta.trace_id = t.trace_id OR ta.root_observation_id IS NULL);

-- 0012 generated these values without creating/exporting an Observation.
UPDATE interec_agent.turns
SET trace_id = NULL,
    trace_root_observation_id = NULL
WHERE trace_id = md5(
  'interec-turn-trace-v1:' || conversation_id::text || ':' || client_turn_id
);

UPDATE interec_agent.turns
SET trace_id_source = 'OBSERVED_ENQUEUE_ROOT'
WHERE trace_id IS NOT NULL;

UPDATE interec_agent.turn_attempts
SET trace_id_source = 'OBSERVED_ATTEMPT_ROOT'
WHERE trace_id IS NOT NULL AND root_observation_id IS NOT NULL;

ALTER TABLE interec_agent.turns
  ADD CONSTRAINT turns_trace_identity_provenance_check CHECK (
    (trace_id IS NULL AND trace_root_observation_id IS NULL AND trace_id_source IS NULL)
    OR (trace_id IS NOT NULL AND trace_id_source = 'OBSERVED_ENQUEUE_ROOT')
  );

ALTER TABLE interec_agent.turn_attempts
  ADD CONSTRAINT turn_attempts_trace_identity_provenance_check CHECK (
    (trace_id IS NULL AND root_observation_id IS NULL AND trace_id_source IS NULL)
    OR (
      trace_id IS NOT NULL
      AND root_observation_id IS NOT NULL
      AND trace_id_source = 'OBSERVED_ATTEMPT_ROOT'
    )
  );
