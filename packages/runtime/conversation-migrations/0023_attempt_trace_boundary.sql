-- An attempt trace does not exist until the worker starts its real root
-- observation. Keeping this nullable prevents an enqueue trace from being
-- misrepresented as the execution trace during the claimed-but-not-started gap.
ALTER TABLE interec_agent.turn_attempts
  ALTER COLUMN trace_id DROP NOT NULL;
