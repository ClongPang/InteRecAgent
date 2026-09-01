import { describe, expect, it } from "vitest";

import { canonicalDecimal, compareDecimal, convertToCny, type FxSnapshot } from "../src/index.js";

const fx: FxSnapshot = {
  id: "fx-sgd-cny",
  base: "SGD",
  quote: "CNY",
  rate: "5.4321",
  provider: "fxratesapi",
  observedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-01T01:00:00.000Z",
};

function capture(action: () => unknown): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

describe("quote money arithmetic", () => {
  it("canonicalizes finite decimals without binary floating-point conversion", () => {
    expect(canonicalDecimal("001.2300")).toBe("1.23");
    expect(canonicalDecimal("-0")).toBe("0");
    expect(compareDecimal("9.99", "10.00")).toBe(-1);
    expect(compareDecimal("10", "10.0")).toBe(0);
    expect(compareDecimal("10.01", "10")).toBe(1);
  });

  it.each(["not-a-number", "NaN", "Infinity", "-Infinity"])("rejects invalid or non-finite input: %s", (value) => {
    expect(capture(() => canonicalDecimal(value))).toMatchObject({ name: "DomainError", code: "INVALID_DECIMAL" });
  });

  it("converts the matching original-currency amount and rounds only the CNY estimate", () => {
    expect(convertToCny({ currency: "sgd", amount: "12.345" }, fx)).toBe("67.06");
  });

  it("fails closed on a mismatched pair or non-positive amount/rate", () => {
    expect(capture(() => convertToCny({ currency: "USD", amount: "12" }, fx))).toMatchObject({ code: "FX_PAIR_MISMATCH" });
    expect(capture(() => convertToCny({ currency: "SGD", amount: "0" }, fx))).toMatchObject({ code: "NON_POSITIVE_MONEY" });
    expect(capture(() => convertToCny({ currency: "SGD", amount: "12" }, { ...fx, rate: "-1" }))).toMatchObject({
      code: "NON_POSITIVE_MONEY",
    });
  });
});
