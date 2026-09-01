import {
  validateProductIdentitySnapshot,
  type CanonicalProduct,
  type ProductAlias,
  type ProductBrand,
  type ProductIdentifier,
  type ProductIdentityRegistry,
  type ProductIdentitySnapshot,
  type ProductRelationship,
  type ProductVariant,
} from "@interec/domain";
import type pg from "pg";

interface RegistryVersionRow {
  registry_version: number;
  checksum: string;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`PRODUCT_IDENTITY_ROW_INVALID:${field}`);
  return [...value];
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`PRODUCT_IDENTITY_ROW_INVALID:${field}`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) throw new Error(`PRODUCT_IDENTITY_ROW_INVALID:${field}`);
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Loads one immutable registry snapshot under a repeatable-read transaction. */
export class PostgresProductIdentityRegistry implements ProductIdentityRegistry {
  public constructor(private readonly pool: pg.Pool) {}

  public async getActiveSnapshot(): Promise<ProductIdentitySnapshot> {
    const snapshot = await this.loadSnapshot(null);
    if (!snapshot) throw new Error("ACTIVE_PRODUCT_IDENTITY_REGISTRY_NOT_FOUND");
    return snapshot;
  }

  public async getSnapshot(registryVersion: number): Promise<ProductIdentitySnapshot | null> {
    if (!Number.isSafeInteger(registryVersion) || registryVersion < 1) return null;
    return this.loadSnapshot(registryVersion);
  }

  private async loadSnapshot(requestedVersion: number | null): Promise<ProductIdentitySnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const versionResult = requestedVersion === null
        ? await client.query<RegistryVersionRow>(
            `SELECT registry_version, checksum
             FROM interec_agent.product_identity_registry_versions
             WHERE status = 'ACTIVE'`,
          )
        : await client.query<RegistryVersionRow>(
            `SELECT registry_version, checksum
             FROM interec_agent.product_identity_registry_versions
             WHERE registry_version = $1 AND status IN ('ACTIVE', 'RETIRED')`,
            [requestedVersion],
          );
      const version = versionResult.rows[0];
      if (!version) {
        await client.query("COMMIT");
        return null;
      }
      const values = [version.registry_version];
      const brands = await client.query<{
        registry_version: number; brand_ref: string; canonical_name: string; aliases_json: unknown; source_ref: string;
      }>(
        `SELECT registry_version, brand_ref, canonical_name, aliases_json, source_ref
         FROM interec_agent.product_brands WHERE registry_version = $1 ORDER BY brand_ref`, values,
      );
      const products = await client.query<CanonicalProduct & { registry_version: number; product_ref: string; brand_ref: string; canonical_name: string; product_type: string; source_ref: string }>(
        `SELECT registry_version, product_ref, brand_ref, canonical_name, product_type, source_ref
         FROM interec_agent.canonical_products WHERE registry_version = $1 ORDER BY product_ref`, values,
      );
      const variants = await client.query<{
        registry_version: number; variant_ref: string; product_ref: string; canonical_model: string; attributes_json: unknown; status: ProductVariant["status"]; source_ref: string;
      }>(
        `SELECT registry_version, variant_ref, product_ref, canonical_model, attributes_json, status, source_ref
         FROM interec_agent.product_variants WHERE registry_version = $1 ORDER BY variant_ref`, values,
      );
      const identifiers = await client.query<{
        registry_version: number; identifier_ref: string; variant_ref: string; brand_ref: string; scheme: ProductIdentifier["scheme"]; normalized_value: string; approval_status: ProductIdentifier["approvalStatus"]; source_ref: string;
      }>(
        `SELECT registry_version, identifier_ref, variant_ref, brand_ref, scheme, normalized_value, approval_status, source_ref
         FROM interec_agent.product_identifiers WHERE registry_version = $1 ORDER BY identifier_ref`, values,
      );
      const aliases = await client.query<{
        registry_version: number; alias_ref: string; variant_ref: string; purpose: ProductAlias["purpose"]; display_value: string; normalized_key: string; approval_status: ProductAlias["approvalStatus"]; priority: number; source_ref: string;
      }>(
        `SELECT registry_version, alias_ref, variant_ref, purpose, display_value, normalized_key, approval_status, priority, source_ref
         FROM interec_agent.product_aliases WHERE registry_version = $1 ORDER BY alias_ref`, values,
      );
      const relationships = await client.query<{
        registry_version: number; relationship_ref: string; from_variant_ref: string; to_variant_ref: string; kind: ProductRelationship["kind"]; source_ref: string;
      }>(
        `SELECT registry_version, relationship_ref, from_variant_ref, to_variant_ref, kind, source_ref
         FROM interec_agent.product_relationships WHERE registry_version = $1 ORDER BY relationship_ref`, values,
      );
      const snapshot: ProductIdentitySnapshot = {
        schemaVersion: 1,
        registryVersion: version.registry_version,
        checksum: version.checksum,
        brands: brands.rows.map((row): ProductBrand => ({
          registryVersion: row.registry_version,
          brandRef: row.brand_ref,
          canonicalName: row.canonical_name,
          aliases: stringArray(row.aliases_json, row.brand_ref),
          sourceRef: row.source_ref,
        })),
        products: products.rows.map((row): CanonicalProduct => ({
          registryVersion: row.registry_version,
          productRef: row.product_ref,
          brandRef: row.brand_ref,
          canonicalName: row.canonical_name,
          productType: row.product_type,
          sourceRef: row.source_ref,
        })),
        variants: variants.rows.map((row): ProductVariant => ({
          registryVersion: row.registry_version,
          variantRef: row.variant_ref,
          productRef: row.product_ref,
          canonicalModel: row.canonical_model,
          attributes: stringRecord(row.attributes_json, row.variant_ref),
          status: row.status,
          sourceRef: row.source_ref,
        })),
        identifiers: identifiers.rows.map((row): ProductIdentifier => ({
          registryVersion: row.registry_version,
          identifierRef: row.identifier_ref,
          variantRef: row.variant_ref,
          brandRef: row.brand_ref,
          scheme: row.scheme,
          normalizedValue: row.normalized_value,
          approvalStatus: row.approval_status,
          sourceRef: row.source_ref,
        })),
        aliases: aliases.rows.map((row): ProductAlias => ({
          registryVersion: row.registry_version,
          aliasRef: row.alias_ref,
          variantRef: row.variant_ref,
          purpose: row.purpose,
          displayValue: row.display_value,
          normalizedKey: row.normalized_key,
          approvalStatus: row.approval_status,
          priority: row.priority,
          sourceRef: row.source_ref,
        })),
        relationships: relationships.rows.map((row): ProductRelationship => ({
          registryVersion: row.registry_version,
          relationshipRef: row.relationship_ref,
          fromVariantRef: row.from_variant_ref,
          toVariantRef: row.to_variant_ref,
          kind: row.kind,
          sourceRef: row.source_ref,
        })),
      };
      await client.query("COMMIT");
      return validateProductIdentitySnapshot(snapshot);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
