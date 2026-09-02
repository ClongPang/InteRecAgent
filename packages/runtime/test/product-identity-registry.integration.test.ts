import { findProductIdentityCandidates, resolveProductIdentity } from "@retail-price/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresConversationRepository,
  PostgresProductIdentityRegistry,
  retailPriceEnvironmentValue,
  runConversationMigrations,
} from "../src/index.js";

const enabled = process.env["RUN_CONVERSATION_PG_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl = retailPriceEnvironmentValue(process.env, "DATABASE_URL")
  ?? "postgresql://retail_price:retail_price@127.0.0.1:5432/retail_price";

suite("PostgreSQL product identity registry", () => {
  const conversations = new PostgresConversationRepository(databaseUrl, 2);
  const registry = new PostgresProductIdentityRegistry(conversations.pool);

  beforeAll(async () => {
    await runConversationMigrations(conversations.pool);
  });

  afterAll(async () => {
    await conversations.close();
  });

  it("loads one deterministic, validated active snapshot and replays migration idempotently", async () => {
    const first = await registry.getActiveSnapshot();
    const second = await registry.getActiveSnapshot();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ schemaVersion: 1, registryVersion: 1 });
    expect(first.brands).toHaveLength(6);
    expect(first.variants).toHaveLength(7);
    expect(first.aliases.length).toBeGreaterThanOrEqual(18);
    await expect(registry.getSnapshot(1)).resolves.toEqual(first);
    await expect(registry.getSnapshot(999)).resolves.toBeNull();
    await expect(runConversationMigrations(conversations.pool)).resolves.toMatchObject({ applied: [] });
  });

  it.each([
    ["Sony WH1000XM5", "WH1000XM5", "Sony", [], "variant_sony_wh1000xm5", "Sony WH-1000XM5"],
    ["Apple A3184", "A3184", "Apple", [], "variant_apple_airpods_max_a3184", "Apple AirPods Max USB-C A3184"],
    ["Dyson TP09", "TP09", "Dyson", [], "variant_dyson_tp09", "Dyson TP09"],
    ["Logitech 910-006559", "910-006559", "Logitech", [], "variant_logitech_910006559", "Logitech MX Master 3S 910-006559"],
    ["Nintendo Switch 2", "Switch 2", "Nintendo", [], "variant_nintendo_switch_2", "Nintendo Switch 2"],
    ["Samsung SM-S921B 256GB", "SM-S921B", "Samsung", ["256GB"], "variant_samsung_sms921b_256gb", "Samsung Galaxy S24 SM-S921B 256GB"],
  ])("resolves curated identity %s without embedding brand branches in the resolver", async (rawText, model, brand, qualifiers, variantRef, providerQuery) => {
    const result = resolveProductIdentity(await registry.getActiveSnapshot(), {
      rawText,
      proposedModel: model,
      brand,
      requiredQualifiers: qualifiers,
    });
    expect(result).toMatchObject({
      outcome: "RESOLVED",
      strength: "CURATED_ALIAS",
      registryVersion: 1,
      candidate: { variantRef },
      providerQuery,
    });
  });

  it("keeps contract-derived identifier proposals below verified authority", async () => {
    const result = resolveProductIdentity(await registry.getActiveSnapshot(), {
      rawText: "Sony WH-1000XM5",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      identifiers: [{ scheme: "BRAND_MPN", value: "WH-1000XM5" }],
    });
    expect(result).toMatchObject({ outcome: "RESOLVED", strength: "CURATED_ALIAS" });
    expect(result.evidenceRefs.some((ref) => ref.startsWith("identifier_"))).toBe(false);
  });

  it("builds the same host candidate allowlist from the persisted active snapshot", async () => {
    const snapshot = await registry.getActiveSnapshot();
    expect(findProductIdentityCandidates(snapshot, ["Quote Sony WH1000XM5"]))
      .toEqual([expect.objectContaining({
        variantRef: "variant_sony_wh1000xm5",
        canonicalModel: "WH-1000XM5",
        evidenceRefs: expect.arrayContaining(["alias_user_sony_wh1000xm5"]),
      })]);
  });

  it("makes an active registry immutable and exposes the expected database guards", async () => {
    await expect(conversations.pool.query(
      `INSERT INTO retail_price_agent.product_aliases
         (registry_version, alias_ref, variant_ref, purpose, display_value, normalized_key, approval_status, priority, source_ref)
       VALUES (1, 'alias_illegal_active_insert', 'variant_sony_wh1000xm5', 'USER_INPUT', 'illegal', 'ILLEGAL', 'APPROVED', 99, 'test')`,
    )).rejects.toThrow("PRODUCT_IDENTITY_VERSION_NOT_DRAFT");

    const schema = await conversations.pool.query<{ rls_count: number; index_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'retail_price_agent' AND c.relname IN
            ('product_identity_registry_versions', 'product_brands', 'canonical_products', 'product_variants', 'product_identifiers', 'product_aliases', 'product_relationships')
            AND c.relrowsecurity) AS rls_count,
         (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'retail_price_agent' AND indexname IN
            ('product_identifiers_approved_gtin_unique_idx', 'product_identifiers_approved_brand_mpn_unique_idx', 'product_aliases_resolution_idx')) AS index_count`,
    );
    expect(schema.rows[0]).toEqual({ rls_count: 7, index_count: 3 });
  });
});
