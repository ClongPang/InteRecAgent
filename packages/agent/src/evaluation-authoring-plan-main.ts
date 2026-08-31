import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseEvaluationAuthoringPlan, validateEvaluationAuthoringPlan } from "./evaluation-authoring-plan.js";

const planPath = resolve(process.env["INTEREC_EVALUATION_PLAN_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.json");
const contractPath = resolve(process.env["INTEREC_PRODUCT_CONTRACT_PATH"] ?? "spec/conversational-agent-product-contract.json");
const lockPath = resolve(process.env["INTEREC_EVALUATION_PLAN_LOCK_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.lock.json");

const plan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync(planPath, "utf8")));
const contractRaw = JSON.parse(readFileSync(contractPath, "utf8")) as { requiredCapabilities?: unknown; invariants?: unknown };
const requiredCapabilities = Array.isArray(contractRaw.requiredCapabilities) ? contractRaw.requiredCapabilities.filter((item): item is string => typeof item === "string") : [];
const invariantIds = Array.isArray(contractRaw.invariants)
  ? contractRaw.invariants.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : [])
  : [];
const summary = validateEvaluationAuthoringPlan(plan, { requiredCapabilities, invariantIds });
const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { schemaVersion?: unknown; planVersion?: unknown; semanticSha256?: unknown };
if (lock.schemaVersion !== "interec-evaluation-authoring-plan-lock-v1") throw new Error("EVALUATION_PLAN_LOCK_SCHEMA_INVALID");
if (lock.planVersion !== plan.planVersion) throw new Error("EVALUATION_PLAN_LOCK_VERSION_MISMATCH");
if (lock.semanticSha256 !== summary.semanticSha256) throw new Error(`EVALUATION_PLAN_SEMANTIC_DRIFT:${String(lock.semanticSha256)}:${summary.semanticSha256}`);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
