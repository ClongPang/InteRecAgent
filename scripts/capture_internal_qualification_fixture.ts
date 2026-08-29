import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  BuyWhereClient,
  FxRatesClient,
  parseReplayProviderFixture,
  resolveBuyWhereRuntimeConfig,
  type ReplayProviderFixture,
} from "../packages/runtime/src/index.js";

if (process.env["INTEREC_INTERNAL_CAPTURE_CONFIRM"] !== "authorized-internal-fixture-capture") {
  throw new Error("INTEREC_INTERNAL_CAPTURE_CONFIRM_MUST_BE_authorized-internal-fixture-capture");
}

const queries = [
  "WH1000XM5",
  "WH1000XM5 headphones",
  "WH1000XM4",
  "WH1000XM4 headphones",
  "IPHONE 16 PRO 256GB",
  "IPHONE 16 PRO 256GB smartphone",
  "IPHONE 16 PRO 128GB",
  "PIXEL 9 PRO 256GB",
  "PIXEL 9 PRO 256GB smartphone",
  "front load washing machine",
  "ergonomic office chair",
  "portable audio device",
] as const;
const markets = ["US", "SG"] as const;
const outputPath = resolve(process.env["INTEREC_INTERNAL_CAPTURE_PATH"] ?? ".artifacts/evaluation/internal-provider-capture-v1.json");
const config = resolveBuyWhereRuntimeConfig();
const products = new BuyWhereClient(config.apiKey, { timeoutMs: config.timeoutMs });
const fx = new FxRatesClient();
const previous = existsSync(outputPath)
  ? parseReplayProviderFixture(JSON.parse(readFileSync(outputPath, "utf8")))
  : null;
if (previous && previous.fixtureVersion !== "internal-buywhere-capture-v1") throw new Error("INTERNAL_CAPTURE_VERSION_MISMATCH");
const productSearch: ReplayProviderFixture["productSearch"] = previous ? [...previous.productSearch] : [];
const fxCases: ReplayProviderFixture["fx"] = previous ? [...previous.fx] : [];
const failures: Array<{ query: string; market: string; error: string }> = [];

function persist(): void {
  const fixture: ReplayProviderFixture = {
    schemaVersion: "interec-replay-provider-v1",
    fixtureVersion: "internal-buywhere-capture-v1",
    productSearch,
    fx: fxCases,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

async function pause(attempt: number): Promise<void> {
  const delayMs = Math.min(20_000, 5_000 * (2 ** attempt)) + Math.floor(Math.random() * 750);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

for (const query of queries) {
  for (const market of markets) {
    if (productSearch.some((entry) => entry.query === query && entry.market === market && entry.requestedLimit === 8)) continue;
    let captured = false;
    let lastError = "UNKNOWN";
    for (let attempt = 0; attempt < 3 && !captured; attempt += 1) {
    try {
      const result = await products.search(query, market, 8);
      productSearch.push({
        caseId: `capture-${productSearch.length + 1}`,
        query,
        market,
        requestedLimit: 8,
        callBudget: { min: 0, max: 4 },
        response: {
          kind: "SUCCESS",
          artifactRef: result.artifactRef,
          observedAt: result.observedAt,
          products: result.products,
          rawPayload: result.rawPayload,
        },
      });
      persist();
      captured = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "UNKNOWN";
      if (attempt < 2 && /BUYWHERE_(?:HTTP_429|TIMEOUT|NETWORK_ERROR)/u.test(lastError)) await pause(attempt);
    }
    }
    if (!captured) failures.push({ query, market, error: lastError });
  }
}

const currencies = new Set(productSearch.flatMap((entry) => entry.response.kind === "SUCCESS"
  ? entry.response.products.flatMap((product) => product.price && typeof product.price === "object" && typeof product.price.currency === "string" ? [product.price.currency.toUpperCase()] : [])
  : []));
for (const currency of [...currencies].sort()) {
  if (fxCases.some((entry) => entry.base === currency)) continue;
  try {
    const snapshot = await fx.getRate(currency);
    fxCases.push({ caseId: `capture-fx-${currency.toLowerCase()}`, base: currency, callBudget: { min: 0, max: 16 }, response: { kind: "SUCCESS", snapshot } });
    persist();
  } catch (error) {
    failures.push({ query: `FX:${currency}`, market: "CNY", error: error instanceof Error ? error.message : "UNKNOWN" });
  }
}

persist();
process.stdout.write(`${JSON.stringify({
  outputPath,
  requestedProductCases: queries.length * markets.length,
  capturedProductCases: productSearch.length,
  fxCases: fxCases.length,
  failures,
}, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
