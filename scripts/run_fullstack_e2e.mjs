import { spawnSync } from "node:child_process";

import pg from "pg";

const databaseUrl = process.env["INTEREC_DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("INTEREC_DATABASE_URL_REQUIRED");
const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ""));
if (database !== "interec_test") {
  throw new Error(`FULLSTACK_E2E_REQUIRES_INTEREC_TEST_DATABASE:${database || "missing"}`);
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, RUN_FULLSTACK_E2E: "1" },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function cleanFullstackTestConversations() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(
      "UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE tenant_id LIKE $1",
      ["browser-e2e-%"],
    );
    await pool.query(
      "DELETE FROM interec_agent.conversations WHERE tenant_id LIKE $1",
      ["browser-e2e-%"],
    );
  } finally {
    await pool.end();
  }
}

const buildStatus = runNode([
  "./node_modules/typescript/bin/tsc",
  "-b",
  "packages/domain",
  "packages/agent",
  "packages/runtime",
  "packages/api",
]);
if (buildStatus !== 0) {
  process.exitCode = buildStatus;
} else {
  let testStatus;
  try {
    testStatus = runNode([
      "./node_modules/@playwright/test/cli.js",
      "test",
      "--config=playwright.fullstack.config.ts",
    ]);
  } finally {
    await cleanFullstackTestConversations();
  }
  process.exitCode = testStatus;
}
