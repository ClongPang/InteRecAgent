import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build, type Plugin } from "esbuild";

interface Mutant {
  id: string;
  file: string;
  search: string;
  replacement: string;
  invariant(module: Record<string, unknown>): boolean;
}

type OfferIdentityResolver = (
  observedOffer: ReturnType<typeof observation>,
  quoteTarget: typeof target,
  identitySnapshot: typeof snapshot,
) => { publishable: boolean; strength: string };
type IdentityHypothesisReviewer = (
  operation: unknown,
  messages: string[],
  candidates: unknown[],
  providerOperationRequested: boolean,
) => Array<{ code: string }>;
type QuotePlanReviewer = (input: unknown) => { decision: string; violations?: Array<{ code: string }> };
type QuoteTargetResolver = (input: unknown) => { status: string; reasonCodes: string[] };

const target = {
  targetRef: "qt_mutation",
  rawText: "Sony WH-1000XM5",
  brand: "Sony",
  canonicalModel: "WH-1000XM5",
  modelKey: "WH1000XM5",
  productType: "headphones",
  requiredQualifiers: [],
  itemRole: "PRIMARY_PRODUCT",
  conditionPreference: "ANY",
  canonicalQuery: "Sony WH-1000XM5",
  confirmation: "LEXICALLY_GROUNDED",
  normalizationChanges: [],
  identity: {
    schemaVersion: 1,
    resolverVersion: "product-identity-resolver-v1",
    outcome: "RESOLVED",
    strength: "CURATED_ALIAS",
    registryVersion: 1,
    brandRef: "brand_sony",
    productRef: "product_sony_wh",
    variantRef: "variant_xm5",
    evidenceRefs: ["alias_xm5"],
  },
};

