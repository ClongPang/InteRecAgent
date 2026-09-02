import { describe, expect, it } from "vitest";

import { createPiModelRuntime } from "../src/model-factory.js";
import { resolveBuyWhereRuntimeConfig, resolveBuyWhereTimeoutMs } from "../src/runtime-config.js";

describe("quote runtime configuration", () => {
  it("uses a bounded default BuyWhere timeout and trims the required key", () => {
    expect(resolveBuyWhereTimeoutMs({})).toBe(10_000);
    expect(resolveBuyWhereRuntimeConfig({
      RETAIL_PRICE_PROVIDER_BUYWHERE_API_KEY: "  test-key  ",
      RETAIL_PRICE_PROVIDER_BUYWHERE_TIMEOUT_MS: "2500",
    })).toEqual({ apiKey: "test-key", timeoutMs: 2_500 });
  });

  it.each(["abc", "1.5", "-1000", " 10s "])("rejects a non-integer timeout: %s", (raw) => {
    expect(() => resolveBuyWhereTimeoutMs({ RETAIL_PRICE_PROVIDER_BUYWHERE_TIMEOUT_MS: raw })).toThrow(
      "RETAIL_PRICE_PROVIDER_BUYWHERE_TIMEOUT_MS_INVALID",
    );
  });

  it.each(["999", "30001"])("rejects an out-of-range timeout: %s", (raw) => {
    expect(() => resolveBuyWhereTimeoutMs({ RETAIL_PRICE_PROVIDER_BUYWHERE_TIMEOUT_MS: raw })).toThrow(
      "RETAIL_PRICE_PROVIDER_BUYWHERE_TIMEOUT_MS_OUT_OF_RANGE",
    );
  });

  it("requires a non-blank BuyWhere credential", () => {
    expect(() => resolveBuyWhereRuntimeConfig({})).toThrow("RETAIL_PRICE_PROVIDER_BUYWHERE_API_KEY_REQUIRED");
    expect(() => resolveBuyWhereRuntimeConfig({ RETAIL_PRICE_PROVIDER_BUYWHERE_API_KEY: "   " })).toThrow(
      "RETAIL_PRICE_PROVIDER_BUYWHERE_API_KEY_REQUIRED",
    );
  });

  it("constructs the supported model runtimes without performing a network call", () => {
    const deepseek = createPiModelRuntime({ RETAIL_PRICE_MODEL_API_KEY: "key" });
    expect(deepseek).toMatchObject({ apiKey: "key", model: { provider: "deepseek", id: "deepseek-v4-flash" } });
    expect(deepseek.streamFn).toBeTypeOf("function");

    const openai = createPiModelRuntime({
      RETAIL_PRICE_MODEL_API_KEY: "key",
      RETAIL_PRICE_MODEL_PROVIDER: "openai",
      RETAIL_PRICE_MODEL_ID: "gpt-5-mini",
    });
    expect(openai).toMatchObject({ apiKey: "key", model: { provider: "openai", id: "gpt-5-mini" } });
  });

  it("fails closed for missing credentials, unsupported providers, and unknown models", () => {
    expect(() => createPiModelRuntime({})).toThrow("RETAIL_PRICE_MODEL_API_KEY_REQUIRED");
    expect(() => createPiModelRuntime({
      RETAIL_PRICE_MODEL_API_KEY: "key",
      RETAIL_PRICE_MODEL_PROVIDER: "unknown",
    })).toThrow("UNSUPPORTED_PI_PROVIDER:unknown");
    expect(() => createPiModelRuntime({
      RETAIL_PRICE_MODEL_API_KEY: "key",
      RETAIL_PRICE_MODEL_PROVIDER: "deepseek",
      RETAIL_PRICE_MODEL_ID: "not-a-model",
    })).toThrow("PI_MODEL_NOT_FOUND:deepseek/not-a-model");
  });
});
