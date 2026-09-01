import { DomainError } from "./errors.js";

export const PRODUCT_IDENTITY_SCHEMA_VERSION = 1 as const;
export const PRODUCT_IDENTITY_RESOLVER_VERSION = "product-identity-resolver-v1" as const;

export type IdentityResolutionOutcome = "RESOLVED" | "NEEDS_CONFIRMATION" | "UNRESOLVED";
export type IdentityResolutionStrength = "VERIFIED_IDENTIFIER" | "CURATED_ALIAS" | "USER_CONFIRMED_LITERAL" | "NONE";
export type ProductIdentityApprovalStatus = "PROPOSED" | "APPROVED" | "RETIRED";
export type ProductAliasPurpose = "USER_INPUT" | "PROVIDER_QUERY";
export type ProductIdentifierScheme = "GTIN" | "BRAND_MPN";
export type ProductRelationshipKind = "SUCCESSOR_OF" | "ACCESSORY_OF" | "BUNDLE_OF";

interface VersionedIdentityRecord {
  registryVersion: number;
  sourceRef: string;
}

export interface ProductBrand extends VersionedIdentityRecord {
  brandRef: string;
  canonicalName: string;
  aliases: string[];
}

export interface CanonicalProduct extends VersionedIdentityRecord {
  productRef: string;
  brandRef: string;
  canonicalName: string;
  productType: string;
}

export interface ProductVariant extends VersionedIdentityRecord {
  variantRef: string;
  productRef: string;
  canonicalModel: string;
  attributes: Record<string, string>;
  status: "ACTIVE" | "RETIRED";
}

export interface ProductIdentifier extends VersionedIdentityRecord {
  identifierRef: string;
  variantRef: string;
  brandRef: string;
  scheme: ProductIdentifierScheme;
  normalizedValue: string;
  approvalStatus: ProductIdentityApprovalStatus;
}

export interface ProductAlias extends VersionedIdentityRecord {
  aliasRef: string;
  variantRef: string;
  purpose: ProductAliasPurpose;
  displayValue: string;
  normalizedKey: string;
  approvalStatus: ProductIdentityApprovalStatus;
  priority: number;
}

export interface ProductRelationship extends VersionedIdentityRecord {
  relationshipRef: string;
  fromVariantRef: string;
  toVariantRef: string;
  kind: ProductRelationshipKind;
}

export interface ProductIdentitySnapshot {
  schemaVersion: typeof PRODUCT_IDENTITY_SCHEMA_VERSION;
  registryVersion: number;
  checksum: string;
  brands: ProductBrand[];
  products: CanonicalProduct[];
  variants: ProductVariant[];
  identifiers: ProductIdentifier[];
  aliases: ProductAlias[];
  relationships: ProductRelationship[];
}

export interface ProductIdentityCandidate {
  brandRef: string;
  productRef: string;
  variantRef: string;
  canonicalModel: string;
  evidenceRefs: string[];
}

export type ProductIdentityResolution =
  | {
      outcome: "RESOLVED";
      strength: Exclude<IdentityResolutionStrength, "NONE">;
      registryVersion: number | null;
      candidate: ProductIdentityCandidate | null;
      canonicalModel: string;
      canonicalBrand: string | null;
      productType: string | null;
      providerQuery: string;
      reasonCodes: [];
      evidenceRefs: string[];
    }
  | {
      outcome: "NEEDS_CONFIRMATION";
      strength: "NONE";
      registryVersion: number;
      candidates: ProductIdentityCandidate[];
      reasonCodes: string[];
      evidenceRefs: string[];
    }
  | {
      outcome: "UNRESOLVED";
      strength: "NONE";
      registryVersion: number;
      candidates: [];
      reasonCodes: string[];
      evidenceRefs: [];
    };

export interface QuoteTargetIdentityBinding {
  schemaVersion: typeof PRODUCT_IDENTITY_SCHEMA_VERSION;
  resolverVersion: typeof PRODUCT_IDENTITY_RESOLVER_VERSION;
  outcome: "RESOLVED";
  strength: Exclude<IdentityResolutionStrength, "NONE">;
  registryVersion: number | null;
  brandRef: string | null;
  productRef: string | null;
  variantRef: string | null;
  evidenceRefs: string[];
}

function required(value: string, code: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new DomainError(code, value);
  return normalized;
}

function uniqueRefs<T>(records: readonly T[], select: (record: T) => string, code: string): void {
  const refs = records.map((record) => required(select(record), code));
  if (new Set(refs).size !== refs.length) throw new DomainError(code, refs.join(","));
}

export function identityLexicalKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleUpperCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeProductIdentifier(scheme: ProductIdentifierScheme, value: string): string {
  if (scheme === "GTIN") {
    const digits = value.normalize("NFKC").replace(/[^0-9]+/gu, "");
    if (![8, 12, 13, 14].includes(digits.length)) throw new DomainError("INVALID_GTIN_LENGTH", value);
    const body = digits.slice(0, -1).split("").reverse();
    const sum = body.reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== Number(digits.at(-1))) throw new DomainError("INVALID_GTIN_CHECK_DIGIT", value);
    return digits;
  }
  const key = identityLexicalKey(value);
  if (!key || !/\p{N}/u.test(key)) throw new DomainError("INVALID_BRAND_MPN", value);
  return key;
}

