import { describe, expect, it } from "vitest";

import { developmentEvaluationModelFailureCode } from "../src/development-evaluation-run-policy.js";

describe("development evaluation run policy", () => {
  it("classifies an insufficient-balance model failure", () => {
    expect(developmentEvaluationModelFailureCode(JSON.stringify({
      stopReason: "error",
      errorMessage: "402: Insufficient Balance",
      content: [],
    }))).toBe("MODEL_PROVIDER_INSUFFICIENT_BALANCE");
  });

  it("classifies authorization and rate-limit failures", () => {
    expect(developmentEvaluationModelFailureCode(JSON.stringify({ stopReason: "error", errorMessage: "401: Unauthorized" })))
      .toBe("MODEL_PROVIDER_AUTHORIZATION_FAILED");
    expect(developmentEvaluationModelFailureCode(JSON.stringify({ stopReason: "error", errorMessage: "429: rate limit exceeded" })))
      .toBe("MODEL_PROVIDER_RATE_LIMITED");
  });

  it("does not mistake a tool-protocol validation failure for provider unavailability", () => {
    expect(developmentEvaluationModelFailureCode('Validation failed for tool "publish_reply": too many blocks')).toBeNull();
  });

  it("keeps unknown provider errors fail-closed", () => {
    expect(developmentEvaluationModelFailureCode(JSON.stringify({ stopReason: "error", errorMessage: "upstream connection reset" })))
      .toBe("MODEL_PROVIDER_REQUEST_FAILED");
  });
});
