CREATE TABLE interec_agent.observed_candidates (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  candidate_ref text NOT NULL,
  source_listing_id uuid NOT NULL REFERENCES interec_agent.source_listings(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_listing_id text NOT NULL,
  retrieval_market text NOT NULL,
  title text NOT NULL,
  category_hint text,
  product_type text,
  search_tokens text[] NOT NULL CHECK (cardinality(search_tokens) > 0 AND cardinality(search_tokens) <= 128),
  candidate_json jsonb NOT NULL,
  support_level text NOT NULL CHECK (support_level IN ('DISCOVERY', 'VERIFIED')),
  identity_key text,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_id, candidate_ref)
);

CREATE INDEX observed_candidates_search_tokens_idx
  ON interec_agent.observed_candidates USING gin (search_tokens);

CREATE INDEX observed_candidates_owner_market_expiry_idx
  ON interec_agent.observed_candidates (tenant_id, owner_id, retrieval_market, expires_at DESC);

ALTER TABLE interec_agent.observed_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY observed_candidates_owner_policy ON interec_agent.observed_candidates
  USING (
    tenant_id = current_setting('interec.tenant_id', true)
    AND owner_id = current_setting('interec.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('interec.tenant_id', true)
    AND owner_id = current_setting('interec.owner_id', true)
  );
