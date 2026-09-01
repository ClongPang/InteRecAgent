CREATE TABLE interec_agent.product_identity_registry_versions (
  registry_version integer PRIMARY KEY CHECK (registry_version > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  checksum text NOT NULL CHECK (length(checksum) = 64),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  description text NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT product_identity_registry_activation_check
    CHECK ((status = 'DRAFT' AND activated_at IS NULL) OR (status IN ('ACTIVE', 'RETIRED') AND activated_at IS NOT NULL))
);

CREATE UNIQUE INDEX product_identity_one_active_version_idx
  ON interec_agent.product_identity_registry_versions ((status))
  WHERE status = 'ACTIVE';

CREATE TABLE interec_agent.product_brands (
  registry_version integer NOT NULL REFERENCES interec_agent.product_identity_registry_versions(registry_version) ON DELETE RESTRICT,
  brand_ref text NOT NULL,
  canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) > 0),
  aliases_json jsonb NOT NULL CHECK (jsonb_typeof(aliases_json) = 'array'),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  PRIMARY KEY (registry_version, brand_ref),
  UNIQUE (registry_version, canonical_name)
);

CREATE TABLE interec_agent.canonical_products (
  registry_version integer NOT NULL,
  product_ref text NOT NULL,
  brand_ref text NOT NULL,
  canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) > 0),
  product_type text NOT NULL CHECK (length(btrim(product_type)) > 0),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  PRIMARY KEY (registry_version, product_ref),
  UNIQUE (registry_version, brand_ref, canonical_name),
  CONSTRAINT canonical_products_brand_fk
    FOREIGN KEY (registry_version, brand_ref) REFERENCES interec_agent.product_brands(registry_version, brand_ref) ON DELETE RESTRICT
);

