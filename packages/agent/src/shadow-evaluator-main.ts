import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateShadowResults, parseShadowPolicy, parseShadowResults } from "./shadow-evaluator.js";

const resultsPath = process.env["INTEREC_SHADOW_RESULTS_PATH"]?.trim();
const policyPath = process.env["INTEREC_SHADOW_POLICY_PATH"]?.trim();
if (!resultsPath) throw new Error("INTEREC_SHADOW_RESULTS_PATH_REQUIRED");
if (!policyPath) throw new Error("INTEREC_SHADOW_POLICY_PATH_REQUIRED");
const implementationVersion = process.env["INTEREC_EXPECTED_RELEASE"]?.trim();
const modelId = process.env["INTEREC_EXPECTED_MODEL_ID"]?.trim();
if (!implementationVersion) throw new Error("INTEREC_EXPECTED_RELEASE_REQUIRED");
if (!modelId) throw new Error("INTEREC_EXPECTED_MODEL_ID_REQUIRED");
const [resultsJson, policyJson] = await Promise.all([
  readFile(resolve(resultsPath), "utf8"),
  readFile(resolve(policyPath), "utf8"),
]);
const report = evaluateShadowResults(
  parseShadowResults(JSON.parse(resultsJson) as unknown),
  parseShadowPolicy(JSON.parse(policyJson) as unknown),
  { implementationVersion, modelId },
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
