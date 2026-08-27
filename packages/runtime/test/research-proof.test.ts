import { describe, expect, it } from "vitest";

import { sourceFactRefFor } from "../src/research-proof.js";

describe("immutable source-fact identity", () => {
  it("identifies a time-bound observation instead of only its repeated content", () => {
    const base = {
      artifactRef: "sha256:same-payload",
      jsonPath: "$.data[0].price.amount",
      canonicalValue: "299",
      derivation: "OBSERVED" as const,
    };
    const first = sourceFactRefFor({ ...base, observedAt: "2026-08-27T01:00:00.000Z" });
    const replay = sourceFactRefFor({ ...base, observedAt: "2026-08-27T01:00:00.000Z" });
    const refresh = sourceFactRefFor({ ...base, observedAt: "2026-08-27T02:00:00.000Z" });
    expect(replay).toBe(first);
    expect(refresh).not.toBe(first);
  });
});