CREATE TABLE interec_agent.product_variants (
  registry_version integer NOT NULL,
  variant_ref text NOT NULL,
  product_ref text NOT NULL,
  canonical_model text NOT NULL CHECK (length(btrim(canonical_model)) > 0),
  attributes_json jsonb NOT NULL CHECK (jsonb_typeof(attributes_json) = 'object'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  PRIMARY KEY (registry_version, variant_ref),
  UNIQUE (registry_version, product_ref, canonical_model),
  CONSTRAINT product_variants_product_fk
    FOREIGN KEY (registry_version, product_ref) REFERENCES interec_agent.canonical_products(registry_version, product_ref) ON DELETE RESTRICT
);

CREATE TABLE interec_agent.product_identifiers (
  registry_version integer NOT NULL,
  identifier_ref text NOT NULL,
  variant_ref text NOT NULL,
  brand_ref text NOT NULL,
  scheme text NOT NULL CHECK (scheme IN ('GTIN', 'BRAND_MPN')),
  normalized_value text NOT NULL CHECK (length(btrim(normalized_value)) > 0),
  approval_status text NOT NULL CHECK (approval_status IN ('PROPOSED', 'APPROVED', 'RETIRED')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  PRIMARY KEY (registry_version, identifier_ref),
  CONSTRAINT product_identifiers_variant_fk
    FOREIGN KEY (registry_version, variant_ref) REFERENCES interec_agent.product_variants(registry_version, variant_ref) ON DELETE RESTRICT,
  CONSTRAINT product_identifiers_brand_fk
    FOREIGN KEY (registry_version, brand_ref) REFERENCES interec_agent.product_brands(registry_version, brand_ref) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX product_identifiers_approved_gtin_unique_idx
  ON interec_agent.product_identifiers (registry_version, normalized_value)
  WHERE scheme = 'GTIN' AND approval_status = 'APPROVED';

CREATE UNIQUE INDEX product_identifiers_approved_brand_mpn_unique_idx
  ON interec_agent.product_identifiers (registry_version, brand_ref, normalized_value)
  WHERE scheme = 'BRAND_MPN' AND approval_status = 'APPROVED';

CREATE INDEX product_identifiers_lookup_idx
  ON interec_agent.product_identifiers (registry_version, scheme, normalized_value)
  WHERE approval_status = 'APPROVED';

CREATE TABLE interec_agent.product_aliases (
  registry_version integer NOT NULL,
  alias_ref text NOT NULL,
  variant_ref text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('USER_INPUT', 'PROVIDER_QUERY')),
  display_value text NOT NULL CHECK (length(btrim(display_value)) > 0),
  normalized_key text NOT NULL CHECK (length(btrim(normalized_key)) > 0),
  approval_status text NOT NULL CHECK (approval_status IN ('PROPOSED', 'APPROVED', 'RETIRED')),
  priority integer NOT NULL CHECK (priority >= 0),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  PRIMARY KEY (registry_version, alias_ref),
  UNIQUE (registry_version, purpose, normalized_key, variant_ref),
  CONSTRAINT product_aliases_variant_fk
    FOREIGN KEY (registry_version, variant_ref) REFERENCES interec_agent.product_variants(registry_version, variant_ref) ON DELETE RESTRICT
);

CREATE INDEX product_aliases_resolution_idx
  ON interec_agent.product_aliases (registry_version, purpose, normalized_key, priority)
  WHERE approval_status = 'APPROVED';

CREATE UNIQUE INDEX product_aliases_provider_priority_unique_idx
  ON interec_agent.product_aliases (registry_version, variant_ref, priority)
  WHERE purpose = 'PROVIDER_QUERY' AND approval_status = 'APPROVED';

CREATE TABLE interec_agent.product_relationships (
  registry_version integer NOT NULL,
  relationship_ref text NOT NULL,
  from_variant_ref text NOT NULL,
  to_variant_ref text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SUCCESSOR_OF', 'ACCESSORY_OF', 'BUNDLE_OF')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  PRIMARY KEY (registry_version, relationship_ref),
  UNIQUE (registry_version, from_variant_ref, to_variant_ref, kind),
  CHECK (from_variant_ref <> to_variant_ref),
  CONSTRAINT product_relationships_from_variant_fk
    FOREIGN KEY (registry_version, from_variant_ref) REFERENCES interec_agent.product_variants(registry_version, variant_ref) ON DELETE RESTRICT,
  CONSTRAINT product_relationships_to_variant_fk
    FOREIGN KEY (registry_version, to_variant_ref) REFERENCES interec_agent.product_variants(registry_version, variant_ref) ON DELETE RESTRICT
);

INSERT INTO interec_agent.product_identity_registry_versions
  (registry_version, schema_version, status, checksum, source_ref, description, activated_at)
VALUES
  (1, 1, 'DRAFT', 'fdb3a22e06b9cfdefa72ff58ebd7dc77dfbc91427f402157e60837ac4127f93f',
   'product-contract:quote-leads-sg-v1', 'Initial curated identity aliases for the accepted quote-lead contract.', NULL);

INSERT INTO interec_agent.product_brands
  (registry_version, brand_ref, canonical_name, aliases_json, source_ref)
VALUES
  (1, 'brand_apple', 'Apple', '["Apple", "苹果"]', 'product-contract:quote-leads-sg-v1'),
  (1, 'brand_dyson', 'Dyson', '["Dyson", "戴森"]', 'product-contract:quote-leads-sg-v1'),
  (1, 'brand_logitech', 'Logitech', '["Logitech", "罗技"]', 'product-contract:quote-leads-sg-v1'),
  (1, 'brand_nintendo', 'Nintendo', '["Nintendo", "任天堂"]', 'product-contract:quote-leads-sg-v1'),
  (1, 'brand_samsung', 'Samsung', '["Samsung", "三星"]', 'product-contract:quote-leads-sg-v1'),
  (1, 'brand_sony', 'Sony', '["Sony", "索尼"]', 'product-contract:quote-leads-sg-v1');

INSERT INTO interec_agent.canonical_products
  (registry_version, product_ref, brand_ref, canonical_name, product_type, source_ref)
VALUES
  (1, 'product_apple_airpods_max', 'brand_apple', 'AirPods Max', 'headphones', 'product-contract:quote-leads-sg-v1'),
  (1, 'product_dyson_purifier', 'brand_dyson', 'Purifier Cool Formaldehyde', 'air purifier', 'product-contract:quote-leads-sg-v1'),
  (1, 'product_logitech_mx_master', 'brand_logitech', 'MX Master 3S', 'mouse', 'product-contract:quote-leads-sg-v1'),
  (1, 'product_nintendo_switch', 'brand_nintendo', 'Switch', 'game console', 'product-contract:quote-leads-sg-v1'),
  (1, 'product_samsung_galaxy_s24', 'brand_samsung', 'Galaxy S24', 'smartphone', 'product-contract:quote-leads-sg-v1'),
  (1, 'product_sony_wh1000x', 'brand_sony', 'WH-1000X', 'headphones', 'product-contract:quote-leads-sg-v1');

INSERT INTO interec_agent.product_variants
  (registry_version, variant_ref, product_ref, canonical_model, attributes_json, status, source_ref)
VALUES
  (1, 'variant_apple_airpods_max_a3184', 'product_apple_airpods_max', 'A3184', '{"connector":"USB-C"}', 'ACTIVE', 'product-contract:quote-leads-sg-v1'),
  (1, 'variant_dyson_tp09', 'product_dyson_purifier', 'TP09', '{}', 'ACTIVE', 'product-contract:quote-leads-sg-v1'),
  (1, 'variant_logitech_910006559', 'product_logitech_mx_master', '910-006559', '{}', 'ACTIVE', 'product-contract:quote-leads-sg-v1'),
  (1, 'variant_nintendo_switch_2', 'product_nintendo_switch', 'SWITCH 2', '{}', 'ACTIVE', 'product-contract:quote-leads-sg-v1'),
  (1, 'variant_samsung_sms921b_256gb', 'product_samsung_galaxy_s24', 'SM-S921B', '{"storage":"256GB"}', 'ACTIVE', 'product-contract:quote-leads-sg-v1'),
  (1, 'variant_sony_wh1000xm4', 'product_sony_wh1000x', 'WH-1000XM4', '{}', 'ACTIVE', 'product-contract:quote-leads-sg-v1'),
  (1, 'variant_sony_wh1000xm5', 'product_sony_wh1000x', 'WH-1000XM5', '{}', 'ACTIVE', 'product-contract:quote-leads-sg-v1');

-- These model-like values are proposals, not verified manufacturer identifiers. They cannot authorize VERIFIED_IDENTIFIER.
INSERT INTO interec_agent.product_identifiers
  (registry_version, identifier_ref, variant_ref, brand_ref, scheme, normalized_value, approval_status, source_ref)
VALUES
  (1, 'identifier_proposed_apple_a3184', 'variant_apple_airpods_max_a3184', 'brand_apple', 'BRAND_MPN', 'A3184', 'PROPOSED', 'product-contract:quote-leads-sg-v1'),
  (1, 'identifier_proposed_dyson_tp09', 'variant_dyson_tp09', 'brand_dyson', 'BRAND_MPN', 'TP09', 'PROPOSED', 'product-contract:quote-leads-sg-v1'),
  (1, 'identifier_proposed_logitech_910006559', 'variant_logitech_910006559', 'brand_logitech', 'BRAND_MPN', '910006559', 'PROPOSED', 'product-contract:quote-leads-sg-v1'),
  (1, 'identifier_proposed_samsung_sms921b', 'variant_samsung_sms921b_256gb', 'brand_samsung', 'BRAND_MPN', 'SMS921B', 'PROPOSED', 'product-contract:quote-leads-sg-v1'),
  (1, 'identifier_proposed_sony_wh1000xm4', 'variant_sony_wh1000xm4', 'brand_sony', 'BRAND_MPN', 'WH1000XM4', 'PROPOSED', 'product-contract:quote-leads-sg-v1'),
  (1, 'identifier_proposed_sony_wh1000xm5', 'variant_sony_wh1000xm5', 'brand_sony', 'BRAND_MPN', 'WH1000XM5', 'PROPOSED', 'product-contract:quote-leads-sg-v1');

INSERT INTO interec_agent.product_aliases
  (registry_version, alias_ref, variant_ref, purpose, display_value, normalized_key, approval_status, priority, source_ref)
VALUES
  (1, 'alias_user_apple_a3184', 'variant_apple_airpods_max_a3184', 'USER_INPUT', 'A3184', 'A3184', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_apple_airpods_max_a3184', 'variant_apple_airpods_max_a3184', 'USER_INPUT', 'AirPods Max USB-C A3184', 'AIRPODSMAXUSBCA3184', 'APPROVED', 1, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_apple_a3184', 'variant_apple_airpods_max_a3184', 'PROVIDER_QUERY', 'Apple AirPods Max USB-C A3184', 'APPLEAIRPODSMAXUSBCA3184', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_dyson_tp09', 'variant_dyson_tp09', 'USER_INPUT', 'TP09', 'TP09', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_dyson_tp09', 'variant_dyson_tp09', 'PROVIDER_QUERY', 'Dyson TP09', 'DYSONTP09', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_logitech_910006559', 'variant_logitech_910006559', 'USER_INPUT', '910-006559', '910006559', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_logitech_mx_master', 'variant_logitech_910006559', 'USER_INPUT', 'MX Master 3S 910-006559', 'MXMASTER3S910006559', 'APPROVED', 1, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_logitech_910006559', 'variant_logitech_910006559', 'PROVIDER_QUERY', 'Logitech MX Master 3S 910-006559', 'LOGITECHMXMASTER3S910006559', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_nintendo_switch_2', 'variant_nintendo_switch_2', 'USER_INPUT', 'Nintendo Switch 2', 'NINTENDOSWITCH2', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_switch_2', 'variant_nintendo_switch_2', 'USER_INPUT', 'Switch 2', 'SWITCH2', 'APPROVED', 1, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_nintendo_switch_2', 'variant_nintendo_switch_2', 'PROVIDER_QUERY', 'Nintendo Switch 2', 'NINTENDOSWITCH2', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_samsung_sms921b', 'variant_samsung_sms921b_256gb', 'USER_INPUT', 'SM-S921B', 'SMS921B', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_samsung_sms921b_256gb', 'variant_samsung_sms921b_256gb', 'USER_INPUT', 'SM-S921B 256GB', 'SMS921B256GB', 'APPROVED', 1, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_samsung_sms921b', 'variant_samsung_sms921b_256gb', 'PROVIDER_QUERY', 'Samsung Galaxy S24 SM-S921B 256GB', 'SAMSUNGGALAXYS24SMS921B256GB', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_sony_wh1000xm4', 'variant_sony_wh1000xm4', 'USER_INPUT', 'WH-1000XM4', 'WH1000XM4', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_sony_wh1000xm4', 'variant_sony_wh1000xm4', 'PROVIDER_QUERY', 'Sony WH-1000XM4', 'SONYWH1000XM4', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_user_sony_wh1000xm5', 'variant_sony_wh1000xm5', 'USER_INPUT', 'WH-1000XM5', 'WH1000XM5', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1'),
  (1, 'alias_provider_sony_wh1000xm5', 'variant_sony_wh1000xm5', 'PROVIDER_QUERY', 'Sony WH-1000XM5', 'SONYWH1000XM5', 'APPROVED', 0, 'product-contract:quote-leads-sg-v1');

INSERT INTO interec_agent.product_relationships
  (registry_version, relationship_ref, from_variant_ref, to_variant_ref, kind, source_ref)
VALUES
  (1, 'relationship_sony_xm5_successor_xm4', 'variant_sony_wh1000xm5', 'variant_sony_wh1000xm4', 'SUCCESSOR_OF', 'product-contract:quote-leads-sg-v1');

UPDATE interec_agent.product_identity_registry_versions
SET status = 'ACTIVE', activated_at = '2026-09-01T00:00:00.000Z'
WHERE registry_version = 1;

CREATE FUNCTION interec_agent.product_identity_version_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.registry_version <> NEW.registry_version
     OR OLD.schema_version <> NEW.schema_version
     OR OLD.checksum <> NEW.checksum
     OR OLD.source_ref <> NEW.source_ref
     OR OLD.description <> NEW.description THEN
    RAISE EXCEPTION 'PRODUCT_IDENTITY_VERSION_IMMUTABLE';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND OLD.activated_at = NEW.activated_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PRODUCT_IDENTITY_VERSION_TRANSITION_REJECTED';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_identity_registry_version_guard
BEFORE UPDATE ON interec_agent.product_identity_registry_versions
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_version_guard();

CREATE FUNCTION interec_agent.product_identity_record_guard() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'PRODUCT_IDENTITY_RECORD_IMMUTABLE';
  END IF;
  SELECT status INTO parent_status
  FROM interec_agent.product_identity_registry_versions
  WHERE registry_version = NEW.registry_version;
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'PRODUCT_IDENTITY_VERSION_NOT_DRAFT';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_brands_version_guard BEFORE INSERT OR UPDATE OR DELETE ON interec_agent.product_brands
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_record_guard();
CREATE TRIGGER canonical_products_version_guard BEFORE INSERT OR UPDATE OR DELETE ON interec_agent.canonical_products
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_record_guard();
CREATE TRIGGER product_variants_version_guard BEFORE INSERT OR UPDATE OR DELETE ON interec_agent.product_variants
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_record_guard();
CREATE TRIGGER product_identifiers_version_guard BEFORE INSERT OR UPDATE OR DELETE ON interec_agent.product_identifiers
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_record_guard();
CREATE TRIGGER product_aliases_version_guard BEFORE INSERT OR UPDATE OR DELETE ON interec_agent.product_aliases
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_record_guard();
CREATE TRIGGER product_relationships_version_guard BEFORE INSERT OR UPDATE OR DELETE ON interec_agent.product_relationships
FOR EACH ROW EXECUTE FUNCTION interec_agent.product_identity_record_guard();

ALTER TABLE interec_agent.product_identity_registry_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_identity_registry_read_policy ON interec_agent.product_identity_registry_versions FOR SELECT USING (true);
ALTER TABLE interec_agent.product_brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_brands_read_policy ON interec_agent.product_brands FOR SELECT USING (true);
ALTER TABLE interec_agent.canonical_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY canonical_products_read_policy ON interec_agent.canonical_products FOR SELECT USING (true);
ALTER TABLE interec_agent.product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_variants_read_policy ON interec_agent.product_variants FOR SELECT USING (true);
ALTER TABLE interec_agent.product_identifiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_identifiers_read_policy ON interec_agent.product_identifiers FOR SELECT USING (true);
ALTER TABLE interec_agent.product_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_aliases_read_policy ON interec_agent.product_aliases FOR SELECT USING (true);
ALTER TABLE interec_agent.product_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_relationships_read_policy ON interec_agent.product_relationships FOR SELECT USING (true);
