ALTER TABLE interec_agent.outbox
  ADD COLUMN locked_by text,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN dead_lettered_at timestamptz;

ALTER TABLE interec_agent.outbox
  ADD CONSTRAINT outbox_lock_pair_check CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  ADD CONSTRAINT outbox_terminal_state_check CHECK (NOT (published_at IS NOT NULL AND dead_lettered_at IS NOT NULL));

CREATE INDEX outbox_claim_idx
  ON interec_agent.outbox (available_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX outbox_dead_letter_idx
  ON interec_agent.outbox (dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
