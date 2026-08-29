import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createDevelopmentFaultManifest } from "./fault-acceptance-evaluator.js";

const outputPath = resolve(process.env["INTEREC_FAULT_MANIFEST_PATH"] ?? ".artifacts/evaluation/fault-manifest.json");
const manifest = createDevelopmentFaultManifest(
  process.env["INTEREC_EXPECTED_RELEASE"]?.trim() || "development",
  process.env["INTEREC_DATABASE_SCHEMA_VERSION"]?.trim() || "conversation-schema-v1",
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, rows: manifest.rows.length, mode: manifest.mode })}\n`);
