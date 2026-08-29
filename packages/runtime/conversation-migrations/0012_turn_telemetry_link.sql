ALTER TABLE interec_agent.turns
  ADD COLUMN trace_id text;

UPDATE interec_agent.turns
SET trace_id = md5('interec-turn-trace-v1:' || conversation_id::text || ':' || client_turn_id)
WHERE trace_id IS NULL;

ALTER TABLE interec_agent.turns
  ALTER COLUMN trace_id SET NOT NULL,
  ADD CONSTRAINT turns_trace_id_check CHECK (trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> repeat('0', 32));

ALTER TABLE interec_agent.turn_attempts
  ADD COLUMN trace_id text,
  ADD COLUMN root_observation_id text;

UPDATE interec_agent.turn_attempts ta
SET trace_id = t.trace_id
FROM interec_agent.turns t
WHERE t.id = ta.turn_id AND ta.trace_id IS NULL;

ALTER TABLE interec_agent.turn_attempts
  ALTER COLUMN trace_id SET NOT NULL,
  ADD CONSTRAINT turn_attempts_trace_id_check CHECK (trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> repeat('0', 32)),
  ADD CONSTRAINT turn_attempts_observation_id_check CHECK (
    root_observation_id IS NULL OR (root_observation_id ~ '^[0-9a-f]{16}$' AND root_observation_id <> repeat('0', 16))
  );

CREATE INDEX turns_trace_id_idx ON interec_agent.turns(trace_id);
