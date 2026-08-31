import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compareEvaluationReports, parseEvaluationReport, type RegressionPolicy } from "./evaluation-regression.js";

const baselinePath = process.env["INTEREC_EVAL_BASELINE_REPORT_PATH"]?.trim();
const currentPath = process.env["INTEREC_EVAL_CURRENT_REPORT_PATH"]?.trim();
if (!baselinePath || !currentPath) throw new Error("INTEREC_EVAL_EVAL_REGRESSION_REPORT_PATHS_REQUIRED");

const [baselineJson, currentJson] = await Promise.all([
  readFile(resolve(baselinePath), "utf8"),
  readFile(resolve(currentPath), "utf8"),
]);
const policy: RegressionPolicy = process.env["INTEREC_EVAL_EVAL_REGRESSION_POLICY_JSON"]
  ? JSON.parse(process.env["INTEREC_EVAL_EVAL_REGRESSION_POLICY_JSON"])
  : {};
const report = compareEvaluationReports(
  parseEvaluationReport(JSON.parse(baselineJson)),
  parseEvaluationReport(JSON.parse(currentJson)),
  policy,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
