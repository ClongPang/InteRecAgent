import type { EvaluationFamily, EvaluationReport, MetricResult } from "./task-evaluator.js";

export type EvaluationMetricName = keyof EvaluationReport["metrics"];

export interface DriftPolicy {
  metricRegressionTolerance?: Partial<Record<EvaluationMetricName, number>>;
  allowFixtureVersionChange?: boolean;
  allowEvaluatorVersionChange?: boolean;
}

export interface MetricDrift {
  baseline: number | null;
  current: number | null;
  delta: number | null;
  tolerance: number;
  denominatorChanged: boolean;
  regressed: boolean;
}

export interface EvaluationDriftReport {
  schemaVersion: "interec-eval-drift-v1";
  passed: boolean;
  comparable: boolean;
  baselineImplementationVersion: string;
  currentImplementationVersion: string;
  metrics: Record<EvaluationMetricName, MetricDrift>;
  failures: string[];
}

const METRIC_NAMES: EvaluationMetricName[] = [
  "endToEndTaskSuccess",
  "threeRunStability",
  "multiTurnConstraintState",
  "candidateReferentAccuracy",
  "requiredOperationCoverage",
  "requiredAnswerRecall",
  "positiveOutputRate",
  "recommendationPrecision",
  "factEvidenceConsistency",
];

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`DRIFT_REPORT_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`DRIFT_REPORT_FIELD_INVALID:${path}`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`DRIFT_REPORT_FIELD_INVALID:${path}`);
  return value;
}

function parseMetric(value: unknown, path: string): MetricResult {
  const item = record(value, path);
  const parsedValue = item["value"];
  if (parsedValue !== null && (typeof parsedValue !== "number" || !Number.isFinite(parsedValue))) {
    throw new Error(`DRIFT_REPORT_FIELD_INVALID:${path}.value`);
  }
  if (typeof item["passed"] !== "boolean") throw new Error(`DRIFT_REPORT_FIELD_INVALID:${path}.passed`);
  return {
    numerator: finiteNumber(item["numerator"], `${path}.numerator`),
    denominator: finiteNumber(item["denominator"], `${path}.denominator`),
    value: parsedValue,
    threshold: finiteNumber(item["threshold"], `${path}.threshold`),
    passed: item["passed"],
  };
}

export function parseEvaluationReport(value: unknown): EvaluationReport {
  const item = record(value, "report");
  if (item["schemaVersion"] !== "interec-eval-report-v1") throw new Error("DRIFT_REPORT_SCHEMA_INVALID");
  if (item["mode"] !== "DEVELOPMENT" && item["mode"] !== "SEALED") throw new Error("DRIFT_REPORT_MODE_INVALID");
  if (typeof item["passed"] !== "boolean") throw new Error("DRIFT_REPORT_FIELD_INVALID:report.passed");
  const metricsRaw = record(item["metrics"], "report.metrics");
  const metrics = Object.fromEntries(METRIC_NAMES.map((name) => [name, parseMetric(metricsRaw[name], `report.metrics.${name}`)])) as unknown as EvaluationReport["metrics"];
  const countsRaw = record(item["counts"], "report.counts");
  const familyRaw = record(item["familyStableTasks"], "report.familyStableTasks");
  const familyStableTasks: EvaluationReport["familyStableTasks"] = {};
  for (const [family, rawResult] of Object.entries(familyRaw)) {
    const result = record(rawResult, `report.familyStableTasks.${family}`);
    if (typeof result["passed"] !== "boolean") throw new Error(`DRIFT_REPORT_FIELD_INVALID:report.familyStableTasks.${family}.passed`);
    familyStableTasks[family as EvaluationFamily] = {
      stable: finiteNumber(result["stable"], `report.familyStableTasks.${family}.stable`),
      total: finiteNumber(result["total"], `report.familyStableTasks.${family}.total`),
      passed: result["passed"],
    };
  }
  if (!Array.isArray(item["trials"]) || !Array.isArray(item["failures"])) throw new Error("DRIFT_REPORT_FIELD_INVALID:report.collections");
  return {
    schemaVersion: "interec-eval-report-v1",
    mode: item["mode"],
    implementationVersion: nonemptyString(item["implementationVersion"], "report.implementationVersion"),
    modelId: nonemptyString(item["modelId"], "report.modelId"),
    modelParametersHash: nonemptyString(item["modelParametersHash"], "report.modelParametersHash"),
    promptVersion: nonemptyString(item["promptVersion"], "report.promptVersion"),
    evaluatorVersion: nonemptyString(item["evaluatorVersion"], "report.evaluatorVersion"),
    fixtureVersion: nonemptyString(item["fixtureVersion"], "report.fixtureVersion"),
    passed: item["passed"],
    plannedTrialCount: finiteNumber(item["plannedTrialCount"], "report.plannedTrialCount"),
    validTrialCount: finiteNumber(item["validTrialCount"], "report.validTrialCount"),
    invalidTrialCount: finiteNumber(item["invalidTrialCount"], "report.invalidTrialCount"),
    taskCount: finiteNumber(item["taskCount"], "report.taskCount"),
    stableTaskCount: finiteNumber(item["stableTaskCount"], "report.stableTaskCount"),
    metrics,
    counts: {
      forbiddenOperations: finiteNumber(countsRaw["forbiddenOperations"], "report.counts.forbiddenOperations"),
      wrongCandidateRecommendations: finiteNumber(countsRaw["wrongCandidateRecommendations"], "report.counts.wrongCandidateRecommendations"),
      inconsistentFacts: finiteNumber(countsRaw["inconsistentFacts"], "report.counts.inconsistentFacts"),
    },
    familyStableTasks,
    trials: item["trials"] as EvaluationReport["trials"],
    failures: item["failures"].map((entry, index) => nonemptyString(entry, `report.failures.${index}`)),
  };
}

export function compareEvaluationReports(
  baseline: EvaluationReport,
  current: EvaluationReport,
  policy: DriftPolicy = {},
): EvaluationDriftReport {
  const failures: string[] = [];
  const compatibility: Array<[string, unknown, unknown, boolean]> = [
    ["mode", baseline.mode, current.mode, false],
    ["modelId", baseline.modelId, current.modelId, false],
    ["modelParametersHash", baseline.modelParametersHash, current.modelParametersHash, false],
    ["promptVersion", baseline.promptVersion, current.promptVersion, false],
    ["evaluatorVersion", baseline.evaluatorVersion, current.evaluatorVersion, policy.allowEvaluatorVersionChange === true],
    ["fixtureVersion", baseline.fixtureVersion, current.fixtureVersion, policy.allowFixtureVersionChange === true],
    ["plannedTrialCount", baseline.plannedTrialCount, current.plannedTrialCount, false],
    ["taskCount", baseline.taskCount, current.taskCount, false],
  ];
  for (const [name, left, right, allowed] of compatibility) {
    if (!allowed && left !== right) failures.push(`incomparable:${name}:${String(left)}:${String(right)}`);
  }
  const comparable = !failures.some((failure) => failure.startsWith("incomparable:"));
  const metrics = {} as Record<EvaluationMetricName, MetricDrift>;
  for (const name of METRIC_NAMES) {
    const baselineMetric = baseline.metrics[name];
    const currentMetric = current.metrics[name];
    const tolerance = policy.metricRegressionTolerance?.[name] ?? 0;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new Error(`DRIFT_POLICY_TOLERANCE_INVALID:${name}`);
    const denominatorChanged = baselineMetric.denominator !== currentMetric.denominator;
    const delta = baselineMetric.value === null || currentMetric.value === null ? null : currentMetric.value - baselineMetric.value;
    const regressed = denominatorChanged || delta === null || delta < -tolerance || !currentMetric.passed;
    metrics[name] = { baseline: baselineMetric.value, current: currentMetric.value, delta, tolerance, denominatorChanged, regressed };
    if (comparable && denominatorChanged) failures.push(`metric_denominator_drift:${name}:${baselineMetric.denominator}:${currentMetric.denominator}`);
    if (comparable && delta === null) failures.push(`metric_not_measurable:${name}`);
    else if (comparable && delta !== null && delta < -tolerance) failures.push(`metric_regression:${name}:${delta}`);
    if (comparable && !currentMetric.passed) failures.push(`metric_gate_failed:${name}`);
  }
  if (comparable && current.invalidTrialCount > baseline.invalidTrialCount) failures.push(`invalid_trials_increased:${baseline.invalidTrialCount}:${current.invalidTrialCount}`);
  for (const name of ["forbiddenOperations", "wrongCandidateRecommendations", "inconsistentFacts"] as const) {
    if (comparable && current.counts[name] > baseline.counts[name]) failures.push(`safety_regression:${name}:${baseline.counts[name]}:${current.counts[name]}`);
  }
  for (const [family, baselineResult] of Object.entries(baseline.familyStableTasks)) {
    const currentResult = current.familyStableTasks[family as EvaluationFamily];
    if (comparable && (!currentResult || currentResult.total !== baselineResult.total || currentResult.stable < baselineResult.stable)) {
      failures.push(`family_regression:${family}:${baselineResult.stable}/${baselineResult.total}:${currentResult?.stable ?? "missing"}/${currentResult?.total ?? "missing"}`);
    }
  }
  if (comparable && !current.passed) failures.push("current_report_failed");
  return {
    schemaVersion: "interec-eval-drift-v1",
    passed: comparable && failures.length === 0,
    comparable,
    baselineImplementationVersion: baseline.implementationVersion,
    currentImplementationVersion: current.implementationVersion,
    metrics,
    failures,
  };
}
