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
  "packages/runtime/src/conversation-research-world.ts",
  "packages/runtime/src/conversation-research-repository.ts",
  "packages/runtime/src/provider-governor.ts",
  "packages/runtime/src/conversation-worker.ts",
  "packages/runtime/src/conversation-worker-main.ts",
  "packages/api/src/conversation-api-main.ts",
  "frontend/src/conversation/client.ts",
  "packages/domain/src/catalog-contracts.ts",
  "packages/runtime/conversation-migrations/0003_research_proof_chain.sql",
  "packages/runtime/conversation-migrations/0004_research_owned_row_constraints.sql",
  "packages/runtime/conversation-migrations/0005_promoted_proof_immutability.sql",
];
for (const relativePath of requiredFiles) {
  try {
    await readFile(resolve(root, relativePath), "utf8");
  } catch {
    violations.push(`${relativePath}: required Conversation research/proof component is missing`);
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

const contracts = await readFile(resolve(root, "packages/domain/src/catalog-contracts.ts"), "utf8");
for (const required of ['categoryId: "headphones"', 'categoryId: "smartphone"', 'marketId: "US"', 'marketId: "SG"']) {
  if (!contracts.includes(required)) violations.push(`catalog-contracts.ts: missing first-release contract ${required}`);
}

const draftHost = await readFile(resolve(root, "packages/agent/src/draft-host.ts"), "utf8");
const modelSchemas = await readFile(resolve(root, "packages/agent/src/schemas.ts"), "utf8");
const qualificationRunner = await readFile(resolve(root, "scripts/run_internal_qualification.ts"), "utf8");
const qualificationScorer = await readFile(resolve(root, "scripts/score_internal_qualification.ts"), "utf8");
if (!draftHost.includes("compileTurnIntent(sanitizeGoalProposal")) {
  violations.push("draft-host.ts: model semantic effects do not pass through the intent compiler");
}
if (!draftHost.includes("const allowLexicalIntentRecovery = false")) {
  violations.push("draft-host.ts: lexical missing-intent recovery is not explicitly disabled");
}
if (modelSchemas.includes('Type.Literal("RERANK_WORKING_SET")')) {
  violations.push("schemas.ts: model protocol exposes Host-owned mechanical reranking");
}
if (/focusRanks\s*=\s*new Map|focusRanks\.get\(testCase\.taskId\)/u.test(qualificationRunner)) {
  violations.push("run_internal_qualification.ts: evaluator UI context is hard-coded by task ID");
}
const businessGate = qualificationScorer.slice(
  qualificationScorer.indexOf("const businessPassed"),
  qualificationScorer.indexOf("return {", qualificationScorer.indexOf("const businessPassed")),
);
if (/semanticFailures|operationTraceDiagnostic/u.test(businessGate)) {
  violations.push("score_internal_qualification.ts: wording-derived operation diagnostics affect business success");
}
if (!qualificationScorer.includes("invalidProviderTrials")) {
  violations.push("score_internal_qualification.ts: provider failures are not excluded from the valid trial denominator");
}

if (violations.length > 0) {
  throw new Error(`ACTIVE_ARCHITECTURE_VIOLATION\n${violations.map((item) => `- ${item}`).join("\n")}`);
}

process.stdout.write("single implementation: Conversation UI/API/repository/fresh pi-agent/semantic compiler/catalog contracts/proof world/SSE/durable worker\n");
