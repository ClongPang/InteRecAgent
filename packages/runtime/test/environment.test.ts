import { describe, expect, it } from "vitest";

import {
  requiredRetailPriceEnvironmentValue,
  retailPriceEnvironmentValue,
} from "../src/environment.js";

describe("RetailPriceAgent environment aliases", () => {
  it("prefers the current name and accepts the pre-rename alias", () => {
    expect(retailPriceEnvironmentValue({
      RETAIL_PRICE_MODEL_ID: "current-model",
      INTEREC_MODEL_ID: "legacy-model",
    }, "MODEL_ID")).toBe("current-model");
    expect(retailPriceEnvironmentValue({ INTEREC_MODEL_ID: "legacy-model" }, "MODEL_ID")).toBe("legacy-model");
  });

  it("reports the current variable name when neither alias is configured", () => {
    expect(() => requiredRetailPriceEnvironmentValue({}, "DATABASE_URL"))
      .toThrow("RETAIL_PRICE_DATABASE_URL_REQUIRED");
  });
});
