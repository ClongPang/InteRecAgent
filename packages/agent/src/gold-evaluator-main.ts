import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateGoldResults, parseGoldResults } from "./gold-evaluator.js";

const path = process.env["INTEREC_GOLD_RESULTS_PATH"]?.trim();
if (!path) throw new Error("INTEREC_GOLD_RESULTS_PATH_REQUIRED");
const implementationVersion = process.env["INTEREC_EXPECTED_RELEASE"]?.trim();
const modelId = process.env["INTEREC_EXPECTED_MODEL_ID"]?.trim();
if (!implementationVersion) throw new Error("INTEREC_EXPECTED_RELEASE_REQUIRED");
if (!modelId) throw new Error("INTEREC_EXPECTED_MODEL_ID_REQUIRED");
const records = parseGoldResults(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
const report = evaluateGoldResults(records, { implementationVersion, modelId });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
