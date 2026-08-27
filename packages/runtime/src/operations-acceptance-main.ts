import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  evaluateOperationsAcceptance,
  parseOperationsAcceptanceEvidence,
  parseOperationsAcceptancePolicy,
} from "./operations-acceptance-evaluator.js";

const evidencePath = process.env["INTEREC_OPERATIONS_EVIDENCE_PATH"]?.trim();
if (!evidencePath) throw new Error("INTEREC_OPERATIONS_EVIDENCE_PATH_REQUIRED");
const implementationVersion = process.env["INTEREC_EXPECTED_RELEASE"]?.trim();
const environment = process.env["INTEREC_EXPECTED_ENVIRONMENT"]?.trim();
if (!implementationVersion) throw new Error("INTEREC_EXPECTED_RELEASE_REQUIRED");
if (!environment) throw new Error("INTEREC_EXPECTED_ENVIRONMENT_REQUIRED");
const [evidenceJson, policyJson] = await Promise.all([
  readFile(resolve(evidencePath), "utf8"),
  readFile(resolve("spec/observability/operations-acceptance-policy.json"), "utf8"),
]);
const report = evaluateOperationsAcceptance(
  parseOperationsAcceptanceEvidence(JSON.parse(evidenceJson) as unknown),
  parseOperationsAcceptancePolicy(JSON.parse(policyJson) as unknown),
  { implementationVersion, environment },
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
