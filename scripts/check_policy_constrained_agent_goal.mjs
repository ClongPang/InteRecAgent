import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goalPath = resolve(root, "spec/policy-constrained-agent-goal.json");
const goal = JSON.parse(await readFile(goalPath, "utf8"));
const failures = [];

const expectedPhases = [
  "P0_LOCK_AND_CHARACTERIZE",
  "P1_TYPED_PLAN_REVIEW",
  "P2_ESCI_CANDIDATE_ADMISSION",
  "P3_UNCERTAINTY_AND_ANSWERABILITY",
  "P4_DELETE_OLD_SEMANTIC_FALLBACKS",
  "P5_LIVE_ACCEPTANCE_AND_CUTOVER",
];
if (goal.goalId !== "policy-constrained-pi-agent-planning-v1") failures.push("unexpected goalId");
if (JSON.stringify(goal.phaseOrder) !== JSON.stringify(expectedPhases)) failures.push("phase order drifted");

const requiredInvariants = [
  "PI_AGENT_OWNS_NATURAL_LANGUAGE_PLANNING",
  "POLICY_APPROVES_WITHOUT_SILENT_SEMANTIC_REWRITE",
  "ONLY_APPROVED_PLANS_EXECUTE",
  "KNOWN_FIELDS_SURVIVE_CLARIFICATION",
  "SYSTEM_FAILURE_IS_NOT_USER_AMBIGUITY",
  "MISSING_EVIDENCE_IS_NOT_USER_AMBIGUITY",
  "ESCI_ADMISSION_PRECEDES_RANKING",
  "SINGLE_WRITABLE_PRODUCTION_PATH",
  "NO_BAD_CASE_CONTROL_FLOW",
  "NO_GENERIC_POLICY_DSL",
];
const invariantIds = new Set((goal.invariants ?? []).map((item) => item.id));
for (const id of requiredInvariants) if (!invariantIds.has(id)) failures.push(`missing invariant ${id}`);

const expectedEsci = {
  EXACT: "MAIN_RECOMMENDATION",
  SUBSTITUTE: "ALTERNATIVE_COHORT",
  COMPLEMENT: "RELATED_COHORT",
  IRRELEVANT: "INELIGIBLE",
  UNRESOLVED: "INSUFFICIENT_EVIDENCE",
};
if (JSON.stringify(goal.esciAdmission) !== JSON.stringify(expectedEsci)) failures.push("ESCI admission mapping drifted");
if (goal.uncertaintyOwnership?.SYSTEM_FAILURE !== "RETRY_OR_DEGRADE") failures.push("system failure ownership drifted");
if (goal.uncertaintyOwnership?.MISSING_EVIDENCE !== "DISCLOSE_OR_RETRIEVE") failures.push("missing-evidence ownership drifted");

const [adr, plan, productContract, packageJsonSource] = await Promise.all([
  readFile(resolve(root, "docs/adr/0005-policy-constrained-pi-agent-planning.md"), "utf8"),
  readFile(resolve(root, "docs/policy-constrained-agent-implementation-plan.md"), "utf8"),
  readFile(resolve(root, "spec/conversational-agent-product-contract.json"), "utf8"),
  readFile(resolve(root, "package.json"), "utf8"),
]);
for (const required of [
  "policy-constrained agent planning",
  "APPROVED",
  "REPAIR_REQUIRED",
  "REJECTED",
  "ESCI",
  "SYSTEM_FAILURE",
]) {
  if (!adr.includes(required)) failures.push(`ADR missing ${required}`);
}
for (const required of [
  "Pi-Agent 是否仍在规划每个自然语言话轮",
  "不允许双写",
  "删除静默语义改写与旧 fallback",
  "turn_plan_reviews",
]) {
  if (!plan.includes(required)) failures.push(`implementation plan missing ${required}`);
}
if (!productContract.includes('"id": "pi_agent_orchestrates_turn"')) failures.push("existing Pi-Agent planning product invariant was removed");
const packageJson = JSON.parse(packageJsonSource);
if (packageJson.scripts?.["architecture:policy-route:check"] !== "node scripts/check_policy_constrained_agent_goal.mjs") {
  failures.push("package.json is missing architecture:policy-route:check");
}

if (failures.length > 0) {
  throw new Error(`POLICY_CONSTRAINED_AGENT_GOAL_DRIFT\n${failures.map((item) => `- ${item}`).join("\n")}`);
}

process.stdout.write(`policy-constrained Pi-Agent route locked: ${expectedPhases.join(" -> ")}; ${goal.invariants.length} invariants\n`);
