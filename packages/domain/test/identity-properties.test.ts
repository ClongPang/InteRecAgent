import { describe, expect, it } from "vitest";

import {
  createQuoteObservation,
  identityLexicalKey,
  resolveOfferIdentity,
  resolveProductIdentity,
  resolveQuoteTarget,
  type ProductIdentitySnapshot,
} from "../src/index.js";

const SEED = 0x1d3a_2026;
const RUNS = 256;
const registryVersion = 11;
const sourceRef = "property-fixture-v11";
const SNAPSHOT: ProductIdentitySnapshot = {
  schemaVersion: 1,
  registryVersion,
  checksum: sourceRef,
  brands: [{ registryVersion, brandRef: "brand_sony", canonicalName: "Sony", aliases: ["Sony"], sourceRef }],
  products: [{ registryVersion, productRef: "product_sony_wh", brandRef: "brand_sony", canonicalName: "WH-1000X", productType: "headphones", sourceRef }],
  variants: [
    { registryVersion, variantRef: "variant_xm4", productRef: "product_sony_wh", canonicalModel: "WH-1000XM4", attributes: {}, status: "ACTIVE", sourceRef },
    { registryVersion, variantRef: "variant_xm5", productRef: "product_sony_wh", canonicalModel: "WH-1000XM5", attributes: {}, status: "ACTIVE", sourceRef },
  ],
  identifiers: [],
  aliases: [
    { registryVersion, aliasRef: "alias_xm4", variantRef: "variant_xm4", purpose: "USER_INPUT", displayValue: "WH-1000XM4", normalizedKey: "WH1000XM4", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_xm5", variantRef: "variant_xm5", purpose: "USER_INPUT", displayValue: "WH-1000XM5", normalizedKey: "WH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "provider_xm5", variantRef: "variant_xm5", purpose: "PROVIDER_QUERY", displayValue: "Sony WH-1000XM5", normalizedKey: "SONYWH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef },
  ],
  relationships: [{ registryVersion, relationshipRef: "xm5_successor", fromVariantRef: "variant_xm5", toVariantRef: "variant_xm4", kind: "SUCCESSOR_OF", sourceRef }],
};

function random(seed = SEED): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function aliasVariant(next: () => number): string {
  const separators = ["", "-", " ", "_", ".", "．"];
  const parts = ["WH", "1000", "XM5"];
  const value = parts.map((part) => next() < 0.5 ? part.toLocaleLowerCase("en-US") : part)
    .join(separators[Math.floor(next() * separators.length)]!);
  return next() < 0.25 ? `  ${value}  ` : value;
}

function shrinkCounterexample(value: string): string {
  const lexical = value.replace(/[^\p{L}\p{N}]+/gu, "");
  return lexical.length <= value.length ? lexical : value;
}

function assertProperty(condition: boolean, run: number, value: string): void {
  if (!condition) throw new Error(`PROPERTY_FAILURE seed=${SEED} run=${run} counterexample=${JSON.stringify(shrinkCounterexample(value))}`);
}

function target() {
  const rawText = "Sony WH-1000XM5";
  const identityResolution = resolveProductIdentity(SNAPSHOT, { rawText, proposedModel: "WH-1000XM5", brand: "Sony" });
  const resolution = resolveQuoteTarget({ rawText, proposedModel: "WH-1000XM5", brand: "Sony", identityResolution });
  if (resolution.status !== "RESOLVED") throw new Error("PROPERTY_TARGET_UNRESOLVED");
  return resolution.target;
}

function offer(title: string) {
  return createQuoteObservation({
    rawRecord: { id: title, title, price: { amount: "399", currency: "SGD" }, merchant: "Merchant", url: "https://merchant.example/item" },
    recordIndex: 0,
    artifactRef: "sha256:property",
    observedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("seeded product identity properties", () => {
  it("normalizes punctuation, spacing, case, and NFKC variants without changing alphanumerics", () => {
    const next = random();
    for (let run = 0; run < RUNS; run += 1) {
      const value = aliasVariant(next);
      assertProperty(identityLexicalKey(value) === "WH1000XM5", run, value);
      const resolution = resolveProductIdentity(SNAPSHOT, { rawText: `Sony ${value}`, proposedModel: value, brand: "Sony" });
      assertProperty(resolution.outcome === "RESOLVED" && resolution.candidate?.variantRef === "variant_xm5", run, value);
    }
  });

  it("never upgrades a changed model digit to the curated target Variant", () => {
    const next = random(SEED ^ 0xa5a5);
    for (let run = 0; run < RUNS; run += 1) {
      const digit = 6 + Math.floor(next() * 4);
      const value = `WH-1000XM${digit}`;
      const resolution = resolveProductIdentity(SNAPSHOT, { rawText: `Sony ${value}`, proposedModel: value, brand: "Sony" });
      assertProperty(resolution.outcome === "RESOLVED"
        && resolution.strength === "USER_CONFIRMED_LITERAL"
        && resolution.candidate === null, run, value);
    }
  });

  it("never publishes neighboring or randomly changed model titles", () => {
    const next = random(SEED ^ 0x5a5a);
    for (let run = 0; run < RUNS; run += 1) {
      const suffix = 4 + Math.floor(next() * 6);
      const title = `Sony WH-1000XM${suffix} Wireless Headphones`;
      const result = resolveOfferIdentity(offer(title), target(), SNAPSHOT);
      assertProperty(suffix === 5 ? result.publishable : !result.publishable, run, title);
    }
  });

  it("is deterministic and does not mutate registry, target, or observation inputs", () => {
    const quoteTarget = target();
    const observation = offer("Sony WH-1000XM5 Wireless Headphones");
    const before = JSON.stringify({ snapshot: SNAPSHOT, quoteTarget, observation });
    const first = resolveOfferIdentity(observation, quoteTarget, SNAPSHOT);
    const second = resolveOfferIdentity(observation, quoteTarget, SNAPSHOT);
    expect(second).toEqual(first);
    expect(JSON.stringify({ snapshot: SNAPSHOT, quoteTarget, observation })).toBe(before);
  });
});
