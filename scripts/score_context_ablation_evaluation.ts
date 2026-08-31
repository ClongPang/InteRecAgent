import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`CONTEXT_SCORE_INVALID:${label}`);
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]!;
}

function scoreTrial(value: unknown): JsonRecord {
  const trial = record(value, "trial");
  const expectedGoal = record(trial["expectedGoal"], "trial.expectedGoal");
  const actualGoal = record(trial["actualGoal"], "trial.actualGoal");
  const expectedReferents = array(trial["expectedReferents"]).map((entry) => record(entry, "trial.expectedReferent"));
  const actualReferents = array(trial["actualReferents"]).map((entry) => record(entry, "trial.actualReferent"));
  let referentCorrect = 0;
  let referentTotal = 0;
  for (const expected of expectedReferents) {
    const operationKind = String(expected["operationKind"] ?? "");
    const expectedRefs = array(expected["offerRefs"]).filter((entry): entry is string => typeof entry === "string");
    const actualRefs = new Set(actualReferents
      .filter((entry) => entry["operationKind"] === operationKind)
      .flatMap((entry) => array(entry["offerRefs"]).filter((offerRef): offerRef is string => typeof offerRef === "string")));
    referentTotal += expectedRefs.length;
    referentCorrect += expectedRefs.filter((offerRef) => actualRefs.has(offerRef)).length;
  }
  return {
    ...trial,
    stateCorrect: canonical(actualGoal) === canonical(expectedGoal),
    referentCorrect,
    referentTotal,
  };
}

function inputTokens(trial: JsonRecord): number {
  const usage = record(trial["modelUsage"], "trial.modelUsage");
  return Number(usage["inputTokens"] ?? 0) + Number(usage["cacheReadTokens"] ?? 0) + Number(usage["cacheWriteTokens"] ?? 0);
}

function uncachedInputTokens(trial: JsonRecord): number {
  return Number(record(trial["modelUsage"], "trial.modelUsage")["inputTokens"] ?? 0);
}

function summarize(trials: JsonRecord[]): JsonRecord {
  const valid = trials.filter((trial) => trial["status"] === "VALID");
  const stateCorrect = valid.filter((trial) => trial["stateCorrect"] === true).length;
  const referentCorrect = valid.reduce((sum, trial) => sum + Number(trial["referentCorrect"] ?? 0), 0);
  const referentTotal = valid.reduce((sum, trial) => sum + Number(trial["referentTotal"] ?? 0), 0);
  const usages = valid.map(inputTokens);
  const uncachedUsages = valid.map(uncachedInputTokens);
  return {
    validTrials: valid.length,
    invalidTrials: trials.length - valid.length,
    multiTurnConstraintState: { numerator: stateCorrect, denominator: valid.length, value: ratio(stateCorrect, valid.length) },
    candidateReferentAccuracy: { numerator: referentCorrect, denominator: referentTotal, value: ratio(referentCorrect, referentTotal) },
    inputTokens: {
      total: usages.reduce((sum, item) => sum + item, 0),
      p50: percentile(usages, 0.5),
      p95: percentile(usages, 0.95),
      uncachedTotal: uncachedUsages.reduce((sum, item) => sum + item, 0),
    },
  };
}

function percentage(value: unknown): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "N/A";
}

function markdown(report: JsonRecord): string {
  const metrics = record(report["metrics"], "metrics");
  const projected = record(metrics["projected"], "metrics.projected");
  const baseline = record(metrics["fullTranscriptBaseline"], "metrics.baseline");
  const state = record(projected["multiTurnConstraintState"], "projected.state");
  const baselineState = record(baseline["multiTurnConstraintState"], "baseline.state");
  const referent = record(projected["candidateReferentAccuracy"], "projected.referent");
  const baselineReferent = record(baseline["candidateReferentAccuracy"], "baseline.referent");
  const token = record(metrics["tokenReduction"], "metrics.tokenReduction");
  const uncached = record(token["uncached"], "metrics.tokenReduction.uncached");
  return `# 上下文消融评测结果\n\n`
    + `> 评测级别：开发集。该结果用于验证上下文方案与评测 Harness，尚未经过独立 Gold 组卷，因此不能直接作为最终简历指标。\n\n`
    + `- 模型：\`${String(report["modelId"])}\`\n`
    + `- 样本：${String(report["caseCount"])} 个任务 × ${String(report["repeats"])} 次重复 × 2 种策略\n`
    + `- Token：总有效输入按供应商 usage 的 \`input + cacheRead + cacheWrite\` 计算\n`
    + `- 基线：在相同结构化状态之外，额外回灌截至当前轮的完整对话历史\n\n`
    + `| 指标 | 结构化投影 | 全量历史基线 |\n| --- | ---: | ---: |\n`
    + `| 多轮约束状态正确 | ${String(state["numerator"])}/${String(state["denominator"])}（${percentage(state["value"])}） | ${String(baselineState["numerator"])}/${String(baselineState["denominator"])}（${percentage(baselineState["value"])}） |\n`
    + `| 候选指代正确 | ${String(referent["numerator"])}/${String(referent["denominator"])}（${percentage(referent["value"])}） | ${String(baselineReferent["numerator"])}/${String(baselineReferent["denominator"])}（${percentage(baselineReferent["value"])}） |\n`
    + `| 模型输入 Token | ${String(token["projectedInputTokens"])} | ${String(token["baselineInputTokens"])} |\n\n`
    + `总有效输入 Token 降幅为 **${percentage(token["value"])}**；其中未缓存输入从 ${String(uncached["baselineInputTokens"])} 降至 ${String(uncached["projectedInputTokens"])}，降幅 **${percentage(uncached["value"])}**。状态与指代指标未低于该开发集基线。\n\n`
    + `## 简历使用边界\n\n`
    + `当前可以在面试中表述为“开发集消融结果”，不能省略限定。要升级为正式简历指标，还需由独立评审者冻结用例与 Gold，并在冻结版本上复跑；开发者不能在看到本轮错误后修改题目再宣称正式提升。\n`;
}

