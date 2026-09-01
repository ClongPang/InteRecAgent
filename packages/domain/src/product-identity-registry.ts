import {
  identityLexicalKey,
  legacyLiteralIdentityBinding,
  normalizeProductIdentifier,
  validateProductIdentitySnapshot,
  type ProductIdentityCandidate,
  type ProductIdentityResolution,
  type ProductIdentitySnapshot,
  type ProductIdentifierScheme,
  type QuoteTargetIdentityBinding,
} from "./product-identity.js";

export interface ProductIdentityRegistry {
  getActiveSnapshot(): Promise<ProductIdentitySnapshot>;
  getSnapshot(registryVersion: number): Promise<ProductIdentitySnapshot | null>;
}

export interface ResolveProductIdentityInput {
  rawText: string;
  proposedModel: string | null;
  brand: string | null;
  productType?: string | null;
  requiredQualifiers?: readonly string[];
  identifiers?: ReadonlyArray<{ scheme: ProductIdentifierScheme; value: string }>;
  explicitlyConfirmed?: boolean;
}

function rawContainsIdentity(rawText: string, identity: string): boolean {
  const wanted = identityLexicalKey(identity);
  if (!wanted) return false;
  const tokens = rawText.normalize("NFKC").toLocaleUpperCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let index = start; index < tokens.length && joined.length <= wanted.length; index += 1) {
      joined += tokens[index]!;
      if (joined === wanted) return true;
    }
  }
  return false;
}

function candidate(snapshot: ProductIdentitySnapshot, variantRef: string, evidenceRefs: string[]): ProductIdentityCandidate {
  const variant = snapshot.variants.find((item) => item.variantRef === variantRef);
  if (!variant) throw new Error(`PRODUCT_VARIANT_REF_NOT_FOUND:${variantRef}`);
  const product = snapshot.products.find((item) => item.productRef === variant.productRef);
  if (!product) throw new Error(`CANONICAL_PRODUCT_REF_NOT_FOUND:${variant.productRef}`);
  return {
    brandRef: product.brandRef,
    productRef: product.productRef,
    variantRef,
    canonicalModel: variant.canonicalModel,
    evidenceRefs: [...new Set(evidenceRefs)].sort(),
  };
}

function providerQuery(snapshot: ProductIdentitySnapshot, value: ProductIdentityCandidate): { query: string; evidenceRef: string | null } {
  const alias = snapshot.aliases
    .filter((item) => item.variantRef === value.variantRef && item.purpose === "PROVIDER_QUERY" && item.approvalStatus === "APPROVED")
    .sort((left, right) => left.priority - right.priority || left.aliasRef.localeCompare(right.aliasRef))[0];
  if (alias) return { query: alias.displayValue, evidenceRef: alias.aliasRef };
  const brand = snapshot.brands.find((item) => item.brandRef === value.brandRef)?.canonicalName;
  return { query: [brand, value.canonicalModel].filter(Boolean).join(" "), evidenceRef: null };
}

function resolved(
  snapshot: ProductIdentitySnapshot,
  strength: "VERIFIED_IDENTIFIER" | "CURATED_ALIAS",
  value: ProductIdentityCandidate,
): ProductIdentityResolution {
  const selected = providerQuery(snapshot, value);
  const product = snapshot.products.find((item) => item.productRef === value.productRef);
  const canonicalBrand = snapshot.brands.find((item) => item.brandRef === value.brandRef)?.canonicalName ?? null;
  const evidenceRefs = [...new Set([...value.evidenceRefs, ...(selected.evidenceRef ? [selected.evidenceRef] : [])])].sort();
  return {
    outcome: "RESOLVED",
    strength,
    registryVersion: snapshot.registryVersion,
    candidate: { ...value, evidenceRefs },
    canonicalModel: value.canonicalModel,
    canonicalBrand,
    productType: product?.productType ?? null,
    providerQuery: selected.query,
    reasonCodes: [],
    evidenceRefs,
  };
}

function brandRefs(snapshot: ProductIdentitySnapshot, input: ResolveProductIdentityInput): Set<string> | null {
  if (!input.brand) return null;
  const key = identityLexicalKey(input.brand);
  const refs = snapshot.brands
    .filter((brand) => [brand.canonicalName, ...brand.aliases].some((value) => identityLexicalKey(value) === key && rawContainsIdentity(input.rawText, value)))
    .map((brand) => brand.brandRef);
  return new Set(refs);
}

