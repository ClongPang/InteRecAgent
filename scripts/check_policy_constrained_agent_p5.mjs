import { readFile } from "node:fs/promises";

const files = {
  policy: await readFile(new URL("../packages/domain/src/conversation-policy.ts", import.meta.url), "utf8"),
  review: await readFile(new URL("../packages/domain/src/plan-policy-review.ts", import.meta.url), "utf8"),
  clarificationPolicy: await readFile(new URL("../packages/domain/src/clarification-decision-policy.ts", import.meta.url), "utf8"),
  uncertainty: await readFile(new URL("../packages/domain/src/uncertainty.ts", import.meta.url), "utf8"),
  turnPlan: await readFile(new URL("../packages/domain/src/turn-plan.ts", import.meta.url), "utf8"),
  repository: await readFile(new URL("../packages/runtime/src/postgres-conversation-repository.ts", import.meta.url), "utf8"),
  turnCommit: await readFile(new URL("../packages/runtime/src/postgres-turn-commit.ts", import.meta.url), "utf8"),
  worker: await readFile(new URL("../packages/runtime/src/conversation-worker.ts", import.meta.url), "utf8"),
  executor: await readFile(new URL("../packages/agent/src/conversation-turn-executor.ts", import.meta.url), "utf8"),
  liveClarification: await readFile(new URL("./run_live_clarification_case.ts", import.meta.url), "utf8"),
  policyTests: await readFile(new URL("../packages/domain/test/plan-policy-review.test.ts", import.meta.url), "utf8"),
  uncertaintyTests: await readFile(new URL("../packages/domain/test/uncertainty.test.ts", import.meta.url), "utf8"),
  workerTests: await readFile(new URL("../packages/runtime/test/conversation-worker.test.ts", import.meta.url), "utf8"),
  relevance: await readFile(new URL("../packages/domain/src/query-product-relevance.ts", import.meta.url), "utf8"),
  semanticClassifier: await readFile(new URL("../packages/runtime/src/semantic-relevance-classifier.ts", import.meta.url), "utf8"),
  relevanceTests: await readFile(new URL("../packages/domain/test/query-product-relevance.test.ts", import.meta.url), "utf8"),
  providerTests: await readFile(new URL("../packages/runtime/test/providers.test.ts", import.meta.url), "utf8"),
  frontend: await readFile(new URL("../frontend/src/App.tsx", import.meta.url), "utf8"),
  frontendTypes: await readFile(new URL("../frontend/src/conversation/types.ts", import.meta.url), "utf8"),
};

for (const token of [
  "SEARCH_MARKET_SCOPE_REDUNDANT",
  "EXPLORATORY_MARKET_SCOPE_NOT_AUTHORIZED",
  "EXPLORATORY_MARKET_SCOPE_INVALID",
]) {
  if (!files.policy.includes(token) || !files.review.includes(token)) {
    throw new Error(`P5_DRIFT: causal market-scope review misses ${token}`);
  }
}

for (const token of [
  "TITLE_DERIVED_IDENTITY_REQUIRES_SEMANTIC_CORROBORATION",
  "SPECIFIC_TARGET_REQUIRES_SEMANTIC_CORROBORATION",
  "STRUCTURED_SEMANTIC_EVIDENCE_CONFLICT",
]) {
  if (!files.relevance.includes(token)) throw new Error(`P5_DRIFT: evidence-independent candidate admission misses ${token}`);
}
for (const token of [
  "Judge the product denoted by the complete title",
  "targetText is the user's canonical product phrase",
  "parseSemanticRelevanceResponse",
]) {
  if (!files.semanticClassifier.includes(token)) throw new Error(`P5_DRIFT: governed semantic corroboration misses ${token}`);
}
for (const token of [
  "requires semantic corroboration when registered-category identity comes only from title text",
  "keeps a specific target phrase binding after broad category normalization",
]) {
  if (!files.relevanceTests.includes(token)) throw new Error(`P5_DRIFT: semantic admission test misses ${token}`);
}
if (!files.providerTests.includes("keeps related products out of main ranking")) {
  throw new Error("P5_DRIFT: cross-layer semantic admission test missing");
}
if (!files.frontend.includes("message.payload.groundedClaims") || !files.frontendTypes.includes("groundedClaims?:")) {
  throw new Error("P5_DRIFT: frontend grounded-claim projection is disconnected");
}
if (`${files.frontend}\n${files.frontendTypes}`.includes("claimLedger")) {
  throw new Error("P5_DRIFT: stale claimLedger alias reappeared in the frontend contract");
}

