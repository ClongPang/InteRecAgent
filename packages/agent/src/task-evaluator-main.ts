import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { evaluateTaskTrials, parseEvaluationManifest, parseEvaluationTrials } from "./task-evaluator.js";

const manifestPath = resolve(process.env["INTEREC_EVAL_MANIFEST_PATH"] ?? "spec/evaluation/dev/manifest.json");
const trialsPath = resolve(process.env["INTEREC_EVAL_TRIALS_PATH"] ?? "spec/evaluation/dev/trials.json");
const reportPath = process.env["INTEREC_EVAL_REPORT_PATH"]?.trim();

const [manifestJson, trialsJson] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(trialsPath, "utf8"),
]);
const manifest = parseEvaluationManifest(JSON.parse(manifestJson));
const trials = parseEvaluationTrials(JSON.parse(trialsJson));
const report = evaluateTaskTrials(manifest, trials);
const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (reportPath) {
  const resolvedReportPath = resolve(reportPath);
  await mkdir(dirname(resolvedReportPath), { recursive: true });
  await writeFile(resolvedReportPath, serialized, "utf8");
}

process.stdout.write(serialized);
if (!report.passed) process.exitCode = 1;
