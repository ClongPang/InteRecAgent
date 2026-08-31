import { describe, expect, it } from "vitest";

import { PROTOCOL_NEGATIVE_TEST_FAMILIES, runProtocolNegativeTestAcceptance } from "../src/protocol-negative-tests.js";

describe("30-case protocol negative-test acceptance", () => {
  it("fails closed for five cases in each registered family", async () => {
    const report = await runProtocolNegativeTestAcceptance();
    expect(report).toMatchObject({ passed: true, passedCases: 30, totalCases: 30, failures: [] });
    for (const family of PROTOCOL_NEGATIVE_TEST_FAMILIES) expect(report.familyResults[family]).toEqual({ passed: 5, total: 5 });
  });
});
