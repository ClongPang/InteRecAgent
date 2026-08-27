import type pg from "pg";
import { describe, expect, it } from "vitest";

import { PostgresObservedCandidateRepository } from "../src/observed-candidate-repository.js";

function fakePool(rows: Array<Record<string, unknown>> = [], artifactRows: Array<Record<string, unknown>> = []) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let released = false;
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, ...(values ? { values } : {}) });
      if (text.includes("SELECT DISTINCT ON (pa.artifact_ref)")) return { rows: artifactRows, rowCount: artifactRows.length };
      if (text.includes("SELECT oc.*")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: text.includes("INSERT INTO") ? 1 : 0 };
    },
    release: () => { released = true; },
  };
  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    queries,
    released: () => released,
  };
}

const owner = { tenantId: "tenant-a", ownerId: "owner-a" };

describe("Postgres observed-candidate projection", () => {
  it("upserts a normalized owner-scoped candidate in one transaction", async () => {
    const harness = fakePool();
    const repository = new PostgresObservedCandidateRepository(harness.pool);
    expect(await repository.upsert(owner, [{
      candidateRef: "buywhere:US:laptop-1",
      sourceListingId: "11111111-1111-1111-1111-111111111111",
      provider: "buywhere",
      providerListingId: "laptop-1",
      retrievalMarket: "us",
      title: "Lightweight Laptop 14",
      categoryHint: "laptop",
      productType: "Notebook Computer",
      searchTokens: ["Laptop", "14", "lightweight", "laptop"],
      candidate: { title: "Lightweight Laptop 14" },
      supportLevel: "DISCOVERY",
      identityKey: null,
      observedAt: "2026-08-27T00:00:00.000Z",
      expiresAt: "2026-08-28T00:00:00.000Z",
    }])).toBe(1);
    const insert = harness.queries.find((query) => query.text.includes("INSERT INTO interec_agent.observed_candidates"));
    expect(insert?.values).toEqual(expect.arrayContaining(["tenant-a", "owner-a", "US", ["laptop", "14", "lightweight"]]));
    expect(harness.queries.map((query) => query.text)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    expect(harness.released()).toBe(true);
  });

  it("returns fresh token-ranked candidates with deterministic coverage", async () => {
    const harness = fakePool([{
      candidate_ref: "buywhere:US:laptop-1",
      source_listing_id: "11111111-1111-1111-1111-111111111111",
      provider: "buywhere",
      provider_listing_id: "laptop-1",
      retrieval_market: "US",
      title: "Lightweight Laptop 14",
      category_hint: "laptop",
      product_type: "Notebook Computer",
      search_tokens: ["laptop", "lightweight"],
      candidate_json: { title: "Lightweight Laptop 14" },
      support_level: "DISCOVERY",
      identity_key: null,
      observed_at: "2026-08-27T00:00:00.000Z",
      expires_at: "2026-08-28T00:00:00.000Z",
      matched_token_count: 2,
    }]);
    const repository = new PostgresObservedCandidateRepository(harness.pool);
    const found = await repository.search(owner, {
      tokens: ["laptop", "lightweight", "travel"],
      markets: ["us"],
      now: "2026-08-27T12:00:00.000Z",
    });
    expect(found).toMatchObject([{
      candidateRef: "buywhere:US:laptop-1",
      supportLevel: "DISCOVERY",
      matchedTokenCount: 2,
      tokenCoverage: 2 / 3,
    }]);
    const select = harness.queries.find((query) => query.text.includes("SELECT oc.*"));
    expect(select?.values).toEqual([
      "tenant-a",
      "owner-a",
      ["laptop", "lightweight", "travel"],
      "2026-08-27T12:00:00.000Z",
      ["US"],
      24,
    ]);
  });

  it("hydrates fresh source artifacts for proof-safe local reuse", async () => {
    const payload = { data: [{ id: "laptop-1", title: "Lightweight Laptop 14" }] };
    const harness = fakePool([], [{
      artifact_ref: "sha256:artifact",
      retrieval_market: "US",
      payload_json: payload,
      observed_at: "2026-08-27T00:00:00.000Z",
    }]);
    const repository = new PostgresObservedCandidateRepository(harness.pool);
    await expect(repository.loadArtifacts(owner, ["buywhere:US:laptop-1"], "2026-08-27T12:00:00.000Z")).resolves.toEqual([{
      market: "US",
      products: payload.data,
      artifactRef: "sha256:artifact",
      rawPayload: payload,
      observedAt: "2026-08-27T00:00:00.000Z",
    }]);
    const select = harness.queries.find((query) => query.text.includes("SELECT DISTINCT ON (pa.artifact_ref)"));
    expect(select?.values).toEqual(["tenant-a", "owner-a", ["buywhere:US:laptop-1"], "2026-08-27T12:00:00.000Z"]);
    expect(harness.released()).toBe(true);
  });
});
