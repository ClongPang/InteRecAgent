export interface LiveDependencyCheckConfiguration {
  modelProvider: string;
  modelId: string;
  query: string;
  market: "US" | "SG";
  runs: number;
}

export interface LiveBuyWhereSample {
  ok: boolean;
  resultCount: number;
  contractFingerprint: string | null;
  artifactRefPrefix: string | null;
  durationMs: number;
  errorCode: string | null;
}

export interface LiveModelSample {
  ok: boolean;
  provider: string | null;
  requestedModel: string | null;
  responseModel: string | null;
  stopReason: string | null;
  text: string | null;
  contractFingerprint: string | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  errorCode: string | null;
}

export interface LiveDependencyCheckSample {
  runIndex: number;
  buyWhere: LiveBuyWhereSample;
  model: LiveModelSample;
}

export interface LiveDependencyCompatibilityReport {
  schemaVersion: "interec-live-dependency-compatibility-v1";
  generatedAt: string;
  configuration: LiveDependencyCheckConfiguration;
  passed: boolean;
  comparableToBaseline: boolean;
  samples: LiveDependencyCheckSample[];
  summary: {
    buyWhereSuccessfulRuns: number;
    modelSuccessfulRuns: number;
    buyWhereContractFingerprints: string[];
    modelContractFingerprints: string[];
  };
  failures: string[];
}

export interface LiveDependencyCheckInput {
  generatedAt: string;
  configuration: LiveDependencyCheckConfiguration;
  samples: LiveDependencyCheckSample[];
  baseline?: LiveDependencyCompatibilityReport;
}

function baselineRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function baselineText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:${path}`);
  return value.trim();
}

function baselineStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) throw new Error(`LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:${path}`);
  return value.map((entry) => entry.trim());
}

function baselineInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:${path}`);
  return Number(value);
}

export function parseLiveDependencyBaseline(value: unknown): LiveDependencyCompatibilityReport {
  const item = baselineRecord(value, "report");
  if (item["schemaVersion"] !== "interec-live-dependency-compatibility-v1") throw new Error("LIVE_DEPENDENCY_CHECK_BASELINE_SCHEMA_INVALID");
  if (typeof item["passed"] !== "boolean") throw new Error("LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:report.passed");
  const configuration = baselineRecord(item["configuration"], "report.configuration");
  const market = baselineText(configuration["market"], "report.configuration.market");
  if (market !== "US" && market !== "SG") throw new Error("LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:report.configuration.market");
  const runs = baselineInteger(configuration["runs"], "report.configuration.runs");
  if (runs < 2) throw new Error("LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:report.configuration.runs");
  const summary = baselineRecord(item["summary"], "report.summary");
  if (!Array.isArray(item["samples"]) || !Array.isArray(item["failures"])) throw new Error("LIVE_DEPENDENCY_CHECK_BASELINE_INVALID:report.collections");
  return {
    schemaVersion: "interec-live-dependency-compatibility-v1",
    generatedAt: baselineText(item["generatedAt"], "report.generatedAt"),
    configuration: {
      modelProvider: baselineText(configuration["modelProvider"], "report.configuration.modelProvider"),
      modelId: baselineText(configuration["modelId"], "report.configuration.modelId"),
      query: baselineText(configuration["query"], "report.configuration.query"),
      market,
      runs,
    },
    passed: item["passed"],
    comparableToBaseline: item["comparableToBaseline"] === true,
    samples: item["samples"] as LiveDependencyCheckSample[],
    summary: {
      buyWhereSuccessfulRuns: baselineInteger(summary["buyWhereSuccessfulRuns"], "report.summary.buyWhereSuccessfulRuns"),
      modelSuccessfulRuns: baselineInteger(summary["modelSuccessfulRuns"], "report.summary.modelSuccessfulRuns"),
      buyWhereContractFingerprints: baselineStrings(summary["buyWhereContractFingerprints"], "report.summary.buyWhereContractFingerprints"),
      modelContractFingerprints: baselineStrings(summary["modelContractFingerprints"], "report.summary.modelContractFingerprints"),
    },
    failures: item["failures"].map((entry, index) => baselineText(entry, `report.failures.${index}`)),
  };
}

