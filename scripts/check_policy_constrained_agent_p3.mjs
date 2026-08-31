import { readFile } from "node:fs/promises";

const files = {
  uncertainty: await readFile(new URL("../packages/domain/src/uncertainty.ts", import.meta.url), "utf8"),
  clarificationPolicy: await readFile(new URL("../packages/domain/src/clarification-decision-policy.ts", import.meta.url), "utf8"),
  planReview: await readFile(new URL("../packages/domain/src/plan-policy-review.ts", import.meta.url), "utf8"),
  renderer: await readFile(new URL("../packages/domain/src/assistant-envelope.ts", import.meta.url), "utf8"),
  schema: await readFile(new URL("../packages/agent/src/schemas.ts", import.meta.url), "utf8"),
  prompt: await readFile(new URL("../packages/agent/src/turn-agent.ts", import.meta.url), "utf8"),
  executor: await readFile(new URL("../packages/agent/src/conversation-turn-executor.ts", import.meta.url), "utf8"),
  metrics: await readFile(new URL("../spec/observability/metrics-contract.json", import.meta.url), "utf8"),
  tests: await readFile(new URL("../packages/domain/test/uncertainty.test.ts", import.meta.url), "utf8"),
};

for (const token of ["INTENT_AMBIGUITY", "MISSING_USER_INFORMATION", "MISSING_EVIDENCE", "SYSTEM_FAILURE"]) {
  if (!files.uncertainty.includes(`"${token}"`)) throw new Error(`P3_DRIFT: uncertainty taxonomy misses ${token}`);
}
for (const token of [
  "evaluateAnswerability",
  "input.receipts",
  'mode: "DISCLOSE_UNKNOWN"',
  'mode: "DEGRADE"',
  "unknownFields",
  "CLARIFICATION_RECEIPT_MISSING",
]) {
  if (!files.uncertainty.includes(token)) throw new Error(`P3_DRIFT: Answerability misses ${token}`);
}
for (const forbidden of ["inputMessageContents", "originalUtterance", "rawProse"]) {
  if (files.uncertainty.includes(forbidden)) throw new Error(`P3_DRIFT: Answerability reads prose via ${forbidden}`);
}

const requestSchemaStart = files.schema.indexOf('kind: Type.Literal("REQUEST_CLARIFICATION")');
const requestSchemaEnd = files.schema.indexOf('kind: Type.Literal("UNDO_REVISION")', requestSchemaStart);
const requestSchema = files.schema.slice(requestSchemaStart, requestSchemaEnd);
for (const token of ["uncertainty", "INTENT_AMBIGUITY", "MISSING_USER_INFORMATION", "userResolvable"]) {
  if (!requestSchema.includes(token)) throw new Error(`P3_DRIFT: clarification schema misses ${token}`);
}
for (const forbidden of ["MISSING_EVIDENCE", "SYSTEM_FAILURE", "TURN_REPHRASE"]) {
  if (requestSchema.includes(forbidden)) throw new Error(`P3_DRIFT: model clarification schema admits ${forbidden}`);
}

for (const token of [
  "reviewClarificationRequest",
  "GENERIC_REPHRASE_NOT_ACTIONABLE",
  "CLARIFICATION_UNCERTAINTY_MISMATCH",
  "CLARIFICATION_NOT_DECISION_RELEVANT",
  "CANDIDATE_REFERENT_CONTEXT_REQUIRED",
  "CANDIDATE_REFERENT_NOT_AMBIGUOUS",
]) {
  if (!`${files.clarificationPolicy}\n${files.planReview}`.includes(token)) throw new Error(`P3_DRIFT: clarification reviewer misses ${token}`);
}
if (!files.clarificationPolicy.includes("It never adds, removes, or rewrites a")) {
  throw new Error("P3_DRIFT: clarification policy is not documented as a pure reviewer");
}

const firstNoPlan = files.executor.indexOf("if (!plan) {");
const secondNoPlan = files.executor.indexOf("if (!plan) {", firstNoPlan + 1);
const prePlanFallback = files.executor.slice(firstNoPlan, secondNoPlan);
for (const token of ['ops: []', 'outcome: "DEGRADED"', "evaluateAnswerability"]) {
  if (!prePlanFallback.includes(token)) throw new Error(`P3_DRIFT: pre-plan fallback misses ${token}`);
}
if (prePlanFallback.includes("REQUEST_CLARIFICATION") || prePlanFallback.includes("TURN_REPHRASE")) {
  throw new Error("P3_DRIFT: a pre-plan system failure still creates clarification");
}

for (const token of [
  "PRICE_UNKNOWN",
  "MERCHANT_UNKNOWN",
  "MARKET_UNKNOWN",
  "STOCK_UNKNOWN",
  "MODEL_UNKNOWN",
  "CONDITION_UNKNOWN",
  "RANKING_REASON_UNKNOWN",
  "WARRANTY_UNKNOWN",
]) {
  if (!files.renderer.includes(token)) throw new Error(`P3_DRIFT: natural-language unknown disclosure misses ${token}`);
}
if (files.renderer.includes("return code;")) throw new Error("P3_DRIFT: renderer can expose raw internal disclosure codes");

for (const token of [
  "Missing price, stock, warranty, market evidence",
  "rec_agent.clarification.decisions",
  "rec_agent.answerability.decisions",
  "rec_agent.uncertainty.misattributions",
  "discloses missing evidence without asking the user to rephrase",
  "keeps the same clear question out of clarification when the system fails",
]) {
  if (!`${files.prompt}\n${files.metrics}\n${files.tests}`.includes(token)) throw new Error(`P3_DRIFT: acceptance evidence misses ${token}`);
}

console.log("P3 locked: typed uncertainty ownership, user-resolvable clarification review, receipt-based Answerability, system-owned degradation, and natural-language disclosures");
