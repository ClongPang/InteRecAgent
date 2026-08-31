import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "spec/clarification-architecture-goal.json");
const contract = JSON.parse(await readFile(contractPath, "utf8"));
const failures = [];

const expectedOrder = [
  "P0_STOP_THE_BLEEDING",
  "P1_TYPED_PROTOCOL",
  "P2_DECISION_POLICY",
  "P3_STRUCTURED_INTERACTION",
];
const requiredInvariants = [
  "PURCHASE_MARKET_IS_RETRIEVAL_CONTEXT",
  "POLICY_OWNS_ASK_DECISION",
  "SERVER_OWNS_AUTHORITATIVE_OPTIONS",
  "UNKNOWN_PROTOCOL_FAILS_CLOSED",
  "SKIP_DOES_NOT_LOOP",
  "NO_GENERIC_BUSINESS_FALLBACK",
  "NO_GENERIC_FORM_DSL",
];

if (contract.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (JSON.stringify(contract.phaseOrder) !== JSON.stringify(expectedOrder)) failures.push("phase order drifted from P0 -> P1 -> P2 -> P3");
const invariantIds = (contract.invariants ?? []).map((item) => item.id);
for (const id of requiredInvariants) if (!invariantIds.includes(id)) failures.push(`missing invariant: ${id}`);
if (new Set(invariantIds).size !== invariantIds.length) failures.push("invariant ids must be unique");
for (const phase of expectedOrder) {
  if (!Array.isArray(contract.phaseGates?.[phase]) || contract.phaseGates[phase].length === 0) failures.push(`missing phase gate: ${phase}`);
}

const dialogueSource = await readFile(resolve(root, "packages/domain/src/dialogue-state.ts"), "utf8");
const clarificationSource = await readFile(resolve(root, "packages/domain/src/clarification.ts"), "utf8");
const conversationTypes = await readFile(resolve(root, "packages/domain/src/conversation-types.ts"), "utf8");
const schemas = await readFile(resolve(root, "packages/agent/src/schemas.ts"), "utf8");
const decisionPolicy = await readFile(resolve(root, "packages/domain/src/clarification-decision-policy.ts"), "utf8");
const conversationPolicy = await readFile(resolve(root, "packages/domain/src/conversation-policy.ts"), "utf8");
const apiSource = await readFile(resolve(root, "packages/api/src/app.ts"), "utf8");
const frontendSource = await readFile(resolve(root, "frontend/src/App.tsx"), "utf8");
if (`${dialogueSource}\n${clarificationSource}`.includes('return "请再补充一个关键选购条件。"')) failures.push("generic business fallback is still executable");
if (!clarificationSource.includes('"retrieval_markets", "retrieval_market", "market"')) failures.push("historical retrieval_markets value is not covered by the sole registry");
if (!/kind:\s*"REQUEST_CLARIFICATION";\s*clarification:\s*ClarificationIntent;/u.test(conversationTypes)) failures.push("REQUEST_CLARIFICATION is not internally typed");
if (/kind: "REQUEST_CLARIFICATION"; slotId: string/.test(conversationTypes)) failures.push("free-string clarification remains in the internal TurnOperation type");
if (!schemas.includes('clarification: Type.Object')) failures.push("model schema does not expose the typed clarification protocol");
for (const mode of ["ASK_BLOCKING", "ASK_OPTIONAL", "ASSUME_AND_DISCLOSE", "SEARCH_THEN_REFINE", "SKIP"]) {
  if (!decisionPolicy.includes(`"${mode}"`)) failures.push(`clarification decision mode is missing: ${mode}`);
}
for (const token of [
  "marketScope",
  'Type.Literal("US")',
  'Type.Literal("SG")',
  "assumptionDisclosureCodes",
  'Type.Literal("PURCHASE_MARKET_SCOPE_ASSUMED")',
]) {
  if (!schemas.includes(token)) failures.push(`bounded Agent-owned search assumption is missing: ${token}`);
}
for (const token of [
  "skippedPurchaseMarket",
  "EXPLORATORY_MARKET_SCOPE_NOT_AUTHORIZED",
  "EXPLORATORY_MARKET_SCOPE_INVALID",
]) {
  if (!conversationPolicy.includes(token)) failures.push(`policy approval for search assumptions is missing: ${token}`);
}
if (!conversationTypes.includes("clarificationId: string") || !conversationTypes.includes("responseSpec: ClarificationResponseSpec")) failures.push("QUESTION is missing structured response identity or responseSpec");
if (!clarificationSource.includes("options?: readonly ClarificationOptionDefinition[]")) failures.push("authoritative clarification options are not registry-owned");
if (!apiSource.includes('Type.Literal("ANSWER_CLARIFICATION")')) failures.push("API does not expose validated clarification answers");
if (!frontendSource.includes("clarification-options") || !frontendSource.includes("ANSWER_CLARIFICATION")) failures.push("frontend does not render and submit structured clarification answers");
const assistantSchemaSection = schemas.slice(schemas.indexOf("const assistantBlockSchema"));
if (assistantSchemaSection.includes("clarificationId") || assistantSchemaSection.includes("responseSpec")) failures.push("model schema can author server-owned clarification ids or response specs");

if (failures.length > 0) throw new Error(`CLARIFICATION_GOAL_DRIFT\n${failures.map((item) => `- ${item}`).join("\n")}`);
process.stdout.write(`clarification goal: ${expectedOrder.join(" -> ")}; ${invariantIds.length} invariants locked\n`);
