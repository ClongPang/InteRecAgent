import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const activeSurfaces = [
  "README.md",
  "Makefile",
  "package.json",
  ".env.example",
  ".github/workflows/quality.yml",
  "frontend/src/App.tsx",
  "frontend/src/conversation/client.ts",
  "frontend/vite.config.ts",
];
const forbidden = [
  { pattern: /(^|[^A-Z0-9_])INTEREC_V2_DATABASE_URL\b/m, label: "rejected v2 database configuration" },
  { pattern: /(^|[^A-Z0-9_])INTEREC_V2_[A-Z0-9_]+\b/m, label: "rejected v2 runtime configuration" },
  { pattern: /(^|[^A-Z0-9_])INTEREC_BUYWHERE_API_KEY\b/m, label: "legacy BuyWhere configuration" },
  { pattern: /(^|[^A-Z0-9_])INTEREC_LLM_(?:PROVIDER|MODEL|API_KEY|BASE_URL)\b/m, label: "legacy LLM configuration" },
  { pattern: /\b(?:pytest|uvicorn|alembic|uv sync)\b/i, label: "legacy Python command" },
  { pattern: /(?:^|[\s`'"/])backend(?:[/.`'"\s]|$)/im, label: "legacy Python runtime entrypoint" },
];

const violations = [];
const requiredFiles = [
  "packages/runtime/src/conversation-offer-search-service.ts",
  "packages/runtime/src/conversation-search-repository.ts",
  "packages/runtime/src/provider-call-controller.ts",
  "packages/runtime/src/conversation-worker.ts",
  "packages/runtime/src/conversation-worker-main.ts",
  "packages/api/src/conversation-api-main.ts",
  "frontend/src/conversation/client.ts",
  "packages/domain/src/catalog-validation-policies.ts",
  "packages/runtime/conversation-migrations/0003_research_proof_chain.sql",
  "packages/runtime/conversation-migrations/0004_research_owned_row_constraints.sql",
  "packages/runtime/conversation-migrations/0005_promoted_proof_immutability.sql",
];
for (const relativePath of requiredFiles) {
  try {
    await readFile(resolve(root, relativePath), "utf8");
  } catch {
    violations.push(`${relativePath}: required Conversation search/source-grounding component is missing`);
  }
}
for (const relativePath of activeSurfaces) {
  const text = await readFile(resolve(root, relativePath), "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) violations.push(`${relativePath}: ${rule.label}`);
  }
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const runtimePackageJson = JSON.parse(await readFile(resolve(root, "packages/runtime/package.json"), "utf8"));
const workspaces = new Set(packageJson.workspaces ?? []);
for (const required of ["packages/*", "frontend"]) {
  if (!workspaces.has(required)) violations.push(`package.json: missing workspace ${required}`);
}
if (packageJson.scripts?.["dev:worker"] && !String(packageJson.scripts["dev:worker"]).includes("conversation-worker-main.ts")) {
  violations.push("package.json: dev:worker still exposes the rejected single-turn worker");
}
for (const scriptName of Object.keys(packageJson.scripts ?? {})) {
  if (/:v2$/.test(scriptName)) violations.push(`package.json: legacy versioned script is still exposed: ${scriptName}`);
}
if (packageJson.scripts?.["dev:api"] && !String(packageJson.scripts["dev:api"]).includes("conversation-api-main.ts")) {
  violations.push("package.json: dev:api still exposes the rejected single-turn API");
}
if (!String(packageJson.scripts?.["db:migrate"] ?? "").includes("packages/runtime/src/migrate.ts")) {
  violations.push("package.json: Conversation migration entrypoint is missing");
}
const integrationScript = String(packageJson.scripts?.["test:integration"] ?? "");
const integrationRunner = integrationScript.includes("run_postgres_integration.mjs")
  ? await readFile(resolve(root, "scripts/run_postgres_integration.mjs"), "utf8")
  : integrationScript;
if (!integrationRunner.includes("postgres-conversation-repository.integration.test.ts")) {
  violations.push("package.json: Conversation PostgreSQL gate is missing");
}
if (runtimePackageJson.dependencies?.["@interec/agent"] !== "0.2.0") {
  violations.push("packages/runtime: Conversation runtime does not depend on @interec/agent");
}
try {
  await readFile(resolve(root, "frontend/src/v2/client.ts"), "utf8");
  violations.push("frontend: rejected /v2 client still exists");
} catch {
  // Expected: WP6 consumes only the durable Conversation API.
}

const rejectedPaths = [
  "pyproject.toml",
  "uv.lock",
  "alembic.ini",
  "packages/runtime/src/run-types.ts",
  "packages/runtime/src/postgres-run-store.ts",
  "packages/runtime/src/shopping-run-handler.ts",
  "packages/runtime/src/live-once.ts",
];
for (const relativePath of rejectedPaths) {
  try {
    await stat(resolve(root, relativePath));
    violations.push(`${relativePath}: rejected implementation path still exists`);
  } catch {
    // Expected after the single-implementation cutover.
  }
}

const activeCodePaths = [
  "packages/domain/src",
  "packages/agent/src",
  "packages/runtime/src",
  "packages/api/src",
  "frontend/src",
];
const legacyCodePatterns = [
  { pattern: /\binterec_v2\b/i, label: "legacy database schema" },
  { pattern: /(?:^|["'`])\/v2(?:\/|["'`])/m, label: "legacy HTTP route" },
  { pattern: /\bx-(?:tenant-id|actor-id)\b/i, label: "browser-reported identity" },
  { pattern: /\b(?:RunStore|PostgresRunStore|Decision-per-turn|submit_decision)\b/, label: "legacy Run/Decision protocol" },
];
async function sourceFiles(directory) {
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }));
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}
for (const directory of activeCodePaths) {
  for (const path of await sourceFiles(resolve(root, directory))) {
    const source = await readFile(path, "utf8");
    for (const rule of legacyCodePatterns) {
      if (rule.pattern.test(source)) violations.push(`${path.slice(root.length + 1)}: ${rule.label}`);
    }
  }
}

const policies = await readFile(resolve(root, "packages/domain/src/catalog-validation-policies.ts"), "utf8");
for (const required of ['categoryId: "headphones"', 'categoryId: "smartphone"', 'marketId: "US"', 'marketId: "SG"']) {
  if (!policies.includes(required)) violations.push(`catalog-validation-policies.ts: missing first-release policy entry ${required}`);
}

const turnExecutor = await readFile(resolve(root, "packages/agent/src/conversation-turn-executor.ts"), "utf8");
const turnAgent = await readFile(resolve(root, "packages/agent/src/turn-agent.ts"), "utf8");
const modelSchemas = await readFile(resolve(root, "packages/agent/src/schemas.ts"), "utf8");
const evaluationRunner = await readFile(resolve(root, "scripts/run_development_evaluation.ts"), "utf8");
const evaluationScorer = await readFile(resolve(root, "scripts/score_development_evaluation.ts"), "utf8");
if (!/const\s+sanitizedHostProposal\s*=\s*sanitizeGoalProposal\(/u.test(turnExecutor)
  || !/const\s+supportedProposal\s*=\s*normalizeTurnPlanProposal\(\s*sanitizedHostProposal\s*,/u.test(turnExecutor)) {
  violations.push("conversation-turn-executor.ts: model-proposed operations do not pass through the plan normalizer");
}
if (/allowLexicalIntentRecovery|executor-recovered-|recoverExplicitWorkingSetProposal/u.test(turnExecutor)) {
  violations.push("conversation-turn-executor.ts: executor-owned lexical planning recovery remains in active code");
}
if (/registeredCategory\?\.categoryId\s*===/u.test(turnExecutor)) {
  violations.push("conversation-turn-executor.ts: category grounding branches by a specific registered category instead of consulting the policy registry");
}
if (turnAgent.includes("想买前置式洗衣机")) {
  violations.push("turn-agent.ts: evaluation-case wording leaked into the production planning prompt");
}
if (!turnAgent.includes("Apply one semantic owner per requirement")) {
  violations.push("turn-agent.ts: target, constraint, and preference semantic ownership is not explicit");
}
if (modelSchemas.includes('Type.Literal("SORT_WORKING_SET_BY_PRICE")')) {
  violations.push("schemas.ts: model protocol exposes executor-owned price sorting");
}
if (/focusRanks\s*=\s*new Map|focusRanks\.get\(testCase\.taskId\)/u.test(evaluationRunner)) {
  violations.push("run_development_evaluation.ts: evaluator UI context is hard-coded by task ID");
}
const businessGate = evaluationScorer.slice(
  evaluationScorer.indexOf("const businessPassed"),
  evaluationScorer.indexOf("return {", evaluationScorer.indexOf("const businessPassed")),
);
if (/semanticFailures|operationTraceDiagnostic/u.test(businessGate)) {
  violations.push("score_development_evaluation.ts: wording-derived operation diagnostics affect business success");
}
if (evaluationScorer.includes("semanticOperationFailures") || evaluationScorer.includes("META_LANGUAGE_OPERATION_PATTERN")) {
  violations.push("score_development_evaluation.ts: wording-derived operation diagnostics remain in the evaluator");
}
if (!evaluationScorer.includes("invalidProviderTrials")) {
  violations.push("score_development_evaluation.ts: provider failures are not excluded from the valid trial denominator");
}

if (violations.length > 0) {
  throw new Error(`ACTIVE_ARCHITECTURE_VIOLATION\n${violations.map((item) => `- ${item}`).join("\n")}`);
}

process.stdout.write("single implementation: Conversation UI/API/repository/pi-agent/plan normalizer/category validation policies/source grounding/SSE/durable worker\n");
