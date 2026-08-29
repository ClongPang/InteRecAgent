import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "--env-file-if-exists=.env",
  "./node_modules/vitest/vitest.mjs",
  "run",
  "--maxWorkers=1",
  "--no-file-parallelism",
  "packages/runtime/test/postgres-conversation-repository.integration.test.ts",
  "packages/api/test/postgres-api.integration.test.ts",
], {
  cwd: process.cwd(),
  env: { ...process.env, RUN_CONVERSATION_PG_INTEGRATION: "1" },
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
