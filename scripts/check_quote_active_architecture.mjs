import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const layers = [
  { name: "domain", root: "packages/domain/src", manifest: "packages/domain/package.json", allowedInternal: [] },
  { name: "agent", root: "packages/agent/src", manifest: "packages/agent/package.json", allowedInternal: ["@interec/domain"] },
  { name: "runtime", root: "packages/runtime/src", manifest: "packages/runtime/package.json", allowedInternal: ["@interec/agent", "@interec/domain"] },
  { name: "api", root: "packages/api/src", manifest: "packages/api/package.json", allowedInternal: ["@interec/domain", "@interec/runtime"] },
  { name: "frontend", root: "frontend/src", manifest: "frontend/package.json", allowedInternal: [] },
];

function allFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

function sourceFiles(root) {
  return allFiles(root).filter((path) => [".ts", ".tsx"].includes(extname(path)));
}

function read(path) {
  return readFileSync(path, "utf8");
}

function requireMarkers(paths, markers, label, failures) {
  const content = paths.map((path) => `${path}\n${read(path)}`).join("\n");
  for (const marker of markers) {
    if (!content.includes(marker)) failures.push(`${label}: missing ${marker}`);
  }
}

const failures = [];
const retiredFiles = [
  "packages/agent/src/turn-agent.ts",
  "packages/agent/src/conversation-turn-executor.ts",
  "packages/runtime/src/conversation-offer-search-service.ts",
  "packages/runtime/src/conversation-search-repository.ts",
  "packages/runtime/src/providers.ts",
  "packages/runtime/src/postgres-turn-commit.ts",
];
for (const file of retiredFiles) {
  if (existsSync(file)) failures.push(`${file}: retired implementation still exists`);
}

const allowedScripts = new Set([
  "check_docs_drift.mjs",
  "check_maintainability_boundaries.mjs",
  "check_quote_active_architecture.mjs",
  "check_quote_lead_contract.mjs",
  "check_quote_lead_drift.mjs",
  "clean_build_outputs.mjs",
  "probe_quote_provider.ts",
  "quote_live_acceptance_controlled.ts",
  "quote_live_acceptance_history.ts",
  "quote_live_acceptance_support.ts",
  "run_postgres_integration.mjs",
  "run_quote_coverage.mjs",
  "run_quote_live_acceptance.ts",
]);
for (const file of readdirSync("scripts", { withFileTypes: true })) {
  if (file.isFile() && !allowedScripts.has(file.name)) {
    failures.push(`scripts/${file.name}: unregistered active script`);
  }
}

const forbiddenBusinessMarkers = [
  "RECOMMENDATION",
  "SEARCH_RESULTS",
  "GOAL_SET_DELIVERY_DESTINATION",
  "DELIVERY_DESTINATION",
  "PURCHASE_MARKET",
  "deliveryDestination",
  "executeConversationTurn",
  "ConversationOfferSearchService",
  "ProductSearchPort",
  "BuyWhereClient",
  "search_products_v2",
  "NO_PENDING_CLARIFICATION",
  "STALE_CLARIFICATION_ID",
];
const activeFiles = layers.flatMap((layer) => sourceFiles(layer.root));
for (const file of activeFiles) {
  const content = read(file);
  for (const marker of forbiddenBusinessMarkers) {
    if (content.includes(marker)) {
      failures.push(`${relative(".", file)}: forbidden active marker ${marker}`);
    }
  }
}

requireMarkers(
  ["packages/runtime/src/conversation-worker.ts", "packages/runtime/src/quote-worker-turn-runner.ts"],
  ["runQuoteWorkerTurn", "executeQuoteConversationTurn", "QuoteTurnDataService", "LEGACY_CONVERSATION_RETIRED"],
  "quote worker boundary",
  failures,
);
requireMarkers(
  ["packages/runtime/src/conversation-worker-main.ts"],
  ["BuyWhereMcpQuoteClient", "FxRatesClient", "ConversationWorker"],
  "quote worker composition",
  failures,
);
requireMarkers(
  [
    "packages/runtime/src/postgres-conversation-repository.ts",
    "packages/runtime/src/postgres-turn-submission.ts",
    "packages/runtime/src/postgres-turn-lifecycle.ts",
  ],
  ["postgres-conversation-store", "c.contract_version = $2", "LEGACY_CONVERSATION_RETIRED"],
  "PostgreSQL repository boundary",
  failures,
);
requireMarkers(
  ["packages/api/src/app.ts", "packages/api/src/api-errors.ts", "packages/api/src/conversation-routes.ts"],
  ["registerConversationRoutes", "Type.Literal(\"MESSAGE\")", "LEGACY_CONVERSATION_RETIRED"],
  "API composition boundary",
  failures,
);

