ALTER TABLE interec_agent.turns
  ADD COLUMN trace_root_observation_id text;

ALTER TABLE interec_agent.turns
  ADD CONSTRAINT turns_trace_root_observation_id_check CHECK (
    trace_root_observation_id IS NULL OR (
      trace_root_observation_id ~ '^[0-9a-f]{16}$'
      AND trace_root_observation_id <> repeat('0', 16)
    )
  );
