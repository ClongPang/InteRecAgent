import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseGoldBlueprint, validateGoldBlueprint } from "./gold-blueprint.js";

const blueprintPath = resolve(process.env["INTEREC_GOLD_BLUEPRINT_PATH"] ?? "spec/evaluation/gold-v1/authoring-blueprint.json");
const contractPath = resolve(process.env["INTEREC_PRODUCT_CONTRACT_PATH"] ?? "spec/conversational-agent-product-contract.json");
const lockPath = resolve(process.env["INTEREC_GOLD_BLUEPRINT_LOCK_PATH"] ?? "spec/evaluation/gold-v1/authoring-blueprint.lock.json");

const blueprint = parseGoldBlueprint(JSON.parse(readFileSync(blueprintPath, "utf8")));
const contractRaw = JSON.parse(readFileSync(contractPath, "utf8")) as { requiredCapabilities?: unknown; invariants?: unknown };
const requiredCapabilities = Array.isArray(contractRaw.requiredCapabilities) ? contractRaw.requiredCapabilities.filter((item): item is string => typeof item === "string") : [];
const invariantIds = Array.isArray(contractRaw.invariants)
  ? contractRaw.invariants.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : [])
  : [];
const summary = validateGoldBlueprint(blueprint, { requiredCapabilities, invariantIds });
const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { schemaVersion?: unknown; blueprintVersion?: unknown; semanticSha256?: unknown };
if (lock.schemaVersion !== "interec-gold-blueprint-lock-v1") throw new Error("BLUEPRINT_LOCK_SCHEMA_INVALID");
if (lock.blueprintVersion !== blueprint.blueprintVersion) throw new Error("BLUEPRINT_LOCK_VERSION_MISMATCH");
if (lock.semanticSha256 !== summary.semanticSha256) throw new Error(`BLUEPRINT_SEMANTIC_DRIFT:${String(lock.semanticSha256)}:${summary.semanticSha256}`);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
