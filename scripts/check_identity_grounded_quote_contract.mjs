import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("spec/identity-grounded-quote-contract.json", "utf8"));
const base = JSON.parse(readFileSync("spec/quote-lead-product-contract.json", "utf8"));
const failures = [];

function exact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label} drifted`);
}

function unique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    failures.push(`${label} must contain non-empty strings`);
    return;
  }
  if (new Set(values).size !== values.length) failures.push(`${label} must be unique`);
}

if (contract.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (contract.contractVersion !== "identity-grounded-quote-v1") failures.push("contractVersion drifted");
if (contract.extendsProductContract !== base.contractVersion) failures.push("base product contract mismatch");
if (contract.productBoundary?.serviceMarket !== base.serviceMarket || contract.productBoundary?.serviceMarket !== "SG") {
  failures.push("service market must remain SG");
}
if (contract.productBoundary?.providerTool !== base.providerPolicy?.primaryTool
  || contract.productBoundary?.providerTool !== "find_best_price_v2") {
  failures.push("provider tool must remain find_best_price_v2");
}
if (contract.productBoundary?.recommendationEnabled !== false) failures.push("recommendation must remain disabled");
exact(contract.productBoundary?.automaticProviderFallbacks, [], "automatic provider fallbacks");
exact(base.requiredRoutes, ["talk", "clarify", "quote_followup", "quote_lookup"], "base product route vocabulary");

const trust = contract.trustBoundary ?? {};
unique(trust.llmMay, "trustBoundary.llmMay");
unique(trust.llmMustNot, "trustBoundary.llmMustNot");
unique(trust.identityResolverOwns, "trustBoundary.identityResolverOwns");
unique(trust.domainOwns, "trustBoundary.domainOwns");
unique(trust.runtimeOwns, "trustBoundary.runtimeOwns");
for (const authority of [
  "INVENT_PRODUCT_IDENTIFIER",
  "SILENTLY_CHANGE_MODEL_ALPHANUMERICS",
  "AUTHORIZE_PROVIDER_CALL",
  "UPGRADE_IDENTITY_STRENGTH",
  "ADMIT_OFFER_BY_SEMANTIC_SIMILARITY",
  "MUTATE_CONVERSATION_STATE",
  "COMMIT_TRANSACTION",
]) {
  if (!trust.llmMustNot?.includes(authority)) failures.push(`missing forbidden LLM authority ${authority}`);
}

const identity = contract.identityResolution ?? {};
exact(identity.outcomes, ["RESOLVED", "NEEDS_CONFIRMATION", "UNRESOLVED"], "identity outcomes");
exact(identity.strengths, ["VERIFIED_IDENTIFIER", "CURATED_ALIAS", "USER_CONFIRMED_LITERAL", "NONE"], "identity strengths");
const lookupPolicy = new Map((identity.lookupPolicy ?? []).map((item) => [item?.strength, item]));
for (const strength of identity.strengths ?? []) {
  if (!lookupPolicy.has(strength)) failures.push(`missing lookup policy for ${strength}`);
}
for (const strength of ["VERIFIED_IDENTIFIER", "CURATED_ALIAS", "USER_CONFIRMED_LITERAL"]) {
  const policy = lookupPolicy.get(strength);
  if (policy?.providerCallsAllowed !== 1 || policy?.requiresResolvedOutcome !== true) {
    failures.push(`${strength} lookup policy drifted`);
  }
}
const nonePolicy = lookupPolicy.get("NONE");
if (nonePolicy?.providerCallsAllowed !== 0 || nonePolicy?.requiresResolvedOutcome !== false) failures.push("NONE lookup policy drifted");
const offerPolicy = new Map((identity.offerAdmissionPolicy ?? []).map((item) => [item?.strength, item]));
for (const strength of ["STRONG_IDENTIFIER_MATCH", "CURATED_TITLE_ALIAS_MATCH", "EXACT_LEXICAL_MATCH"]) {
  if (offerPolicy.get(strength)?.publishable !== true || offerPolicy.get(strength)?.merchantPageConfirmationRequired !== true) {
    failures.push(`${strength} offer policy must be publishable only with merchant-page confirmation`);
  }
}
for (const strength of ["PROBABILISTIC_CANDIDATE", "IDENTITY_OR_ROLE_CONFLICT"]) {
  if (offerPolicy.get(strength)?.publishable !== false) failures.push(`${strength} must not be publishable`);
}

const architecture = contract.architecture ?? {};
exact(architecture.dependencyDirection, ["domain", "agent", "runtime", "api"], "dependency direction");
if (architecture.deploymentShape !== "MODULAR_MONOLITH") failures.push("deployment shape must remain a modular monolith");
if (architecture.stateTransitionOwner !== "domain") failures.push("domain must own state transitions");
if (architecture.llmRole !== "SEMANTIC_COPROCESSOR") failures.push("LLM role drifted");
if (architecture.fullEventSourcing !== false || architecture.graphDatabaseRequired !== false) failures.push("unapproved infrastructure expansion");
if (architecture.providerIsIdentityAuthority !== false) failures.push("provider must not become identity authority");

const stages = contract.stages ?? [];
exact(stages.map((stage) => stage?.id), [0, 1, 2, 3, 4, 5, 6], "stage order");
if (new Set(stages.map((stage) => stage?.name)).size !== stages.length) failures.push("stage names must be unique");
for (const stage of stages) {
  unique(stage?.deliverables, `stage ${stage?.id} deliverables`);
  unique(stage?.gates, `stage ${stage?.id} gates`);
  if ((stage?.gates?.length ?? 0) < 3) failures.push(`stage ${stage?.id} needs at least three gates`);
  if (!stage?.gates?.includes("npm run identity:drift:check")) failures.push(`stage ${stage?.id} must run identity drift detection`);
}

if (failures.length > 0) {
  throw new Error(`IDENTITY_GROUNDED_QUOTE_CONTRACT_INVALID\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`identity-grounded quote contract: ${stages.length} ordered stages, ${trust.llmMustNot.length} forbidden LLM authorities, ${offerPolicy.size} offer evidence classes`);
