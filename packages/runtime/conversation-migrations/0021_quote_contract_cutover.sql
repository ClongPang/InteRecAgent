BEGIN;

ALTER TABLE interec_agent.conversations
  ALTER COLUMN contract_version SET DEFAULT 'quote-leads-sg-v1';

COMMENT ON COLUMN interec_agent.conversations.contract_version IS
  'New rows use quote-leads-sg-v1. legacy-shopping-v1 rows are retained read-only for audit and are never claimed by the active worker.';

COMMIT;
