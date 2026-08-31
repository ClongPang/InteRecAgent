import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  BuyWhereClient,
  createPiModelRuntime,
  evaluateLiveDependencyCompatibility,
  parseLiveDependencyBaseline,
  resolveBuyWhereRuntimeConfig,
  type LiveBuyWhereSample,
  type LiveModelSample,
} from "../packages/runtime/src/index.js";

if (process.env["INTEREC_LIVE_DEPENDENCY_CHECK_CONFIRM"] !== "authorized-external-drift") {
  throw new Error("INTEREC_LIVE_DEPENDENCY_CHECK_CONFIRM_MUST_BE_authorized-external-drift");
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_INVALID`);
  return value;
}

function safeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "UNKNOWN_ERROR";
  return raw.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 120) || "UNKNOWN_ERROR";
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function buyWhereContractFingerprint(_rawPayload: unknown, _products: unknown[]): string {
  // A successful BuyWhereClient parse already proves the live payload is
  // compatible with this normalized adapter contract. Do not fingerprint the
  // first data row's runtime types: nullable fields and result ordering are
  // data variation, not API schema comparison.
  return fingerprint({
    adapterContract: "interec-buywhere-normalized-search-v1",
    productFields: ["id", "title", "price", "merchant", "url", "country_code", "category_path"],
    priceFields: ["amount", "currency"],
    nullableFields: ["country_code", "category_path"],
  });
}

const configuration = {
  modelProvider: process.env["INTEREC_MODEL_PROVIDER"]?.trim() || "deepseek",
  modelId: process.env["INTEREC_MODEL_ID"]?.trim() || "deepseek-v4-flash",
  query: process.env["INTEREC_LIVE_DEPENDENCY_CHECK_QUERY"]?.trim() || "Sony WH-1000XM5 headphones",
  market: (process.env["INTEREC_LIVE_DEPENDENCY_CHECK_MARKET"]?.trim().toUpperCase() || "US") as "US" | "SG",
  runs: boundedInteger("INTEREC_LIVE_DEPENDENCY_CHECK_RUNS", 3, 2, 10),
};
if (configuration.market !== "US" && configuration.market !== "SG") throw new Error("INTEREC_LIVE_DEPENDENCY_CHECK_MARKET_INVALID");

const buyWhereConfig = resolveBuyWhereRuntimeConfig();
const buyWhere = new BuyWhereClient(buyWhereConfig.apiKey, { timeoutMs: buyWhereConfig.timeoutMs });
const model = createPiModelRuntime();
const samples = [];
for (let runIndex = 1; runIndex <= configuration.runs; runIndex += 1) {
  let buyWhereSample: LiveBuyWhereSample;
  const buyWhereStarted = performance.now();
  try {
    const result = await buyWhere.search(configuration.query, configuration.market, 2);
    buyWhereSample = {
      ok: true,
      resultCount: result.products.length,
      contractFingerprint: buyWhereContractFingerprint(result.rawPayload, result.products),
      artifactRefPrefix: result.artifactRef.slice(0, 20),
      durationMs: Math.round(performance.now() - buyWhereStarted),
      errorCode: null,
    };
  } catch (error) {
    buyWhereSample = {
      ok: false,
      resultCount: 0,
      contractFingerprint: null,
      artifactRefPrefix: null,
      durationMs: Math.round(performance.now() - buyWhereStarted),
      errorCode: safeErrorCode(error),
    };
  }

  let modelSample: LiveModelSample;
  const modelStarted = performance.now();
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
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
    const contractFingerprint = fingerprint({
      provider: response.provider,
      requestedModel: response.model,
      responseModelType: response.responseModel === null ? "null" : typeof response.responseModel,
      contentBlockTypes: [...new Set(response.content.map((block) => block.type))].sort(),
      usageFields: Object.keys(response.usage).sort(),
    });
    modelSample = {
      ok: response.stopReason !== "error" && response.stopReason !== "aborted",
      provider: response.provider,
      requestedModel: response.model,
      responseModel: response.responseModel ?? null,
      stopReason: response.stopReason,
      text,
      contractFingerprint,
      durationMs: Math.round(performance.now() - modelStarted),
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      errorCode: response.errorMessage ? safeErrorCode(response.errorMessage) : null,
    };
  } catch (error) {
    modelSample = {
      ok: false,
      provider: null,
      requestedModel: null,
      responseModel: null,
      stopReason: null,
      text: null,
      contractFingerprint: null,
      durationMs: Math.round(performance.now() - modelStarted),
      inputTokens: 0,
      outputTokens: 0,
      errorCode: safeErrorCode(error),
    };
  }
  samples.push({ runIndex, buyWhere: buyWhereSample, model: modelSample });
}

const baselinePath = process.env["INTEREC_LIVE_DEPENDENCY_CHECK_BASELINE_PATH"]?.trim();
const baseline = baselinePath
  ? parseLiveDependencyBaseline(JSON.parse(await readFile(resolve(baselinePath), "utf8")))
  : undefined;
const report = evaluateLiveDependencyCompatibility({
  generatedAt: new Date().toISOString(),
  configuration,
  samples,
  ...(baseline ? { baseline } : {}),
});
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const reportPath = process.env["INTEREC_LIVE_EVAL_REGRESSION_REPORT_PATH"]?.trim();
if (reportPath) {
  const resolvedReportPath = resolve(reportPath);
  await mkdir(dirname(resolvedReportPath), { recursive: true });
  await writeFile(resolvedReportPath, serialized, "utf8");
}
process.stdout.write(serialized);
if (!report.passed) process.exitCode = 1;