const snapshot = {
  schemaVersion: 1,
  registryVersion: 1,
  checksum: "mutation-v1",
  brands: [{ registryVersion: 1, brandRef: "brand_sony", canonicalName: "Sony", aliases: ["Sony"], sourceRef: "mutation" }],
  products: [{ registryVersion: 1, productRef: "product_sony_wh", brandRef: "brand_sony", canonicalName: "WH-1000X", productType: "headphones", sourceRef: "mutation" }],
  variants: [{ registryVersion: 1, variantRef: "variant_xm5", productRef: "product_sony_wh", canonicalModel: "WH-1000XM5", attributes: {}, status: "ACTIVE", sourceRef: "mutation" }],
  identifiers: [],
  aliases: [{ registryVersion: 1, aliasRef: "alias_xm5", variantRef: "variant_xm5", purpose: "USER_INPUT", displayValue: "WH-1000XM5", normalizedKey: "WH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef: "mutation" }],
  relationships: [],
};

function observation(title: string) {
  return {
    observationRef: "qo_mutation",
    provider: "buywhere",
    providerRecordId: "record",
    recordIndex: 0,
    jsonPath: "$.records[0]",
    artifactRef: "sha256:mutation",
    observedAt: "2026-09-01T00:00:00.000Z",
    title,
    originalMoney: { amount: "399", currency: "SGD" },
    merchantLabel: "Merchant",
    merchantTargetUrl: "https://merchant.example/item",
    merchantDomain: "merchant.example",
    outboundUrl: "https://merchant.example/item",
    imageUrl: null,
    providerCountry: null,
    providerUpdatedAt: null,
    providerAvailability: null,
    condition: "UNKNOWN",
    identitySignals: { brand: null, model: null, identifiers: [] },
    rawRecord: {},
  };
}

const mutants: Mutant[] = [
  {
    id: "probabilistic_offer_becomes_publishable",
    file: "packages/domain/src/offer-identity.ts",
    search: "publishable: [\"STRONG_IDENTIFIER_MATCH\", \"CURATED_TITLE_ALIAS_MATCH\", \"EXACT_LEXICAL_MATCH\"].includes(strength),",
    replacement: "publishable: strength !== \"IDENTITY_OR_ROLE_CONFLICT\",",
    invariant: (module) => !(module["resolveOfferIdentity"] as OfferIdentityResolver)(observation("Sony Flagship Wireless Headphones"), target, snapshot).publishable,
  },
  {
    id: "target_alias_is_reversed_into_conflict",
    file: "packages/domain/src/offer-identity.ts",
    search: "alias.variantRef !== targetVariantRef",
    replacement: "alias.variantRef === targetVariantRef",
    invariant: (module) => (module["resolveOfferIdentity"] as OfferIdentityResolver)(observation("Sony WH-1000XM5 Wireless Headphones"), target, snapshot).strength === "CURATED_TITLE_ALIAS_MATCH",
  },
  {
    id: "changed_model_lookup_gate_is_reversed",
    file: "packages/agent/src/identity-hypothesis.ts",
    search: "if (modelChanged && providerOperationRequested)",
    replacement: "if (modelChanged && !providerOperationRequested)",
    invariant: (module) => {
      const raw = "Sony WH-1000XM5";
      const violations = (module["reviewIdentityHypothesis"] as IdentityHypothesisReviewer)({
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        sourceMessageOrdinal: 0,
        identityHypothesis: {
          sourceMessageOrdinal: 0,
          model: { value: "WH-1000XM5", span: { start: 5, end: 15 } },
          brand: { value: "Sony", span: { start: 0, end: 4 } },
          productType: null,
          qualifiers: [],
          selectedVariantRef: null,
          confidence: 1,
        },
        target: { proposedModel: "WH-1000XM4", brand: "Sony", productType: null, requiredQualifiers: [], conditionPreference: "ANY" },
      }, [raw], [], true) as Array<{ code: string }>;
      return violations.some((value) => value.code === "IDENTITY_LOOKUP_REQUIRES_MODEL_LITERAL");
    },
  },
  {
    id: "provider_call_budget_allows_two",
    file: "packages/domain/src/quote-plan-policy.ts",
    search: "if (providerOps.length > 1)",
    replacement: "if (providerOps.length > 2)",
    invariant: (module) => {
      const review = (module["reviewQuoteTurnPlan"] as QuotePlanReviewer)({
        plan: {
          userIntentSummary: "mutated provider budget",
          ops: [
            { opId: "target", kind: "SET_QUOTE_TARGET", source: { messageId: "m1" }, target: { proposedModel: "WH-1000XM5", brand: "Sony", productType: null, requiredQualifiers: [], conditionPreference: "ANY" } },
            { opId: "lookup-1", kind: "LOOKUP_QUOTES" },
            { opId: "lookup-2", kind: "LOOKUP_QUOTES" },
          ],
        },
        state: { contractVersion: "quote-leads-sg-v1", version: 0, target: null, pendingTargetConfirmation: null, leadSet: null, displayQuoteLeadRefs: [], excludedQuoteLeadRefs: [], comparisonQuoteLeadRefs: [], focusQuoteLeadRef: null },
        currentUserMessages: [{ messageId: "m1", content: "Sony WH-1000XM5" }],
      }) as { decision: string; violations?: Array<{ code: string }> };
      return review.decision === "REPAIR_REQUIRED" && review.violations?.[0]?.code === "MULTIPLE_QUOTE_PROVIDER_OPERATIONS";
    },
  },
  {
    id: "canonical_alias_confirmation_gate_is_deleted",
    file: "packages/domain/src/quote-target.ts",
    search: "if (modelKey !== proposedModelKey && input.explicitlyConfirmed !== true)",
    replacement: "if (false && modelKey !== proposedModelKey && input.explicitlyConfirmed !== true)",
    invariant: (module) => {
      const resolution = (module["resolveQuoteTarget"] as QuoteTargetResolver)({
        rawText: "Sony XM5",
        proposedModel: "XM5",
        brand: "Sony",
        identityResolution: {
          outcome: "RESOLVED",
          strength: "CURATED_ALIAS",
          registryVersion: 1,
          candidate: { brandRef: "brand_sony", productRef: "product_sony_wh", variantRef: "variant_xm5", canonicalModel: "WH-1000XM5", evidenceRefs: ["alias_xm5"] },
          canonicalModel: "WH-1000XM5",
          canonicalBrand: "Sony",
          productType: "headphones",
          providerQuery: "Sony WH-1000XM5",
          reasonCodes: [],
          evidenceRefs: ["alias_xm5"],
        },
      });
      return resolution.status === "NEEDS_CONFIRMATION" && resolution.reasonCodes.includes("MODEL_CANONICAL_ALIAS_REQUIRES_CONFIRMATION");
    },
  },
];

async function loadMutant(mutant: Mutant): Promise<Record<string, unknown>> {
  const absolute = resolve(mutant.file);
  const source = await readFile(absolute, "utf8");
  assert.equal(source.split(mutant.search).length - 1, 1, `${mutant.id}: mutation site drifted`);
  const mutated = source.replace(mutant.search, mutant.replacement);
  const plugin: Plugin = {
    name: `identity-mutant-${mutant.id}`,
    setup(buildApi) {
      buildApi.onLoad({ filter: /.*/ }, async (args) => (
        resolve(args.path) === absolute ? { contents: mutated, loader: "ts" } : null
      ));
    },
  };
  const output = await build({
    entryPoints: [absolute],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    sourcemap: false,
    logLevel: "silent",
    plugins: [plugin],
  });
  const code = output.outputFiles[0]?.text;
  if (!code) throw new Error(`${mutant.id}: mutant bundle missing`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${mutant.id}`) as Promise<Record<string, unknown>>;
}

const killed: string[] = [];
const survived: string[] = [];
for (const mutant of mutants) {
  const module = await loadMutant(mutant);
  try {
    if (mutant.invariant(module)) survived.push(mutant.id);
    else killed.push(mutant.id);
  } catch {
    killed.push(mutant.id);
  }
}
assert.deepEqual(survived, [], `identity mutants survived: ${survived.join(",")}`);
console.log(`identity mutation testing: ${killed.length}/${mutants.length} critical mutants killed (${killed.join(", ")})`);
