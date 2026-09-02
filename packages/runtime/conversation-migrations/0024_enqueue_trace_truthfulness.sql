-- Direct repository callers and telemetry-disabled execution have no enqueue
-- observation. NULL is truthful; a deterministic ID without an exported span is not.
ALTER TABLE interec_agent.turns
  ALTER COLUMN trace_id DROP NOT NULL;
