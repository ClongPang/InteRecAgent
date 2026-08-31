import { readFile } from "node:fs/promises";

const files = {
  policy: await readFile(new URL("../packages/domain/src/conversation-policy.ts", import.meta.url), "utf8"),
  review: await readFile(new URL("../packages/domain/src/plan-policy-review.ts", import.meta.url), "utf8"),
  turnPlan: await readFile(new URL("../packages/domain/src/turn-plan.ts", import.meta.url), "utf8"),
  repository: await readFile(new URL("../packages/runtime/src/postgres-conversation-repository.ts", import.meta.url), "utf8"),
  turnCommit: await readFile(new URL("../packages/runtime/src/postgres-turn-commit.ts", import.meta.url), "utf8"),
  executor: await readFile(new URL("../packages/agent/src/conversation-turn-executor.ts", import.meta.url), "utf8"),
  schema: await readFile(new URL("../packages/agent/src/schemas.ts", import.meta.url), "utf8"),
  prompt: await readFile(new URL("../packages/agent/src/turn-agent.ts", import.meta.url), "utf8"),
  renderer: await readFile(new URL("../packages/domain/src/assistant-envelope.ts", import.meta.url), "utf8"),
  policyTests: await readFile(new URL("../packages/domain/test/conversation-properties.test.ts", import.meta.url), "utf8"),
};

for (const token of [
  "Validates a Pi-Agent plan without changing its semantic operations",
  "SEARCH_OPERATION_REQUIRED",
  "SEARCH_MARKETS_REQUIRED",
  "TARGET_CLARIFICATION_REQUIRED",
  "PURCHASE_MARKET_CLARIFICATION_REQUIRED",
  "CANDIDATE_SET_REQUIRED",
  "UNNECESSARY_PROVIDER_SEARCH",
  "SEARCH_MARKET_SCOPE_REDUNDANT",
  "EXPLORATORY_MARKET_SCOPE_NOT_AUTHORIZED",
  "EXPLORATORY_MARKET_SCOPE_INVALID",
]) {
  if (!files.policy.includes(token)) throw new Error(`P4_DRIFT: pure policy validator misses ${token}`);
}
for (const forbidden of [
  "executor-required-",
  "HOST_CANONICALIZED_REQUIRED_CLARIFICATION",
  "EXECUTOR_COMPLETED_SEARCH_PLAN",
  "POLICY_SEMANTIC_REWRITE_REQUIRED",
  "evaluateClarificationDecision",
]) {
  if (`${files.policy}\n${files.review}`.includes(forbidden)) throw new Error(`P4_DRIFT: policy semantic rewrite path returned via ${forbidden}`);
}
if (!files.review.includes("Reviews a semantic plan without changing it")) {
  throw new Error("P4_DRIFT: PlanReview is no longer documented as a pure reviewer");
}

for (const forbidden of [
  "allowLexicalIntentRecovery",
  "executor-recovered-",
  "recoverExplicitWorkingSetProposal",
  "inspectionFieldsFromMessages",
]) {
  if (files.executor.includes(forbidden)) throw new Error(`P4_DRIFT: executor prose-planning fallback returned via ${forbidden}`);
}
if ((files.executor.match(/onPlanCommitted\?\.\(/gu) ?? []).length !== 1) {
  throw new Error("P4_DRIFT: approved plan no longer has exactly one commit callback path");
}
const fallbackStart = files.executor.indexOf("public async fallbackReply");
const fallbackEnd = files.executor.indexOf("private materializeQuestion", fallbackStart);
const fallback = files.executor.slice(fallbackStart, fallbackEnd);
if ((fallback.match(/if \(!plan\)/gu) ?? []).length !== 1) {
  throw new Error("P4_DRIFT: fallbackReply contains multiple pre-plan recovery branches");
}
for (const forbidden of ["TURN_REPHRASE", "REQUEST_CLARIFICATION", "executor-required-", "executor-recovered-"]) {
  if (fallback.includes(forbidden)) throw new Error(`P4_DRIFT: fallbackReply synthesizes business semantics via ${forbidden}`);
}
for (const token of ['ops: []', 'outcome: "DEGRADED"', "systemFailureCode: errorCode"]) {
  if (!fallback.includes(token)) throw new Error(`P4_DRIFT: pre-plan failure contract misses ${token}`);
}

for (const token of [
  "marketScope",
  'Type.Literal("US")',
  'Type.Literal("SG")',
  "PURCHASE_MARKET_SCOPE_ASSUMED",
  "PRODUCT_CONDITION_NOT_RESTRICTED",
]) {
  if (!files.schema.includes(token)) throw new Error(`P4_DRIFT: bounded Agent-owned search assumption misses ${token}`);
}
for (const token of ["INVALID_SEARCH_MARKET_SCOPE", "INVALID_SEARCH_ASSUMPTION_DISCLOSURE", "SEARCH_MARKET_SCOPE_DISCLOSURE_MISMATCH"]) {
  if (!files.turnPlan.includes(token)) throw new Error(`P4_DRIFT: plan boundary misses ${token}`);
}
for (const token of ["validateNoPlanDegradedPublication", "EMPTY_PLAN_REQUIRES_SYSTEM_DEGRADATION"]) {
  if (!`${files.turnPlan}\n${files.repository}\n${files.turnCommit}`.includes(token)) throw new Error(`P4_DRIFT: persisted no-plan degradation misses ${token}`);
}
for (const forbidden of ["questionSlotId", "When dialogue.pendingClarification.clarification.kind is TURN_REPHRASE"]) {
  if (files.prompt.includes(forbidden)) throw new Error(`P4_DRIFT: active model prompt references legacy protocol ${forbidden}`);
}
if (files.renderer.includes("return code;")) throw new Error("P4_DRIFT: renderer can expose raw internal codes");

for (const token of [
  "never replaces a proposed clarification with a host-generated search",
  "never canonicalizes one proposed clarification into another",
  "rejects redundant provider search without removing it from the proposed plan",
]) {
  if (!files.policyTests.includes(token)) throw new Error(`P4_DRIFT: negative ownership test misses ${token}`);
}

console.log("P4 locked: Pi-Agent owns semantic plans; policy only reviews; executor prose recovery and pre-plan clarification fallback are absent");
