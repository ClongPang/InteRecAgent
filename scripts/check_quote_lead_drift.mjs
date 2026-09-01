import { existsSync, readFileSync } from "node:fs";

const statePath = "spec/quote-lead-refactor-state.json";
const contractPath = "spec/quote-lead-product-contract.json";
const planPath = "docs/quote-lead-refactor-execution-plan.md";
const adrPath = "docs/adr/0007-singapore-known-model-quote-leads.md";
const failures = [];

function requireFile(path, label = path) {
  if (!existsSync(path)) {
    failures.push(`${label}: missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function requireIncludes(content, markers, label) {
  for (const marker of markers) {
    if (!content.includes(marker)) failures.push(`${label}: missing marker ${marker}`);
  }
}

function rejectIncludes(content, markers, label) {
  for (const marker of markers) {
    if (content.includes(marker)) failures.push(`${label}: forbidden marker ${marker}`);
  }
}

const stateText = requireFile(statePath);
const contractText = requireFile(contractPath);
const plan = requireFile(planPath);
const adr = requireFile(adrPath);
const packageText = requireFile("package.json");
const state = stateText ? JSON.parse(stateText) : {};
const contract = contractText ? JSON.parse(contractText) : {};
const packageJson = packageText ? JSON.parse(packageText) : {};

if (state.schemaVersion !== 1) failures.push("refactor state schemaVersion must be 1");
if (state.targetContractVersion !== "quote-leads-sg-v1") failures.push("refactor state target contract drifted");
if (!Number.isInteger(state.currentPhase) || state.currentPhase < 0 || state.currentPhase > 5) failures.push("currentPhase must be 0..5");
if (!["IN_PROGRESS", "APPROVED"].includes(state.phaseStatus)) failures.push("phaseStatus must be IN_PROGRESS or APPROVED");
if (JSON.stringify(state.requiredPhaseOrder) !== JSON.stringify([0, 1, 2, 3, 4, 5])) failures.push("requiredPhaseOrder drifted");
const completedPhases = Array.isArray(state.completedPhases) ? state.completedPhases : [];
if (JSON.stringify(completedPhases) !== JSON.stringify([...completedPhases].sort((a, b) => a - b))) failures.push("completedPhases must be ordered");
for (let index = 0; index < completedPhases.length; index += 1) {
  if (completedPhases[index] !== index) failures.push("completedPhases must be consecutive from phase 0");
}
if (completedPhases.some((phase) => phase >= state.currentPhase && state.phaseStatus !== "APPROVED")) {
  failures.push("an in-progress phase cannot already be listed as complete");
}
const approvals = Array.isArray(state.approvals) ? state.approvals : [];
for (const phase of completedPhases) {
  const approval = approvals.find((item) => item?.phase === phase && item?.decision === "APPROVED");
  if (!approval) {
    failures.push(`completed phase ${phase} lacks an APPROVED record`);
  } else if (typeof approval.evidence !== "string" || !existsSync(approval.evidence)) {
    failures.push(`completed phase ${phase} lacks an existing approval evidence file`);
  }
}
if (state.phaseStatus === "APPROVED" && !completedPhases.includes(state.currentPhase)) {
  failures.push("an approved current phase must be listed as complete");
}
const phaseGates = state.phaseGates ?? {};
for (const phase of state.requiredPhaseOrder ?? []) {
  if (!Array.isArray(phaseGates[String(phase)]) || phaseGates[String(phase)].length < 2) {
    failures.push(`phase ${phase} must define at least two reproducible gates`);
  }
}

if (contract.contractVersion !== state.targetContractVersion) failures.push("state and product contract versions differ");
if (contract.serviceMarket !== "SG") failures.push("service market drifted from SG");
if (contract.providerPolicy?.primaryTool !== "find_best_price_v2") failures.push("primary provider tool drifted");
if (contract.providerPolicy?.internalDeliverTo !== "SG") failures.push("internal BuyWhere scope drifted");
if ((contract.providerPolicy?.automaticFallbacks ?? ["missing"]).length !== 0) failures.push("automatic provider fallback was introduced");

requireIncludes(plan, [
  "最终目标",
  "最终验收矩阵",
  "每阶段统一审批协议",
  "find_best_price_v2",
  "QuoteObservation",
  "QuoteLead",
  "真实 BuyWhere 验收",
], planPath);
requireIncludes(adr, [
  "Accepted for implementation",
  "deliver_to=SG",
  "find_best_price_v2",
  "QuoteObservation",
  "QuoteLead",
], adrPath);

for (const scriptName of ["quote:contract:check", "quote:drift:check"]) {
  if (typeof packageJson.scripts?.[scriptName] !== "string") failures.push(`package.json: missing ${scriptName}`);
}
if (!String(packageJson.scripts?.acceptance ?? "").includes("quote:contract:check")) {
  failures.push("package.json: acceptance does not include quote contract check");
}
if (!String(packageJson.scripts?.acceptance ?? "").includes("quote:drift:check")) {
  failures.push("package.json: acceptance does not include quote drift check");
}

if (state.currentPhase >= 1) {
  const port = requireFile("packages/runtime/src/quote-provider.ts");
  const adapter = requireFile("packages/runtime/src/buywhere-mcp-quote-client.ts");
  const parser = requireFile("packages/runtime/src/buywhere-mcp-quote-parser.ts");
  const tests = requireFile("packages/runtime/test/buywhere-mcp-quote-client.test.ts");
  requireIncludes(port, ["QuoteProvider", "OK_RESULTS", "OK_EMPTY", "DEGRADED", "FAILED"], "quote-provider.ts");
  requireIncludes(adapter, ["find_best_price_v2", "deliver_to", '"SG"'], "buywhere-mcp-quote-client.ts");
  rejectIncludes(adapter, ["search_products", "semantic", "hybrid", "price_asc"], "buywhere-mcp-quote-client.ts");
  requireIncludes(parser, ["parseBuyWhereMcpToolResponse", "best_price", "alternatives", "DEGRADED", "CONTRACT_DRIFT"], "buywhere-mcp-quote-parser.ts");
  requireIncludes(tests, ["OK_RESULTS", "OK_EMPTY", "DEGRADED", "CONTRACT_DRIFT"], "buywhere-mcp-quote-client.test.ts");
}

if (state.currentPhase >= 2) {
  for (const file of [
    "packages/domain/src/quote-types.ts",
    "packages/domain/src/quote-target.ts",
    "packages/domain/src/quote-admission.ts",
    "packages/domain/src/quote-grouping.ts",
    "packages/runtime/src/quote-lookup-service.ts",
    "packages/runtime/src/quote-provenance.ts",
    "packages/runtime/src/quote-lookup-repository.ts",
    "packages/runtime/conversation-migrations/0019_quote_leads.sql",
  ]) requireFile(file);
  const quoteTypes = requireFile("packages/domain/src/quote-types.ts");
  requireIncludes(quoteTypes, ["QuoteObservation", "QuoteLead", "QUOTE_LEADS", "NO_QUOTE_LEADS"], "quote-types.ts");
  const admission = requireFile("packages/domain/src/quote-admission.ts");
  const grouping = requireFile("packages/domain/src/quote-grouping.ts");
  const service = requireFile("packages/runtime/src/quote-lookup-service.ts");
  const repository = requireFile("packages/runtime/src/quote-lookup-repository.ts");
  const migration = requireFile("packages/runtime/conversation-migrations/0019_quote_leads.sql");
  requireIncludes(admission, ["MODEL_EXACT_MISMATCH", "ACCESSORY_RECORD", "SERVICE_RECORD", "INSUFFICIENT_EVIDENCE"], "quote-admission.ts");
  requireIncludes(grouping, ["normalizeMerchantTargetUrl", "condition", "observationRefs"], "quote-grouping.ts");
  requireIncludes(service, ["PROVIDER_RETURNED_EMPTY", "ALL_RECORDS_REJECTED", "DEGRADED", "collectFx"], "quote-lookup-service.ts");
  requireIncludes(repository, ["QUOTE_LOOKUP_FENCE_REJECTED", "BEGIN", "ROLLBACK", "quote_lead_observations"], "quote-lookup-repository.ts");
  requireIncludes(migration, ["quote_observations", "quote_lead_observations", "quote_source_facts", "ENABLE ROW LEVEL SECURITY"], "0019_quote_leads.sql");
}

if (state.currentPhase >= 3) {
  const schemas = requireFile("packages/agent/src/schemas.ts");
  const prompt = requireFile("packages/agent/src/quote-planner-prompt.ts");
  const frontendTypes = requireFile("frontend/src/conversation/types.ts");
  const frontend = [
    requireFile("frontend/src/App.tsx"),
    requireFile("frontend/src/components/QuoteCard.tsx"),
    requireFile("frontend/src/components/QuotePane.tsx"),
  ].join("\n");
  requireIncludes(schemas, ["LOOKUP_QUOTES", "REFRESH_QUOTES", "QUOTE_LEADS", "NO_QUOTE_LEADS"], "agent schemas");
  requireIncludes(prompt, ["quote lead", "merchant page"], "turn-agent prompt");
  requireIncludes(frontendTypes, ["QuoteLead", "originalPrice", "outboundUrl", "observedAt"], "frontend types");
  requireIncludes(frontend, ["打开商家页确认", "originalPrice", "outboundUrl"], "frontend quote presentation");
}

if (state.currentPhase >= 4) {
  const activeFiles = [
    "packages/domain/src/conversation-types.ts",
    "packages/domain/src/index.ts",
    "packages/agent/src/schemas.ts",
    "packages/agent/src/quote-planner-prompt.ts",
    "packages/agent/src/quote-tool-protocol.ts",
    "packages/agent/src/quote-turn-agent.ts",
    "packages/agent/src/quote-turn-executor.ts",
    "packages/agent/src/index.ts",
    "packages/runtime/src/conversation-worker.ts",
    "packages/runtime/src/quote-worker-turn-runner.ts",
    "packages/runtime/src/conversation-worker-main.ts",
    "packages/runtime/src/index.ts",
    "packages/api/src/app.ts",
    "frontend/src/conversation/types.ts",
    "frontend/src/conversation/use-quote-conversation.ts",
    "frontend/src/components/ConversationPane.tsx",
    "frontend/src/components/QuoteCard.tsx",
    "frontend/src/components/QuotePane.tsx",
    "frontend/src/App.tsx",
  ];
  const active = activeFiles.map((file) => `${file}\n${requireFile(file)}`).join("\n");
  rejectIncludes(active, [
    "RECOMMENDATION",
    "SEARCH_RESULTS",
    "GOAL_SET_DELIVERY_DESTINATION",
    "DELIVERY_DESTINATION",
    "PURCHASE_MARKET",
    "deliveryDestination",
  ], "active quote-lead implementation");
  for (const retired of [
    "packages/agent/src/turn-agent.ts",
    "packages/agent/src/conversation-turn-executor.ts",
    "packages/runtime/src/conversation-offer-search-service.ts",
    "packages/runtime/src/conversation-search-repository.ts",
    "packages/runtime/src/providers.ts",
  ]) {
    if (existsSync(retired)) failures.push(`${retired}: retired activity path still exists`);
  }
  const worker = requireFile("packages/runtime/src/conversation-worker.ts");
  const runner = requireFile("packages/runtime/src/quote-worker-turn-runner.ts");
  requireIncludes(worker, ["runQuoteWorkerTurn", "LEGACY_CONVERSATION_RETIRED"], "quote worker");
  requireIncludes(runner, ["executeQuoteConversationTurn", "QuoteTurnDataService"], "quote worker turn runner");
  const acceptance = String(packageJson.scripts?.acceptance ?? "");
  requireIncludes(acceptance, ["architecture:active:check", "test:integration", "test:e2e"], "default acceptance");
}

if (state.currentPhase >= 5) {
  const liveReportText = requireFile("artifacts/quote-lead-live-acceptance/latest.json");
  requireIncludes(liveReportText, ["contractVersion", "cases", "providerStatus", "observedAt"], "live acceptance report");
  if (liveReportText) {
    const liveReport = JSON.parse(liveReportText);
    if (liveReport.contractVersion !== state.targetContractVersion) failures.push("live acceptance contract version drifted");
    if (liveReport.serviceMarket !== "SG") failures.push("live acceptance service market drifted");
    if (liveReport.providerTool !== "find_best_price_v2") failures.push("live acceptance provider tool drifted");
    if (!Array.isArray(liveReport.cases) || liveReport.cases.length < 8) failures.push("live acceptance case matrix is incomplete");
    if ((liveReport.searchModeFinding?.explicitModeParametersObserved ?? ["missing"]).length !== 0) {
      failures.push("live acceptance introduced an explicit provider search mode");
    }
    if (liveReport.dataHandling?.apiKeyPersisted !== false
      || liveReport.dataHandling?.rawProviderPayloadPersisted !== false
      || liveReport.dataHandling?.rawMerchantUrlsPersisted !== false) {
      failures.push("live acceptance data handling is not sanitized");
    }
    if (state.phaseStatus === "APPROVED") {
      if (liveReport.overallDecision !== "PASS") failures.push("approved phase 5 lacks a passing live acceptance report");
      if (liveReport.cases.some((item) => item?.passed !== true)) failures.push("approved phase 5 contains a failing acceptance case");
      if (liveReport.overallChecks?.some((item) => item?.passed !== true)) failures.push("approved phase 5 contains a failing overall check");
    }
  }
}

if (failures.length > 0) {
  throw new Error(`QUOTE_LEAD_DRIFT_DETECTED\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(
  `quote-lead drift: phase ${state.currentPhase} ${state.phaseStatus}, ${completedPhases.length} completed phases, target ${state.targetContractVersion}`,
);