function uniqueCandidates(snapshot: ProductIdentitySnapshot, matches: ReadonlyArray<{ variantRef: string; evidenceRef: string }>): ProductIdentityCandidate[] {
  const evidence = new Map<string, string[]>();
  for (const match of matches) evidence.set(match.variantRef, [...(evidence.get(match.variantRef) ?? []), match.evidenceRef]);
  return [...evidence].map(([variantRef, refs]) => candidate(snapshot, variantRef, refs)).sort((left, right) => left.variantRef.localeCompare(right.variantRef));
}

export function findProductIdentityCandidates(
  snapshotInput: ProductIdentitySnapshot,
  rawTexts: readonly string[],
): ProductIdentityCandidate[] {
  const snapshot = validateProductIdentitySnapshot(snapshotInput);
  const matches = snapshot.aliases.flatMap((alias) => (
    alias.purpose === "USER_INPUT"
    && alias.approvalStatus === "APPROVED"
    && rawTexts.some((rawText) => rawContainsIdentity(rawText, alias.displayValue))
      ? [{ variantRef: alias.variantRef, evidenceRef: alias.aliasRef }]
      : []
  ));
  return uniqueCandidates(snapshot, matches);
}

export function resolveProductIdentity(snapshotInput: ProductIdentitySnapshot, input: ResolveProductIdentityInput): ProductIdentityResolution {
  const snapshot = validateProductIdentitySnapshot(snapshotInput);
  const allowedBrands = brandRefs(snapshot, input);
  const identifierMatches: Array<{ variantRef: string; evidenceRef: string }> = [];
  for (const supplied of input.identifiers ?? []) {
    let normalized: string;
    try {
      normalized = normalizeProductIdentifier(supplied.scheme, supplied.value);
    } catch {
      continue;
    }
    for (const identifier of snapshot.identifiers) {
      if (identifier.approvalStatus !== "APPROVED" || identifier.scheme !== supplied.scheme || identifier.normalizedValue !== normalized) continue;
      if (allowedBrands && !allowedBrands.has(identifier.brandRef)) continue;
      identifierMatches.push({ variantRef: identifier.variantRef, evidenceRef: identifier.identifierRef });
    }
  }
  const identified = uniqueCandidates(snapshot, identifierMatches);
  if (identified.length === 1) return resolved(snapshot, "VERIFIED_IDENTIFIER", identified[0]!);
  if (identified.length > 1) {
    return { outcome: "NEEDS_CONFIRMATION", strength: "NONE", registryVersion: snapshot.registryVersion, candidates: identified, reasonCodes: ["IDENTIFIER_CONFLICT"], evidenceRefs: identified.flatMap((item) => item.evidenceRefs) };
  }

  const modelParts = [input.proposedModel, ...(input.requiredQualifiers ?? [])].filter((value): value is string => Boolean(value));
  const proposedKeys = new Set(modelParts.length > 0
    ? [identityLexicalKey(modelParts.join(" ")), identityLexicalKey(input.proposedModel ?? "")]
    : []);
  const allowedAliases = snapshot.aliases.filter((alias) => {
    if (alias.purpose !== "USER_INPUT" || alias.approvalStatus !== "APPROVED") return false;
    return !allowedBrands || allowedBrands.has(candidate(snapshot, alias.variantRef, [alias.aliasRef]).brandRef);
  });
  const proposedMatches = allowedAliases
    .filter((alias) => proposedKeys.has(alias.normalizedKey))
    .map((alias) => ({ variantRef: alias.variantRef, evidenceRef: alias.aliasRef }));
  const proposedCandidates = uniqueCandidates(snapshot, proposedMatches);
  if (proposedCandidates.length === 1) {
    const selectedRef = proposedCandidates[0]!.variantRef;
    const supplemental = allowedAliases
      .filter((alias) => alias.variantRef === selectedRef && rawContainsIdentity(input.rawText, alias.displayValue))
      .map((alias) => ({ variantRef: alias.variantRef, evidenceRef: alias.aliasRef }));
    return resolved(snapshot, "CURATED_ALIAS", uniqueCandidates(snapshot, [...proposedMatches, ...supplemental])[0]!);
  }
  if (proposedCandidates.length > 1) {
    return { outcome: "NEEDS_CONFIRMATION", strength: "NONE", registryVersion: snapshot.registryVersion, candidates: proposedCandidates, reasonCodes: ["ALIAS_AMBIGUOUS"], evidenceRefs: proposedCandidates.flatMap((item) => item.evidenceRefs) };
  }
  const aliased = uniqueCandidates(snapshot, allowedAliases
    .filter((alias) => rawContainsIdentity(input.rawText, alias.displayValue))
    .map((alias) => ({ variantRef: alias.variantRef, evidenceRef: alias.aliasRef })));
  if (aliased.length === 1) return resolved(snapshot, "CURATED_ALIAS", aliased[0]!);
  if (aliased.length > 1) {
    return { outcome: "NEEDS_CONFIRMATION", strength: "NONE", registryVersion: snapshot.registryVersion, candidates: aliased, reasonCodes: ["ALIAS_AMBIGUOUS"], evidenceRefs: aliased.flatMap((item) => item.evidenceRefs) };
  }

  const proposedModel = input.proposedModel?.normalize("NFKC").trim() ?? "";
  if (proposedModel && (rawContainsIdentity(input.rawText, proposedModel) || input.explicitlyConfirmed === true)) {
    const canonicalModel = proposedModel.toLocaleUpperCase("en-US");
    return {
      outcome: "RESOLVED",
      strength: "USER_CONFIRMED_LITERAL",
      registryVersion: null,
      candidate: null,
      canonicalModel,
      canonicalBrand: input.brand?.normalize("NFKC").trim() || null,
      productType: input.productType?.normalize("NFKC").trim() || null,
      providerQuery: [input.brand?.normalize("NFKC").trim(), canonicalModel, input.productType?.normalize("NFKC").trim(), ...(input.requiredQualifiers ?? [])].filter(Boolean).join(" "),
      reasonCodes: [],
      evidenceRefs: legacyLiteralIdentityBinding(input.explicitlyConfirmed === true).evidenceRefs,
    };
  }
  if (proposedModel) {
    return { outcome: "NEEDS_CONFIRMATION", strength: "NONE", registryVersion: snapshot.registryVersion, candidates: [], reasonCodes: ["MODEL_NOT_LEXICALLY_GROUNDED"], evidenceRefs: [] };
  }
  return { outcome: "UNRESOLVED", strength: "NONE", registryVersion: snapshot.registryVersion, candidates: [], reasonCodes: ["MODEL_REQUIRED"], evidenceRefs: [] };
}

