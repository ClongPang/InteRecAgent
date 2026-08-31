import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(await readFile(resolve(root, "spec/evaluation/browser-shopping-boundary-v1/cases.json"), "utf8"));
const developmentCases = JSON.parse(await readFile(resolve(root, "spec/evaluation/gold-v1/development-evaluation-cases.json"), "utf8"));
if (registry.schemaVersion !== 2 || registry.suiteId !== "shopping-boundary-traceability-v2") {
  throw new Error("SHOPPING_BOUNDARY_TRACEABILITY_SCHEMA_INVALID");
}
if (!Array.isArray(registry.cases) || registry.cases.length === 0) throw new Error("SHOPPING_BOUNDARY_TRACEABILITY_EMPTY");
const developmentById = new Map(developmentCases.cases.map((entry) => [entry.taskId, entry]));
const ids = new Set();
let gateCount = 0;
for (const entry of registry.cases) {
  if (typeof entry.id !== "string" || ids.has(entry.id)) throw new Error(`SHOPPING_BOUNDARY_CASE_ID_INVALID:${entry.id}`);
  ids.add(entry.id);
  if (!Array.isArray(entry.executionGates) || entry.executionGates.length === 0) {
    throw new Error(`SHOPPING_BOUNDARY_EXECUTION_GATE_MISSING:${entry.id}`);
  }
  for (const gate of entry.executionGates) {
    gateCount += 1;
    if (gate.kind === "DEVELOPMENT_EVALUATION") {
      const testCase = developmentById.get(gate.taskId);
      if (!testCase?.turnExpectations?.length) throw new Error(`SHOPPING_BOUNDARY_DEVELOPMENT_GATE_INVALID:${entry.id}:${gate.taskId}`);
      continue;
    }
    if (gate.kind === "VITEST") {
      const path = resolve(root, gate.file ?? "");
      await access(path);
      const source = await readFile(path, "utf8");
      if (typeof gate.testName !== "string" || !source.includes(`it(\"${gate.testName}\"`)) {
        throw new Error(`SHOPPING_BOUNDARY_VITEST_GATE_INVALID:${entry.id}:${gate.file}:${gate.testName}`);
      }
      continue;
    }
    throw new Error(`SHOPPING_BOUNDARY_GATE_KIND_INVALID:${entry.id}:${gate.kind}`);
  }
}
process.stdout.write(`shopping boundary traceability: ${registry.cases.length} risks, ${gateCount} executable gates\n`);
