import { describe, expect, it } from "vitest";

import { resolveLiveTurnConfig } from "../src/live-turn-config.js";

describe("live Turn safety gate", () => {
  const turnId = "0198f7ec-4f1d-7bb4-8f6a-f57d6975ea31";

  it("requires an explicit external-call confirmation", () => {
    expect(() => resolveLiveTurnConfig({ INTEREC_LIVE_TURN_ID: turnId }))
      .toThrow("INTEREC_LIVE_TURN_CONFIRM_MUST_BE_authorized-external-turn");
  });

  it("requires one exact UUID and never permits queue scanning", () => {
    expect(() => resolveLiveTurnConfig({
      INTEREC_LIVE_TURN_CONFIRM: "authorized-external-turn",
      INTEREC_LIVE_TURN_ID: "all",
    })).toThrow("INTEREC_LIVE_TURN_ID_MUST_BE_UUID");
  });

  it("accepts one explicitly authorized Turn id", () => {
    expect(resolveLiveTurnConfig({
      INTEREC_LIVE_TURN_CONFIRM: "authorized-external-turn",
      INTEREC_LIVE_TURN_ID: turnId,
    })).toEqual({ turnId });
  });
});