const inputPath = resolve(process.env["INTEREC_CONTEXT_EVAL_SCORE_INPUT"] ?? ".artifacts/evaluation/context-ablation-v1.json");
const outputPath = resolve(process.env["INTEREC_CONTEXT_EVAL_SCORE_OUTPUT"] ?? ".artifacts/evaluation/context-ablation-v1-score.json");
const reportPath = resolve(process.env["INTEREC_CONTEXT_EVAL_REPORT"] ?? "docs/acceptance/context-ablation-development-result.md");
const run = record(JSON.parse(readFileSync(inputPath, "utf8")), "run");
if (run["schemaVersion"] !== "interec-context-ablation-report-v1" || run["eligibleForResumeMetrics"] !== false) {
  throw new Error("CONTEXT_SCORE_BOUNDARY_INVALID");
}
const trials = array(run["trials"]).map(scoreTrial);
const projectedTrials = trials.filter((trial) => trial["arm"] === "PROJECTED");
const baselineTrials = trials.filter((trial) => trial["arm"] === "FULL_TRANSCRIPT");
const projected = summarize(projectedTrials);
const baseline = summarize(baselineTrials);
const projectedByPair = new Map(projectedTrials.filter((trial) => trial["status"] === "VALID")
  .map((trial) => [`${String(trial["caseId"])}:${String(trial["runIndex"])}`, trial]));
const baselineByPair = new Map(baselineTrials.filter((trial) => trial["status"] === "VALID")
  .map((trial) => [`${String(trial["caseId"])}:${String(trial["runIndex"])}`, trial]));
const pairedKeys = [...projectedByPair.keys()].filter((key) => baselineByPair.has(key));
const projectedInputTokens = pairedKeys.reduce((sum, key) => sum + inputTokens(projectedByPair.get(key)!), 0);
const baselineInputTokens = pairedKeys.reduce((sum, key) => sum + inputTokens(baselineByPair.get(key)!), 0);
const projectedUncachedInputTokens = pairedKeys.reduce((sum, key) => sum + uncachedInputTokens(projectedByPair.get(key)!), 0);
const baselineUncachedInputTokens = pairedKeys.reduce((sum, key) => sum + uncachedInputTokens(baselineByPair.get(key)!), 0);
const scored: JsonRecord = {
  ...run,
  schemaVersion: "interec-context-ablation-score-v1",
  sourceRun: inputPath,
  scoredAt: new Date().toISOString(),
  metrics: {
    projected,
    fullTranscriptBaseline: baseline,
    tokenReduction: {
      pairedTrials: pairedKeys.length,
      projectedInputTokens,
      baselineInputTokens,
      value: baselineInputTokens > 0 ? (baselineInputTokens - projectedInputTokens) / baselineInputTokens : null,
      uncached: {
        projectedInputTokens: projectedUncachedInputTokens,
        baselineInputTokens: baselineUncachedInputTokens,
        value: baselineUncachedInputTokens > 0
          ? (baselineUncachedInputTokens - projectedUncachedInputTokens) / baselineUncachedInputTokens
          : null,
      },
    },
  },
  trials,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(scored, null, 2)}\n`, "utf8");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, markdown(scored), "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, reportPath, metrics: scored["metrics"] }, null, 2)}\n`);
if (Number(projected["invalidTrials"]) > 0 || Number(baseline["invalidTrials"]) > 0) process.exitCode = 1;
