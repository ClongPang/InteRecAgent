import { existsSync, readFileSync } from "node:fs";

const contractPath = "spec/identity-grounded-quote-contract.json";
const statePath = "spec/identity-grounded-quote-state.json";
const packagePath = "package.json";
const failures = [];

function load(path) {
  if (!existsSync(path)) {
    failures.push(`${path}: missing`);
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireFiles(files, phase) {
  for (const file of files) {
    if (!existsSync(file)) failures.push(`completed phase ${phase}: missing ${file}`);
  }
}

const contract = load(contractPath);
const state = load(statePath);
const packageJson = load(packagePath);

if (state.schemaVersion !== 1) failures.push("state schemaVersion must be 1");
if (state.contractVersion !== contract.contractVersion) failures.push("state and machine contract versions differ");
if (state.baseProductContract !== contract.extendsProductContract) failures.push("base product contract drifted");
if (!Number.isInteger(state.currentPhase) || state.currentPhase < 0 || state.currentPhase > 6) failures.push("currentPhase must be 0..6");
if (!["IN_PROGRESS", "APPROVED"].includes(state.phaseStatus)) failures.push("phaseStatus must be IN_PROGRESS or APPROVED");
if (JSON.stringify(state.requiredPhaseOrder) !== JSON.stringify([0, 1, 2, 3, 4, 5, 6])) failures.push("requiredPhaseOrder drifted");

const completed = Array.isArray(state.completedPhases) ? state.completedPhases : [];
for (let index = 0; index < completed.length; index += 1) {
  if (completed[index] !== index) failures.push("completed phases must be consecutive from phase 0");
}
if (state.phaseStatus === "APPROVED" && !completed.includes(state.currentPhase)) failures.push("approved current phase must be complete");
if (state.phaseStatus === "IN_PROGRESS" && completed.includes(state.currentPhase)) failures.push("in-progress phase cannot already be complete");
if (completed.some((phase) => phase > state.currentPhase)) failures.push("completed phase cannot be ahead of current phase");

const approvals = Array.isArray(state.approvals) ? state.approvals : [];
for (const phase of completed) {
  const approval = approvals.find((entry) => entry?.phase === phase && entry?.decision === "APPROVED");
  if (!approval) failures.push(`completed phase ${phase} lacks approval`);
  else if (typeof approval.evidence !== "string" || !existsSync(approval.evidence)) failures.push(`completed phase ${phase} lacks evidence file`);
}
if (approvals.some((entry) => !completed.includes(entry?.phase))) failures.push("approval exists for an incomplete phase");

for (const script of ["identity:contract:check", "identity:drift:check"]) {
  if (typeof packageJson.scripts?.[script] !== "string") failures.push(`package.json: missing ${script}`);
}
for (const script of ["identity:contract:check", "identity:drift:check"]) {
  if (!String(packageJson.scripts?.acceptance ?? "").includes(script)) failures.push(`default acceptance omits ${script}`);
}

if (completed.includes(0)) {
  requireFiles([
    contractPath,
    statePath,
    "docs/adr/0009-identity-grounded-agent-decision-core.md",
    "docs/identity-grounded-quote-agent-execution-plan.md",
    "scripts/check_identity_grounded_quote_contract.mjs",
    "scripts/check_identity_grounded_quote_drift.mjs",
  ], 0);
}
if (completed.includes(1)) {
  requireFiles([
    "spec/identity-grounded-agent-trajectories.json",
    "scripts/run_identity_grounded_trajectories.ts",
    "packages/agent/test/identity-grounded-agent-eval.test.ts",
  ], 1);
  for (const script of ["identity:trajectory:test", "identity:agent:eval"]) {
    if (typeof packageJson.scripts?.[script] !== "string") failures.push(`completed phase 1: missing ${script}`);
    if (!String(packageJson.scripts?.acceptance ?? "").includes(`npm run ${script}`)) failures.push(`completed phase 1: default acceptance omits ${script}`);
  }
}
if (completed.includes(2)) {
  requireFiles([
    "packages/domain/src/product-identity.ts",
    "packages/domain/src/product-identity-registry.ts",
    "packages/runtime/conversation-migrations/0022_product_identity.sql",
    "packages/runtime/src/postgres-product-identity-registry.ts",
    "packages/domain/test/product-identity.test.ts",
    "packages/runtime/test/product-identity-registry.integration.test.ts",
  ], 2);
  const migrator = existsSync("packages/runtime/src/schema-migrator.ts") ? readFileSync("packages/runtime/src/schema-migrator.ts", "utf8") : "";
  for (const marker of ["product_identity_registry_versions", "product_aliases", "product_identifiers_approved_gtin_unique_idx"]) {
    if (!migrator.includes(marker)) failures.push(`completed phase 2: schema verification omits ${marker}`);
  }
  const integrationRunner = existsSync("scripts/run_postgres_integration.mjs") ? readFileSync("scripts/run_postgres_integration.mjs", "utf8") : "";
  if (!integrationRunner.includes("product-identity-registry.integration.test.ts")) failures.push("completed phase 2: identity repository integration test is not in the default suite");
}
if (completed.includes(3)) {
  requireFiles([
    "packages/domain/src/quote-command-decision.ts",
    "packages/domain/src/quote-effects.ts",
    "packages/domain/test/quote-command-decision.test.ts",
  ], 3);
  const executor = existsSync("packages/agent/src/quote-turn-executor.ts") ? readFileSync("packages/agent/src/quote-turn-executor.ts", "utf8") : "";
  for (const forbidden of ["resolveQuoteTarget(", "resolveQuoteLeadReferents(", "excludedQuoteLeadRefs:", "pendingTargetConfirmation:"]) {
    if (executor.includes(forbidden)) failures.push(`completed phase 3: agent executor still owns domain transition ${forbidden}`);
  }
  for (const required of ["decideQuoteCommand", "applyQuoteEffectResult"]) {
    if (!executor.includes(required)) failures.push(`completed phase 3: agent executor omits ${required}`);
  }
  const runtimeEffects = existsSync("packages/runtime/src/quote-turn-data-service.ts") ? readFileSync("packages/runtime/src/quote-turn-data-service.ts", "utf8") : "";
  for (const required of ["implements QuoteEffectExecutionPort", "execute(effect: QuoteEffect", "status: \"SUCCEEDED\""]) {
    if (!runtimeEffects.includes(required)) failures.push(`completed phase 3: runtime effect interpreter omits ${required}`);
  }
}
if (completed.includes(4)) {
  requireFiles([
    "packages/agent/src/identity-hypothesis.ts",
    "packages/agent/test/identity-hypothesis.test.ts",
    "packages/agent/test/identity-grounded-agent-eval.test.ts",
  ], 4);
  const hypothesis = readFileSync("packages/agent/src/identity-hypothesis.ts", "utf8");
  for (const required of [
    "IDENTITY_SOURCE_SPAN_INVALID",
    "IDENTITY_SOURCE_TEXT_MISMATCH",
    "IDENTITY_CANDIDATE_NOT_ALLOWED",
    "IDENTITY_LOOKUP_REQUIRES_MODEL_LITERAL",
  ]) {
    if (!hypothesis.includes(required)) failures.push(`completed phase 4: identity host review omits ${required}`);
  }
  const schema = existsSync("packages/agent/src/schemas.ts") ? readFileSync("packages/agent/src/schemas.ts", "utf8") : "";
  for (const required of ["identityHypothesisSchema", "selectedVariantRef", "identitySourceClaimSchema"]) {
    if (!schema.includes(required)) failures.push(`completed phase 4: model schema omits ${required}`);
  }
  const prompt = existsSync("packages/agent/src/quote-planner-prompt.ts") ? readFileSync("packages/agent/src/quote-planner-prompt.ts", "utf8") : "";
  for (const required of ["exact model", "selectedVariantRef", "confidence is informational only"]) {
    if (!prompt.includes(required)) failures.push(`completed phase 4: planner protocol omits ${required}`);
  }
  const executor = existsSync("packages/agent/src/quote-turn-executor.ts") ? readFileSync("packages/agent/src/quote-turn-executor.ts", "utf8") : "";
  for (const required of ["reviewIdentityHypothesis", "validateIdentityCandidates"]) {
    if (!executor.includes(required)) failures.push(`completed phase 4: executor host boundary omits ${required}`);
  }
  const planBinding = existsSync("packages/agent/src/quote-plan-binding.ts") ? readFileSync("packages/agent/src/quote-plan-binding.ts", "utf8") : "";
  if (!planBinding.includes("identityHypothesis: _identityHypothesis")) failures.push("completed phase 4: host plan binding no longer strips the model-only identity hypothesis");
  const worker = existsSync("packages/runtime/src/quote-worker-turn-runner.ts") ? readFileSync("packages/runtime/src/quote-worker-turn-runner.ts", "utf8") : "";
  for (const required of ["PostgresProductIdentityRegistry", "findProductIdentityCandidates", "identityCandidates"]) {
    if (!worker.includes(required)) failures.push(`completed phase 4: runtime candidate projection omits ${required}`);
  }
  for (const file of ["packages/domain/src/quote-plan-policy.ts", "packages/domain/src/quote-command-decision.ts", "packages/domain/src/quote-effects.ts"]) {
    const content = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (/\bconfidence\b/u.test(content)) failures.push(`completed phase 4: LLM confidence leaked into domain authorization in ${file}`);
  }
}
if (completed.includes(5)) {
  requireFiles([
    "packages/domain/src/offer-identity.ts",
    "packages/runtime/src/identity-resolution-observability.ts",
    "packages/domain/test/offer-identity.test.ts",
    "packages/runtime/test/identity-resolution-observability.test.ts",
    "spec/identity-resolution-shadow-replay.json",
    "scripts/run_identity_resolution_shadow_replay.ts",
  ], 5);
  if (typeof packageJson.scripts?.["identity:shadow:replay"] !== "string") failures.push("completed phase 5: missing identity:shadow:replay");
  if (!String(packageJson.scripts?.acceptance ?? "").includes("npm run identity:shadow:replay")) failures.push("completed phase 5: default acceptance omits identity:shadow:replay");
  const offerIdentity = readFileSync("packages/domain/src/offer-identity.ts", "utf8");
  for (const required of [
    "STRONG_IDENTIFIER_MATCH",
    "CURATED_TITLE_ALIAS_MATCH",
    "EXACT_LEXICAL_MATCH",
    "PROBABILISTIC_CANDIDATE",
    "IDENTITY_OR_ROLE_CONFLICT",
  ]) {
    if (!offerIdentity.includes(required)) failures.push(`completed phase 5: Offer identity resolver omits ${required}`);
  }
  if (offerIdentity.includes("rawRecord")) failures.push("completed phase 5: Offer resolver reparses raw Provider records instead of typed identity signals");
  const admission = readFileSync("packages/domain/src/quote-admission.ts", "utf8");
  for (const required of ["identitySignals", "resolveOfferIdentity", "identityStrength", "identityEvidenceRefs"]) {
    if (!admission.includes(required)) failures.push(`completed phase 5: Offer admission omits ${required}`);
  }
  for (const retired of ["MODEL_EXACT_MISMATCH", "ACCESSORY_RECORD", "SERVICE_RECORD"]) {
    if (admission.includes(retired)) failures.push(`completed phase 5: retired title-regex admission path remains active: ${retired}`);
  }
  const targetResolver = readFileSync("packages/domain/src/quote-target.ts", "utf8");
  for (const retired of ["BRAND_ALIASES", "canonicalModelDisplay", "Sony", "Apple", "Samsung"]) {
    if (targetResolver.includes(retired)) failures.push(`completed phase 5: hard-coded target identity remains active: ${retired}`);
  }
  for (const required of ["identityResolution", "identityBindingFromResolution", "MODEL_CANONICAL_ALIAS_REQUIRES_CONFIRMATION"]) {
    if (!targetResolver.includes(required)) failures.push(`completed phase 5: registry target cutover omits ${required}`);
  }
  const binding = readFileSync("packages/agent/src/quote-plan-binding.ts", "utf8");
  for (const required of ["resolveProductIdentity", "selectProductIdentityCandidateForConfirmation", "identityResolution"]) {
    if (!binding.includes(required)) failures.push(`completed phase 5: host plan binding omits ${required}`);
  }
  const dataService = readFileSync("packages/runtime/src/quote-turn-data-service.ts", "utf8");
  for (const required of ["target.identity.registryVersion", "getSnapshot(registryVersion)", "QUOTE_TARGET_IDENTITY_SNAPSHOT_NOT_FOUND"]) {
    if (!dataService.includes(required)) failures.push(`completed phase 5: exact registry replay omits ${required}`);
  }
  const observability = readFileSync("packages/runtime/src/identity-resolution-observability.ts", "utf8");
  for (const required of ["identityResolutions", "identityShadowComparisons", "identityShadowDisagreements", "no second production resolver"]) {
    if (!observability.includes(required)) failures.push(`completed phase 5: identity observability omits ${required}`);
  }
  for (const productionFile of ["packages/domain/src/quote-admission.ts", "packages/runtime/src/quote-lookup-service.ts"]) {
    const content = readFileSync(productionFile, "utf8");
    if (content.includes("frozenLegacyStatus") || content.includes("compareIdentityResolutionShadow")) {
      failures.push(`completed phase 5: permanent dual resolver leaked into ${productionFile}`);
    }
  }
}
if (completed.includes(6)) {
  requireFiles([
    "packages/domain/test/identity-properties.test.ts",
    "scripts/run_identity_mutations.ts",
    "spec/identity-grounded-buywhere-acceptance-evidence.json",
    "docs/acceptance/identity-grounded-phase-6-final-2026-09-01.md",
  ], 6);
  if (typeof packageJson.scripts?.["identity:mutation:test"] !== "string") failures.push("completed phase 6: missing identity mutation test");
  if (!String(packageJson.scripts?.acceptance ?? "").includes("npm run identity:mutation:test")) failures.push("completed phase 6: default acceptance omits identity mutation test");
  const adr = existsSync("docs/adr/0009-identity-grounded-agent-decision-core.md")
    ? readFileSync("docs/adr/0009-identity-grounded-agent-decision-core.md", "utf8")
    : "";
  if (!adr.includes("Status: Accepted")) failures.push("completed phase 6 requires final ADR acceptance");
  const liveReport = existsSync("spec/identity-grounded-buywhere-acceptance-evidence.json")
    ? load("spec/identity-grounded-buywhere-acceptance-evidence.json")
    : {};
  if (liveReport.overallDecision !== "PASS") failures.push("completed phase 6 requires a passing live BuyWhere acceptance report");
  if (liveReport.liveCallCount !== 5
    || liveReport.providerEvaluatedCaseCount < 5
    || liveReport.deterministicOfferIdentityChecksPassed !== true
    || liveReport.failedOverallCheckCount !== 0) {
    failures.push("completed phase 6 live evidence omits deterministic Offer identity assertions");
  }
  if (liveReport.dataHandling?.apiKeyPersisted !== false
    || liveReport.dataHandling?.rawProviderPayloadPersisted !== false
    || liveReport.dataHandling?.rawMerchantUrlsPersisted !== false
    || liveReport.dataHandling?.onlySanitizedAggregatesPersisted !== true) {
    failures.push("completed phase 6 live report violates sanitized evidence handling");
  }
}

if (failures.length > 0) {
  throw new Error(`IDENTITY_GROUNDED_QUOTE_DRIFT_DETECTED\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`identity-grounded quote drift: phase ${state.currentPhase} ${state.phaseStatus}, ${completed.length} completed phases`);