export function evaluateLiveDependencyCompatibility(input: LiveDependencyCheckInput): LiveDependencyCompatibilityReport {
  const failures: string[] = [];
  if (input.samples.length !== input.configuration.runs) failures.push(`sample_count:${input.samples.length}/${input.configuration.runs}`);
  const indexes = input.samples.map((sample) => sample.runIndex);
  if (new Set(indexes).size !== indexes.length || indexes.some((index, position) => index !== position + 1)) failures.push("sample_indexes_invalid");
  for (const sample of input.samples) {
    if (!sample.buyWhere.ok) failures.push(`buywhere_failed:${sample.runIndex}:${sample.buyWhere.errorCode ?? "UNKNOWN"}`);
    else {
      if (sample.buyWhere.resultCount < 1) failures.push(`buywhere_empty:${sample.runIndex}`);
      if (!sample.buyWhere.contractFingerprint) failures.push(`buywhere_contract_missing:${sample.runIndex}`);
    }
    if (!sample.model.ok) failures.push(`model_failed:${sample.runIndex}:${sample.model.errorCode ?? "UNKNOWN"}`);
    else {
      if (sample.model.provider !== input.configuration.modelProvider) failures.push(`unexpected_model_provider:${sample.runIndex}:${sample.model.provider ?? "null"}`);
      if (sample.model.requestedModel !== input.configuration.modelId) failures.push(`unexpected_model_id:${sample.runIndex}:${sample.model.requestedModel ?? "null"}`);
      if (sample.model.text !== "LIVE_OK") failures.push(`model_probe_text:${sample.runIndex}:${sample.model.text ?? "null"}`);
      if (sample.model.stopReason === "error" || sample.model.stopReason === "aborted") failures.push(`model_stop_reason:${sample.runIndex}:${sample.model.stopReason}`);
      if (!sample.model.contractFingerprint) failures.push(`model_contract_missing:${sample.runIndex}`);
    }
  }
  const buyWhereContractFingerprints = [...new Set(input.samples.flatMap((sample) => sample.buyWhere.contractFingerprint ? [sample.buyWhere.contractFingerprint] : []))].sort();
  const modelContractFingerprints = [...new Set(input.samples.flatMap((sample) => sample.model.contractFingerprint ? [sample.model.contractFingerprint] : []))].sort();
  if (buyWhereContractFingerprints.length > 1) failures.push(`buywhere_contract_unstable:${buyWhereContractFingerprints.length}`);
  if (modelContractFingerprints.length > 1) failures.push(`model_contract_unstable:${modelContractFingerprints.length}`);

  let comparableToBaseline = input.baseline !== undefined;
  if (input.baseline) {
    const baseline = input.baseline;
    if (!baseline.passed) {
      comparableToBaseline = false;
      failures.push("baseline_report_failed");
    }
    const compatible = baseline.passed
      && baseline.configuration.modelProvider === input.configuration.modelProvider
      && baseline.configuration.modelId === input.configuration.modelId
      && baseline.configuration.query === input.configuration.query
      && baseline.configuration.market === input.configuration.market;
    if (!compatible && baseline.passed) {
      comparableToBaseline = false;
      failures.push("baseline_configuration_incompatible");
    } else {
      if (baseline.summary.buyWhereContractFingerprints.length !== 1 || baseline.summary.buyWhereContractFingerprints[0] !== buyWhereContractFingerprints[0]) {
        failures.push(`baseline_buywhere_contract_changed:${baseline.summary.buyWhereContractFingerprints[0] ?? "missing"}:${buyWhereContractFingerprints[0] ?? "missing"}`);
      }
      if (baseline.summary.modelContractFingerprints.length !== 1 || baseline.summary.modelContractFingerprints[0] !== modelContractFingerprints[0]) {
        failures.push(`baseline_model_contract_changed:${baseline.summary.modelContractFingerprints[0] ?? "missing"}:${modelContractFingerprints[0] ?? "missing"}`);
      }
    }
  }
  return {
    schemaVersion: "interec-live-dependency-compatibility-v1",
    generatedAt: input.generatedAt,
    configuration: input.configuration,
    passed: failures.length === 0,
    comparableToBaseline,
    samples: input.samples,
    summary: {
      buyWhereSuccessfulRuns: input.samples.filter((sample) => sample.buyWhere.ok).length,
      modelSuccessfulRuns: input.samples.filter((sample) => sample.model.ok).length,
      buyWhereContractFingerprints,
      modelContractFingerprints,
    },
    failures,
  };
}
