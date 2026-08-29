import { describe, expect, it } from "vitest";

import { qualificationModelFailureCode } from "../src/internal-qualification-run-policy.js";

describe("internal qualification run policy", () => {
  it("classifies an insufficient-balance model failure", () => {
    expect(qualificationModelFailureCode(JSON.stringify({
      stopReason: "error",
      errorMessage: "402: Insufficient Balance",
      content: [],
    }))).toBe("MODEL_PROVIDER_INSUFFICIENT_BALANCE");
  });

  it("classifies authorization and rate-limit failures", () => {
    expect(qualificationModelFailureCode(JSON.stringify({ stopReason: "error", errorMessage: "401: Unauthorized" })))
      .toBe("MODEL_PROVIDER_AUTHORIZATION_FAILED");
    expect(qualificationModelFailureCode(JSON.stringify({ stopReason: "error", errorMessage: "429: rate limit exceeded" })))
      .toBe("MODEL_PROVIDER_RATE_LIMITED");
  });

  it("does not mistake a tool-protocol validation failure for provider unavailability", () => {
    expect(qualificationModelFailureCode('Validation failed for tool "publish_reply": too many blocks')).toBeNull();
  });

  it("keeps unknown provider errors fail-closed", () => {
    expect(qualificationModelFailureCode(JSON.stringify({ stopReason: "error", errorMessage: "upstream connection reset" })))
      .toBe("MODEL_PROVIDER_REQUEST_FAILED");
  });
});
