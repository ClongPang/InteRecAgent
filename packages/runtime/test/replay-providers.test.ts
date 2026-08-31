import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  parseReplayProviderFixture,
  ReplayFxPort,
  ReplayProductSearchPort,
  searchOffers,
  type ReplayProviderFixture,
} from "../src/index.js";
import { resolveProductTarget, type SearchGoalSnapshot } from "@interec/domain";

let fixture: ReplayProviderFixture;

beforeAll(async () => {
  fixture = parseReplayProviderFixture(JSON.parse(await readFile("spec/evaluation/replay/provider-fixture.json", "utf8")));
});

describe("frozen provider replay", () => {
  it("returns deterministic deep-cloned responses and enforces call budgets", async () => {
    const products = new ReplayProductSearchPort(fixture.productSearch);
    const result = await products.search("lightweight laptop", "US", 8);
    result.products[0]!.title = "mutated by caller";
    expect(fixture.productSearch[0]!.response).toMatchObject({ kind: "SUCCESS", products: [{ title: "Lightweight Laptop 14" }] });
    products.assertComplete();
    await expect(products.search("lightweight laptop", "US", 8)).rejects.toThrow("REPLAY_CALL_BUDGET_EXCEEDED");
  });

  it("fails closed when query, market or limit drifts from the fixture", async () => {
    const products = new ReplayProductSearchPort(fixture.productSearch);
    await expect(products.search("lightweight laptops", "US", 8)).rejects.toThrow("REPLAY_PRODUCT_CALL_UNPLANNED");
    await expect(products.search("lightweight laptop", "US", 7)).rejects.toThrow("REPLAY_PRODUCT_CALL_UNPLANNED");
    expect(() => products.assertComplete()).toThrow("REPLAY_CALL_BUDGET_UNSATISFIED");
  });

  it("runs the offer-search pipeline against frozen products and FX", async () => {
    const products = new ReplayProductSearchPort(fixture.productSearch);
    const fx = new ReplayFxPort(fixture.fx);
    const goal: SearchGoalSnapshot = {
      query: "lightweight laptop",
      target: resolveProductTarget("lightweight laptop"),
      markets: ["US"],
      budgetCny: "6000",
      stockPreference: "ANY",
      excludedOfferRefs: [],
    };
    const result = await searchOffers(goal, goal.query, products, fx);
    expect(result).toMatchObject({ availability: "AVAILABLE", markets: [{ market: "US", status: "COMPLETED", resultCount: 1 }] });
    expect(result.listings[0]).toMatchObject({ title: { value: "Lightweight Laptop 14" } });
    products.assertComplete();
    fx.assertComplete();
  });

  it("rejects fixture schema drift and duplicate case ids", () => {
    const raw = structuredClone(fixture) as unknown as Record<string, unknown>;
    raw["unexpected"] = true;
    expect(() => parseReplayProviderFixture(raw)).toThrow("REPLAY_FIELD_UNKNOWN");

    const duplicate = structuredClone(fixture);
    duplicate.fx[0]!.caseId = duplicate.productSearch[0]!.caseId;
    expect(() => parseReplayProviderFixture(duplicate)).toThrow("REPLAY_CASE_ID_DUPLICATE");
  });
});