const importPattern = /(?:from\s+|import\s*)["']([^"']+)["']/gu;
for (const layer of layers) {
  const allowed = new Set(layer.allowedInternal);
  for (const file of sourceFiles(layer.root)) {
    const content = read(file);
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier?.startsWith("@interec/") && !allowed.has(specifier)) {
        failures.push(`${relative(".", file)}: ${layer.name} cannot import ${specifier}`);
      }
      if (specifier?.includes("/packages/") || specifier?.includes("\\packages\\")) {
        failures.push(`${relative(".", file)}: cross-package deep import ${specifier}`);
      }
    }
  }

  const packageJson = JSON.parse(read(layer.manifest));
  const declaredInternal = Object.keys({
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  }).filter((name) => name.startsWith("@interec/")).sort();
  const expectedInternal = [...allowed].sort();
  if (JSON.stringify(declaredInternal) !== JSON.stringify(expectedInternal)) {
    failures.push(`${layer.manifest}: internal dependencies ${JSON.stringify(declaredInternal)} must equal ${JSON.stringify(expectedInternal)}`);
  }
}

for (const rootIndex of [
  "packages/domain/src/index.ts",
  "packages/agent/src/index.ts",
  "packages/runtime/src/index.ts",
]) {
  if (/export\s+\*/u.test(read(rootIndex))) {
    failures.push(`${rootIndex}: root entrypoint must use explicit exports`);
  }
}

for (const packageName of ["domain", "agent", "runtime"]) {
  const packageJson = JSON.parse(read(`packages/${packageName}/package.json`));
  if (JSON.stringify(packageJson.exports) !== JSON.stringify({ ".": "./dist/index.js" })) {
    failures.push(`packages/${packageName}/package.json: package must expose only its explicit root entrypoint`);
  }
}

const packageJson = JSON.parse(read("package.json"));
const acceptance = String(packageJson.scripts?.acceptance ?? "");
for (const required of [
  "quote:contract:check",
  "quote:drift:check",
  "architecture:active:check",
  "architecture:maintainability:check",
  "test:unit",
  "test:coverage",
  "test:integration",
  "test:e2e",
  "build",
]) {
  if (!acceptance.includes(required)) failures.push(`package.json acceptance: missing ${required}`);
}

const qualityWorkflow = read(".github/workflows/quality.yml");
if (!qualityWorkflow.includes("npm run acceptance")) {
  failures.push("quality workflow: full acceptance is not the required CI path");
}
if (qualityWorkflow.includes("test:e2e:fullstack")) {
  failures.push("quality workflow: references retired fullstack command");
}

for (const packageName of ["domain", "agent", "runtime", "api"]) {
  const sourceRoot = `packages/${packageName}/src`;
  const distRoot = `packages/${packageName}/dist`;
  if (!existsSync(distRoot)) continue;
  const allowedOutputs = new Set(
    sourceFiles(sourceRoot).map((file) => (
      relative(sourceRoot, file).replace(/\\/gu, "/").replace(/\.tsx?$/u, "")
    )),
  );
  for (const file of allFiles(distRoot).filter((candidate) => /\.(?:js|ts)(?:\.map)?$/u.test(candidate))) {
    const output = relative(distRoot, file).replace(/\\/gu, "/")
      .replace(/\.d\.ts\.map$/u, "")
      .replace(/\.js\.map$/u, "")
      .replace(/\.d\.ts$/u, "")
      .replace(/\.js$/u, "");
    if (!allowedOutputs.has(output)) {
      failures.push(`${relative(".", file)}: stale build output has no active source`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`QUOTE_ACTIVE_ARCHITECTURE_INVALID\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(
  `quote active architecture: ${activeFiles.length} production files, five directed layers, explicit public entrypoints`,
);
