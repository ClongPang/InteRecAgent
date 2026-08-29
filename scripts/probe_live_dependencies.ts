import { BuyWhereClient } from "../packages/runtime/src/providers.js";
import { createPiModelRuntime } from "../packages/runtime/src/model-factory.js";
import { resolveBuyWhereRuntimeConfig } from "../packages/runtime/src/runtime-config.js";
import { telemetryErrorCode } from "../packages/runtime/src/telemetry.js";

if (process.env["INTEREC_LIVE_PROBE_CONFIRM"] !== "authorized-external-probe") {
  throw new Error("INTEREC_LIVE_PROBE_CONFIRM_MUST_BE_authorized-external-probe");
}

const query = process.env["INTEREC_LIVE_PROBE_QUERY"]?.trim() || "Sony WH-1000XM5 headphones";
const market = (process.env["INTEREC_LIVE_PROBE_MARKET"]?.trim().toUpperCase() || "US") as "US" | "SG";
if (market !== "US" && market !== "SG") throw new Error("INTEREC_LIVE_PROBE_MARKET_INVALID");

const buyWhere = resolveBuyWhereRuntimeConfig();
let buyWhereResult: Record<string, unknown>;
try {
  const productResult = await new BuyWhereClient(buyWhere.apiKey, { timeoutMs: buyWhere.timeoutMs })
    .search(query, market, 2);
  buyWhereResult = {
    ok: true,
    market: productResult.market,
    resultCount: productResult.products.length,
    artifactRefPrefix: productResult.artifactRef.slice(0, 20),
    observedAt: productResult.observedAt,
    contractValid: productResult.products.every((product) => typeof product.title === "string"),
  };
} catch (error) {
  buyWhereResult = { ok: false, market, errorCode: telemetryErrorCode(error, "BUYWHERE_PROBE_FAILED") };
}

const model = createPiModelRuntime();
let modelResult: Record<string, unknown>;
try {
  const stream = await model.streamFn(model.model, {
    messages: [{ role: "user", content: "Reply with exactly LIVE_OK", timestamp: Date.now() }],
  }, {
    apiKey: model.apiKey,
    maxTokens: 16,
    timeoutMs: 30_000,
    maxRetries: 0,
    temperature: 0,
  });
  const response = await stream.result();
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`LIVE_MODEL_PROBE_FAILED:${response.errorMessage ?? response.stopReason}`);
  }
  modelResult = {
    ok: true,
    provider: response.provider,
    requestedModel: response.model,
    responseModel: response.responseModel ?? null,
    stopReason: response.stopReason,
    text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim(),
    usage: { input: response.usage.input, output: response.usage.output, total: response.usage.totalTokens },
    reportedCost: response.usage.cost.total,
  };
} catch (error) {
  modelResult = { ok: false, errorCode: telemetryErrorCode(error, "MODEL_PROBE_FAILED") };
}

process.stdout.write(`${JSON.stringify({
  buyWhere: buyWhereResult,
  model: modelResult,
})}\n`);
if (buyWhereResult["ok"] !== true || modelResult["ok"] !== true) process.exitCode = 1;
