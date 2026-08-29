import { describe, expect, it } from "vitest";

import { PROTOCOL_ADVERSARIAL_FAMILIES, runProtocolAdversarialAcceptance } from "../src/protocol-adversarial.js";

describe("30-case protocol adversarial acceptance", () => {
  it("fails closed for five cases in each registered family", async () => {
    const report = await runProtocolAdversarialAcceptance();
    expect(report).toMatchObject({ passed: true, passedCases: 30, totalCases: 30, failures: [] });
    for (const family of PROTOCOL_ADVERSARIAL_FAMILIES) expect(report.familyResults[family]).toEqual({ passed: 5, total: 5 });
  });
});
