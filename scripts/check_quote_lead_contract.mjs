import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "spec/quote-lead-product-contract.json");
const contract = JSON.parse(await readFile(contractPath, "utf8"));
const failures = [];

if (contract.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (contract.contractVersion !== "quote-leads-sg-v1") failures.push("contractVersion must be quote-leads-sg-v1");
if (contract.serviceMarket !== "SG") failures.push("serviceMarket must be SG");
if (contract.conversationBoundary !== "QUOTE_LOOKUP_MISSION") failures.push("conversationBoundary must be QUOTE_LOOKUP_MISSION");
if (contract.turnBoundary !== "DURABLE_EXECUTION") failures.push("turnBoundary must remain DURABLE_EXECUTION");

const providerPolicy = contract.providerPolicy ?? {};
if (providerPolicy.primaryTool !== "find_best_price_v2") failures.push("primaryTool must be find_best_price_v2");
if (providerPolicy.detailTool !== "get_product_v2") failures.push("detailTool must be get_product_v2");
if (providerPolicy.internalDeliverTo !== "SG") failures.push("internalDeliverTo must be SG");
if (!Array.isArray(providerPolicy.automaticFallbacks) || providerPolicy.automaticFallbacks.length !== 0) {
  failures.push("automaticFallbacks must remain empty");
}
if (!Array.isArray(providerPolicy.userVisibleSearchModes) || providerPolicy.userVisibleSearchModes.length !== 0) {
  failures.push("userVisibleSearchModes must remain empty");
}

const exactSet = (actual, expected, label) => {
  if (!Array.isArray(actual)) {
    failures.push(`${label} must be an array`);
    return;
  }
  const normalized = [...new Set(actual)].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(wanted)) {
    failures.push(`${label} must equal ${wanted.join(",")}`);
  }
};

exactSet(contract.assistantOutcomes, ["CHAT", "CLARIFICATION", "QUOTE_LEADS", "NO_QUOTE_LEADS", "DEGRADED"], "assistantOutcomes");
exactSet(contract.requiredRoutes, ["talk", "clarify", "lookup"], "requiredRoutes");

const forbiddenClaims = new Set(contract.forbiddenUserClaims ?? []);
for (const claim of [
  "RECOMMENDATION",
  "SEARCH_RESULTS",
  "GLOBAL_LOWEST_PRICE",
  "CURRENTLY_IN_STOCK",
  "DELIVERY_VERIFIED",
  "PURCHASE_VERIFIED",
]) {
  if (!forbiddenClaims.has(claim)) failures.push(`missing forbidden user claim: ${claim}`);
}

const invariants = Array.isArray(contract.invariants) ? contract.invariants : [];
const invariantIds = invariants.map((item) => item?.id);
if (invariants.length < 18) failures.push("at least 18 quote-lead invariants are required");
if (new Set(invariantIds).size !== invariantIds.length) failures.push("invariant ids must be unique");
for (const [index, invariant] of invariants.entries()) {
  if (typeof invariant?.id !== "string" || !invariant.id.trim()) failures.push(`invariants[${index}].id is required`);
  if (typeof invariant?.statement !== "string" || !invariant.statement.trim()) failures.push(`invariants[${index}].statement is required`);
}

const requiredCapabilities = Array.isArray(contract.requiredCapabilities) ? contract.requiredCapabilities : [];
if (new Set(requiredCapabilities).size !== requiredCapabilities.length) failures.push("requiredCapabilities must be unique");

const trajectories = Array.isArray(contract.trajectories) ? contract.trajectories : [];
const trajectoryIds = trajectories.map((item) => item?.id);
if (trajectories.length < 10) failures.push("at least 10 multi-turn trajectories are required");
if (new Set(trajectoryIds).size !== trajectoryIds.length) failures.push("trajectory ids must be unique");

const observedCapabilities = new Set();
const observedRoutes = new Set();
const observedOutcomes = new Set();
let zeroProviderTurns = 0;
let providerTurns = 0;
for (const [trajectoryIndex, trajectory] of trajectories.entries()) {
  const path = `trajectories[${trajectoryIndex}]`;
  if (typeof trajectory?.id !== "string" || !trajectory.id.trim()) failures.push(`${path}.id is required`);
  for (const capability of trajectory?.capabilities ?? []) observedCapabilities.add(capability);
  const turns = Array.isArray(trajectory?.turns) ? trajectory.turns : [];
  if (turns.length < 2) failures.push(`${path} must contain at least two turns`);
  for (const [turnIndex, turn] of turns.entries()) {
    const turnPath = `${path}.turns[${turnIndex}]`;
    const expected = turn?.expected ?? {};
    if (typeof turn?.user !== "string" || !turn.user.trim()) failures.push(`${turnPath}.user is required`);
    if (typeof expected.route !== "string") failures.push(`${turnPath}.expected.route is required`);
    else observedRoutes.add(expected.route);
    if (!Array.isArray(expected.operations) || expected.operations.length === 0) failures.push(`${turnPath}.expected.operations are required`);
    if (!Number.isInteger(expected.providerCalls) || expected.providerCalls < 0) {
      failures.push(`${turnPath}.expected.providerCalls must be a non-negative integer`);
    } else if (expected.providerCalls === 0) zeroProviderTurns += 1;
    else providerTurns += 1;
    if (typeof expected.outcome !== "string") failures.push(`${turnPath}.expected.outcome is required`);
    else observedOutcomes.add(expected.outcome);
    if (!Array.isArray(expected.assertions) || expected.assertions.length < 2) {
      failures.push(`${turnPath}.expected.assertions must contain at least two assertions`);
    }
  }
}

for (const capability of requiredCapabilities) {
  if (!observedCapabilities.has(capability)) failures.push(`required capability is not covered: ${capability}`);
}
for (const route of contract.requiredRoutes ?? []) {
  if (!observedRoutes.has(route)) failures.push(`required route is not covered: ${route}`);
}
for (const outcome of contract.assistantOutcomes ?? []) {
  if (outcome !== "CHAT" && !observedOutcomes.has(outcome)) failures.push(`non-chat outcome is not covered: ${outcome}`);
}
if (zeroProviderTurns < 8) failures.push("at least eight zero-provider turns are required");
if (providerTurns < 8) failures.push("at least eight provider turns are required");

if (failures.length > 0) {
  throw new Error(`QUOTE_LEAD_PRODUCT_CONTRACT_INVALID\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

process.stdout.write(
  `quote-lead contract: ${invariants.length} invariants, ${trajectories.length} trajectories, ${zeroProviderTurns} zero-provider turns, ${providerTurns} provider turns\n`,
);
