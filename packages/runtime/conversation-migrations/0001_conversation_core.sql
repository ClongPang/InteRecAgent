CREATE TABLE interec_agent.conversations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'BLOCKED')),
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  next_message_seq bigint NOT NULL DEFAULT 0 CHECK (next_message_seq >= 0),
  next_event_seq bigint NOT NULL DEFAULT 0 CHECK (next_event_seq >= 0),
  active_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, owner_id, id)
);

CREATE TABLE interec_agent.goal_versions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  parent_id uuid REFERENCES interec_agent.goal_versions(id),
  goal_json jsonb NOT NULL,
  operations_json jsonb NOT NULL,
  committed_by_turn_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, revision)
);

CREATE TABLE interec_agent.dialogue_state_versions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  state_json jsonb NOT NULL,
  committed_by_turn_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, revision)
);

CREATE TABLE interec_agent.working_sets (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  bound_goal_version bigint NOT NULL CHECK (bound_goal_version > 0),
  state_json jsonb NOT NULL,
  committed_by_turn_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, revision)
);

CREATE TABLE interec_agent.working_set_items (
  working_set_id uuid NOT NULL REFERENCES interec_agent.working_sets(id) ON DELETE CASCADE,
  offer_ref text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  candidate_json jsonb NOT NULL,
  is_displayed boolean NOT NULL,
  is_mentioned boolean NOT NULL,
  is_compared boolean NOT NULL,
  is_rejected boolean NOT NULL,
  is_focused boolean NOT NULL,
  PRIMARY KEY (working_set_id, offer_ref)
);

CREATE TABLE interec_agent.conversation_revisions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  parent_revision bigint NOT NULL CHECK (parent_revision >= 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  goal_version_id uuid REFERENCES interec_agent.goal_versions(id),
  dialogue_state_version_id uuid NOT NULL REFERENCES interec_agent.dialogue_state_versions(id),
  working_set_id uuid REFERENCES interec_agent.working_sets(id),
  committed_by_turn_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, revision)
);

CREATE TABLE interec_agent.messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq > 0),
  role text NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
  payload_json jsonb NOT NULL,
  client_turn_id text,
  request_hash text,
  consumed_by_turn_id uuid,
  assistant_response_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, client_turn_id)
);

CREATE TABLE interec_agent.turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  client_turn_id text NOT NULL,
  request_hash text NOT NULL,
  latest_input_message_id uuid NOT NULL REFERENCES interec_agent.messages(id),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  status text NOT NULL CHECK (status IN ('ACCEPTED', 'CLAIMED', 'RUNNING', 'COMMITTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUPERSEDED', 'DEAD_LETTER')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 3),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  worker_id text,
  lease_expires_at timestamptz,
  deadline_at timestamptz NOT NULL,
  error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, client_turn_id)
);

ALTER TABLE interec_agent.conversations
  ADD CONSTRAINT conversations_active_turn_fk FOREIGN KEY (active_turn_id) REFERENCES interec_agent.turns(id);

ALTER TABLE interec_agent.messages
  ADD CONSTRAINT messages_consumed_turn_fk FOREIGN KEY (consumed_by_turn_id) REFERENCES interec_agent.turns(id);

CREATE TABLE interec_agent.turn_input_messages (
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES interec_agent.messages(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (turn_id, message_id),
  UNIQUE (turn_id, ordinal)
);

CREATE TABLE interec_agent.turn_attempts (
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 3),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  status text NOT NULL CHECK (status IN ('CLAIMED', 'RUNNING', 'ABANDONED', 'FAILED', 'COMMITTED')),
  plan_json jsonb,
  draft_goal_json jsonb,
  draft_dialogue_json jsonb,
  draft_working_set_json jsonb,
  draft_envelope_json jsonb,
  draft_claim_ledger_json jsonb,
  draft_json jsonb NOT NULL DEFAULT '{}',
  evidence_keys text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (turn_id, attempt)
);

CREATE TABLE interec_agent.assistant_responses (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL UNIQUE REFERENCES interec_agent.turns(id),
  outcome text NOT NULL CHECK (outcome IN ('CHAT', 'CLARIFICATION', 'RECOMMENDATION', 'NO_MATCH', 'DEGRADED')),
  rendered_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE interec_agent.messages
  ADD CONSTRAINT messages_assistant_response_fk FOREIGN KEY (assistant_response_id) REFERENCES interec_agent.assistant_responses(id);

ALTER TABLE interec_agent.goal_versions
  ADD CONSTRAINT goal_versions_committed_turn_fk FOREIGN KEY (committed_by_turn_id) REFERENCES interec_agent.turns(id);

ALTER TABLE interec_agent.dialogue_state_versions
  ADD CONSTRAINT dialogue_versions_committed_turn_fk FOREIGN KEY (committed_by_turn_id) REFERENCES interec_agent.turns(id);

ALTER TABLE interec_agent.working_sets
  ADD CONSTRAINT working_sets_committed_turn_fk FOREIGN KEY (committed_by_turn_id) REFERENCES interec_agent.turns(id);

ALTER TABLE interec_agent.conversation_revisions
  ADD CONSTRAINT conversation_revisions_committed_turn_fk FOREIGN KEY (committed_by_turn_id) REFERENCES interec_agent.turns(id);

CREATE TABLE interec_agent.assistant_envelopes (
  response_id uuid PRIMARY KEY REFERENCES interec_agent.assistant_responses(id) ON DELETE CASCADE,
  envelope_json jsonb NOT NULL
);

CREATE TABLE interec_agent.claim_ledgers (
  response_id uuid PRIMARY KEY REFERENCES interec_agent.assistant_responses(id) ON DELETE CASCADE,
  ledger_json jsonb NOT NULL
);

CREATE TABLE interec_agent.decisions (
  id uuid PRIMARY KEY,
  response_id uuid NOT NULL UNIQUE REFERENCES interec_agent.assistant_responses(id) ON DELETE CASCADE,
  decision_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE interec_agent.undo_entries (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL UNIQUE REFERENCES interec_agent.turns(id),
  from_revision bigint NOT NULL CHECK (from_revision > 0),
  to_revision bigint NOT NULL CHECK (to_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE interec_agent.turn_events (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES interec_agent.conversations(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq > 0),
  event_type text NOT NULL,
  public_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE interec_agent.outbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES interec_agent.turn_events(id) ON DELETE CASCADE,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text
);

CREATE TABLE interec_agent.tool_executions (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES interec_agent.turns(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  step_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  request_json jsonb NOT NULL,
  result_json jsonb,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, step_key)
);

CREATE INDEX conversations_owner_updated_idx ON interec_agent.conversations (tenant_id, owner_id, updated_at DESC);
CREATE INDEX turns_claim_idx ON interec_agent.turns (status, lease_expires_at, created_at);
CREATE INDEX messages_timeline_idx ON interec_agent.messages (conversation_id, seq);
CREATE INDEX events_cursor_idx ON interec_agent.turn_events (conversation_id, seq);
CREATE INDEX outbox_pending_idx ON interec_agent.outbox (available_at, id) WHERE published_at IS NULL;
CREATE INDEX tool_executions_attempt_idx ON interec_agent.tool_executions (turn_id, attempt, status);