/** A model-selected allowlisted candidate can shape clarification, but is never upgraded to identifier authority. */
export function selectProductIdentityCandidateForConfirmation(
  snapshotInput: ProductIdentitySnapshot,
  resolution: ProductIdentityResolution,
  selectedVariantRef: string,
): ProductIdentityResolution {
  const snapshot = validateProductIdentitySnapshot(snapshotInput);
  if (resolution.outcome !== "NEEDS_CONFIRMATION" || resolution.registryVersion !== snapshot.registryVersion) return resolution;
  const selected = resolution.candidates.find((value) => value.variantRef === selectedVariantRef);
  return selected ? resolved(snapshot, "CURATED_ALIAS", selected) : resolution;
}

export function identityBindingFromResolution(resolution: Extract<ProductIdentityResolution, { outcome: "RESOLVED" }>): QuoteTargetIdentityBinding {
  return {
    schemaVersion: 1,
    resolverVersion: "product-identity-resolver-v1",
    outcome: "RESOLVED",
    strength: resolution.strength,
    registryVersion: resolution.registryVersion,
    brandRef: resolution.candidate?.brandRef ?? null,
    productRef: resolution.candidate?.productRef ?? null,
    variantRef: resolution.candidate?.variantRef ?? null,
    evidenceRefs: [...resolution.evidenceRefs],
  };
}

export class InMemoryProductIdentityRegistry implements ProductIdentityRegistry {
  private readonly snapshot: ProductIdentitySnapshot;

  public constructor(snapshot: ProductIdentitySnapshot) {
    this.snapshot = validateProductIdentitySnapshot(snapshot);
  }

  public async getActiveSnapshot(): Promise<ProductIdentitySnapshot> {
    return structuredClone(this.snapshot);
  }

  public async getSnapshot(registryVersion: number): Promise<ProductIdentitySnapshot | null> {
    return registryVersion === this.snapshot.registryVersion ? structuredClone(this.snapshot) : null;
  }
}

export async function resolveProductIdentityFromRegistry(
  registry: ProductIdentityRegistry,
  input: ResolveProductIdentityInput,
): Promise<ProductIdentityResolution> {
  return resolveProductIdentity(await registry.getActiveSnapshot(), input);
}
