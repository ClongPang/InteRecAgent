import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateFaultAcceptance, parseFaultManifest, parseFaultObservations } from "./fault-acceptance-evaluator.js";

const manifestPath = process.env["INTEREC_FAULT_MANIFEST_PATH"]?.trim();
const observationsPath = process.env["INTEREC_FAULT_OBSERVATIONS_PATH"]?.trim();
if (!manifestPath || !observationsPath) throw new Error("INTEREC_FAULT_ACCEPTANCE_PATHS_REQUIRED");
const [manifestJson, observationsJson] = await Promise.all([
  readFile(resolve(manifestPath), "utf8"),
  readFile(resolve(observationsPath), "utf8"),
]);
const report = evaluateFaultAcceptance(
  parseFaultManifest(JSON.parse(manifestJson)),
  parseFaultObservations(JSON.parse(observationsJson)),
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
