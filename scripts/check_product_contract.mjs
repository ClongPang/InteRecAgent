import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "spec/conversational-agent-product-contract.json");
const contract = JSON.parse(await readFile(path, "utf8"));
const failures = [];

if (contract.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (contract.conversationBoundary !== "SHOPPING_MISSION") failures.push("conversation boundary must be SHOPPING_MISSION");
if (contract.turnBoundary !== "DURABLE_EXECUTION") failures.push("turn boundary must be DURABLE_EXECUTION");

const invariants = Array.isArray(contract.invariants) ? contract.invariants : [];
const invariantIds = invariants.map((item) => item.id);
if (invariants.length < 12) failures.push("at least 12 product invariants are required");
if (new Set(invariantIds).size !== invariantIds.length) failures.push("product invariant ids must be unique");

const trajectories = Array.isArray(contract.trajectories) ? contract.trajectories : [];
const trajectoryIds = trajectories.map((item) => item.id);
if (trajectories.length < 12) failures.push("at least 12 approved multi-turn trajectories are required");
if (new Set(trajectoryIds).size !== trajectoryIds.length) failures.push("trajectory ids must be unique");

const observedRoutes = new Set();
const observedCapabilities = new Set();
for (const trajectory of trajectories) {
  const turns = Array.isArray(trajectory.turns) ? trajectory.turns : [];
  if (turns.length < 2) failures.push(`${trajectory.id}: must contain at least two user turns`);
  for (const capability of trajectory.capabilities ?? []) observedCapabilities.add(capability);
  for (const [index, turn] of turns.entries()) {
    const expected = turn.expected ?? {};
    if (typeof turn.user !== "string" || !turn.user.trim()) failures.push(`${trajectory.id}[${index}]: user text is required`);
    if (typeof expected.route !== "string") failures.push(`${trajectory.id}[${index}]: expected route is required`);
    else observedRoutes.add(expected.route);
    if (!Array.isArray(expected.operations) || expected.operations.length === 0) failures.push(`${trajectory.id}[${index}]: expected operations are required`);
    if (!Number.isInteger(expected.providerCalls) || expected.providerCalls < 0) failures.push(`${trajectory.id}[${index}]: providerCalls must be a non-negative integer`);
    if (typeof expected.outcome !== "string") failures.push(`${trajectory.id}[${index}]: expected outcome is required`);
    if (!Array.isArray(expected.assertions) || expected.assertions.length === 0) failures.push(`${trajectory.id}[${index}]: assertions are required`);
  }
}

for (const route of contract.requiredRoutes ?? []) {
  if (!observedRoutes.has(route)) failures.push(`required route is not covered: ${route}`);
}
for (const capability of contract.requiredCapabilities ?? []) {
  if (!observedCapabilities.has(capability)) failures.push(`required capability is not covered: ${capability}`);
}

const zeroProviderTurns = trajectories.flatMap((item) => item.turns ?? []).filter((turn) => turn.expected?.providerCalls === 0).length;
if (zeroProviderTurns < 8) failures.push("at least eight turns must prove a zero-provider path");

if (failures.length > 0) {
  throw new Error(`PRODUCT_CONTRACT_INVALID\n${failures.map((item) => `- ${item}`).join("\n")}`);
}

process.stdout.write(`product contract: ${invariants.length} invariants, ${trajectories.length} multi-turn trajectories, ${zeroProviderTurns} zero-provider turns\n`);