export function validateProductIdentitySnapshot(input: ProductIdentitySnapshot): ProductIdentitySnapshot {
  const value = structuredClone(input);
  if (value.schemaVersion !== PRODUCT_IDENTITY_SCHEMA_VERSION) throw new DomainError("PRODUCT_IDENTITY_SCHEMA_MISMATCH", String(value.schemaVersion));
  if (!Number.isSafeInteger(value.registryVersion) || value.registryVersion < 1) throw new DomainError("INVALID_PRODUCT_IDENTITY_VERSION", String(value.registryVersion));
  required(value.checksum, "PRODUCT_IDENTITY_CHECKSUM_REQUIRED");
  uniqueRefs(value.brands, (record) => record.brandRef, "DUPLICATE_PRODUCT_BRAND_REF");
  uniqueRefs(value.products, (record) => record.productRef, "DUPLICATE_CANONICAL_PRODUCT_REF");
  uniqueRefs(value.variants, (record) => record.variantRef, "DUPLICATE_PRODUCT_VARIANT_REF");
  uniqueRefs(value.identifiers, (record) => record.identifierRef, "DUPLICATE_PRODUCT_IDENTIFIER_REF");
  uniqueRefs(value.aliases, (record) => record.aliasRef, "DUPLICATE_PRODUCT_ALIAS_REF");
  uniqueRefs(value.relationships, (record) => record.relationshipRef, "DUPLICATE_PRODUCT_RELATIONSHIP_REF");
  const brands = new Map(value.brands.map((brand) => [brand.brandRef, brand]));
  const products = new Map(value.products.map((product) => [product.productRef, product]));
  const variants = new Map(value.variants.map((variant) => [variant.variantRef, variant]));
  for (const record of [...value.brands, ...value.products, ...value.variants, ...value.identifiers, ...value.aliases, ...value.relationships]) {
    if (record.registryVersion !== value.registryVersion) throw new DomainError("PRODUCT_IDENTITY_RECORD_VERSION_MISMATCH", record.sourceRef);
    required(record.sourceRef, "PRODUCT_IDENTITY_SOURCE_REQUIRED");
  }
  for (const product of value.products) if (!brands.has(product.brandRef)) throw new DomainError("PRODUCT_BRAND_REF_NOT_FOUND", product.brandRef);
  for (const variant of value.variants) if (!products.has(variant.productRef)) throw new DomainError("CANONICAL_PRODUCT_REF_NOT_FOUND", variant.productRef);
  const approvedIdentifiers = new Set<string>();
  for (const identifier of value.identifiers) {
    const variant = variants.get(identifier.variantRef);
    if (!variant) throw new DomainError("PRODUCT_VARIANT_REF_NOT_FOUND", identifier.variantRef);
    const brandRef = products.get(variant.productRef)?.brandRef;
    if (brandRef !== identifier.brandRef) throw new DomainError("PRODUCT_IDENTIFIER_BRAND_MISMATCH", identifier.identifierRef);
    const normalized = normalizeProductIdentifier(identifier.scheme, identifier.normalizedValue);
    if (normalized !== identifier.normalizedValue) throw new DomainError("PRODUCT_IDENTIFIER_NOT_NORMALIZED", identifier.identifierRef);
    if (identifier.approvalStatus === "APPROVED") {
      const authorityKey = identifier.scheme === "GTIN"
        ? `${identifier.scheme}:${normalized}`
        : `${identifier.scheme}:${identifier.brandRef}:${normalized}`;
      if (approvedIdentifiers.has(authorityKey)) throw new DomainError("DUPLICATE_APPROVED_PRODUCT_IDENTIFIER", authorityKey);
      approvedIdentifiers.add(authorityKey);
    }
  }
  for (const alias of value.aliases) {
    if (!variants.has(alias.variantRef)) throw new DomainError("PRODUCT_VARIANT_REF_NOT_FOUND", alias.variantRef);
    if (identityLexicalKey(alias.displayValue) !== alias.normalizedKey) throw new DomainError("PRODUCT_ALIAS_NOT_NORMALIZED", alias.aliasRef);
    if (!Number.isSafeInteger(alias.priority) || alias.priority < 0) throw new DomainError("INVALID_PRODUCT_ALIAS_PRIORITY", alias.aliasRef);
  }
  for (const relationship of value.relationships) {
    if (!variants.has(relationship.fromVariantRef) || !variants.has(relationship.toVariantRef)) throw new DomainError("PRODUCT_RELATIONSHIP_VARIANT_NOT_FOUND", relationship.relationshipRef);
    if (relationship.fromVariantRef === relationship.toVariantRef) throw new DomainError("PRODUCT_RELATIONSHIP_SELF_REFERENCE", relationship.relationshipRef);
  }
  return value;
}

export function legacyLiteralIdentityBinding(explicitlyConfirmed: boolean): QuoteTargetIdentityBinding {
  return {
    schemaVersion: PRODUCT_IDENTITY_SCHEMA_VERSION,
    resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    outcome: "RESOLVED",
    strength: "USER_CONFIRMED_LITERAL",
    registryVersion: null,
    brandRef: null,
    productRef: null,
    variantRef: null,
    evidenceRefs: [explicitlyConfirmed ? "USER_EXPLICIT_CONFIRMATION" : "USER_SOURCE_LITERAL"],
  };
}