for (const token of ["validateNoPlanDegradedPublication", "EMPTY_PLAN_REQUIRES_SYSTEM_DEGRADATION"]) {
  if (!`${files.turnPlan}\n${files.repository}\n${files.turnCommit}`.includes(token)) {
    throw new Error(`P5_DRIFT: persisted system-owned no-plan degradation misses ${token}`);
  }
}

for (const token of [
  "directPlanForTypedInputs",
  "GOAL_BECAME_SEARCH_READY",
  "PURCHASE_MARKET_SCOPE_ASSUMED",
]) {
  if (!files.worker.includes(token)) throw new Error(`P5_DRIFT: typed clarification continuation misses ${token}`);
}
for (const token of [
  "continues an initially blocked search after an authoritative market answer",
  'optionId: "US_SG"',
  'type: "SKIP"',
]) {
  if (!files.workerTests.includes(token)) throw new Error(`P5_DRIFT: typed continuation test misses ${token}`);
}

for (const token of [
  "disclosureIndicatesMissingEvidence",
  "disclosureIndicatesIncompleteSearchCoverage",
  'mode: "DISCLOSE_UNKNOWN"',
]) {
  if (!files.uncertainty.includes(token)) throw new Error(`P5_DRIFT: evidence uncertainty handling misses ${token}`);
}
if (!files.executor.includes('incompleteSearchCoverage ? "CHAT" : "NO_MATCH"')) {
  throw new Error("P5_DRIFT: incomplete provider coverage can again masquerade as NO_MATCH");
}
for (const token of [
  "classifies unavailable Provider coverage as missing evidence even without fact fields",
  'disclosureCodes: ["PROVIDER_UNAVAILABLE"]',
]) {
  if (!files.uncertaintyTests.includes(token)) throw new Error(`P5_DRIFT: evidence-ownership test misses ${token}`);
}

for (const token of [
  "TARGET_CLARIFICATION_REQUIRED",
  "PURCHASE_MARKET_CLARIFICATION_REQUIRED",
  "SEARCH_OPERATION_REQUIRED",
  "CANDIDATE_SET_REQUIRED",
]) {
  if (!files.policy.includes(token) || !files.review.includes(token)) {
    throw new Error(`P5_DRIFT: initial/candidate plan completeness misses ${token}`);
  }
}
for (const token of [
  "CANDIDATE_REFERENT_CONTEXT_REQUIRED",
  "CANDIDATE_REFERENT_NOT_AMBIGUOUS",
]) {
  if (!files.clarificationPolicy.includes(token)) {
    throw new Error(`P5_DRIFT: candidate ambiguity ownership misses ${token}`);
  }
}
for (const token of [
  "requires a concrete market question instead of approving a silent half-built initial goal",
  "rejects candidate inspection when the projected candidate set is empty",
]) {
  if (!files.policyTests.includes(token)) throw new Error(`P5_DRIFT: plan-completeness test misses ${token}`);
}

for (const token of [
  "GENERIC_CLARIFICATION_FALLBACK_REAPPEARED",
  "AUTHORITATIVE_OPTIONS_MISMATCH",
  "STRUCTURED_ANSWER_DID_NOT_CONTINUE_SEARCH",
  "evidenceSafeCoverageFailure",
]) {
  if (!files.liveClarification.includes(token)) throw new Error(`P5_DRIFT: live clarification acceptance misses ${token}`);
}

console.log("P5 locked: causal plan repair, typed clarification continuation, evidence-safe outcomes, semantic candidate admission, grounded-claim rendering, and live clarification acceptance");
