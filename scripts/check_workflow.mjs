import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(root, ".github/workflows/quality.yml");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const fullstackRunner = await readFile(resolve(root, "scripts/run_fullstack_e2e.mjs"), "utf8");
const document = parseDocument(await readFile(workflowPath, "utf8"));
if (document.errors.length > 0) {
  throw new Error(`WORKFLOW_YAML_INVALID\n${document.errors.map((error) => error.message).join("\n")}`);
}

const workflow = document.toJS();
const jobs = workflow?.jobs ?? {};
for (const required of ["offline", "postgres"]) {
  if (!jobs[required]) throw new Error(`WORKFLOW_JOB_MISSING:${required}`);
}
if (workflow?.on?.schedule) throw new Error("LIVE_ACCEPTANCE_MUST_NOT_BE_SCHEDULED");
if (jobs["live-acceptance"]) throw new Error("LIVE_ACCEPTANCE_REQUIRES_COMPLETED_CONVERSATIONAL_RUNTIME");
for (const required of ["acceptance:runtime-smoke", "acceptance:gold", "acceptance:shadow", "acceptance:operations", "live:turn:once", "observability:check", "test:e2e:fullstack"]) {
  if (!packageJson.scripts?.[required]) throw new Error(`ACCEPTANCE_SCRIPT_MISSING:${required}`);
}

const postgresRuns = (jobs.postgres.steps ?? []).flatMap((step) => typeof step?.run === "string" ? [step.run] : []);
for (const required of ["npm run db:migrate", "npm run test:integration", "npx playwright install --with-deps chromium", "npm run test:e2e:fullstack"]) {
  if (!postgresRuns.includes(required)) throw new Error(`POSTGRES_GATE_STEP_MISSING:${required}`);
}
const postgresDatabaseUrl = jobs.postgres.env?.INTEREC_DATABASE_URL;
if (typeof postgresDatabaseUrl !== "string" || new URL(postgresDatabaseUrl).pathname !== "/interec_test") {
  throw new Error("POSTGRES_GATE_REQUIRES_ISOLATED_TEST_DATABASE");
}
if (!fullstackRunner.includes("FULLSTACK_E2E_REQUIRES_INTEREC_TEST_DATABASE")) {
  throw new Error("FULLSTACK_E2E_DATABASE_GUARD_MISSING");
}

process.stdout.write("workflow: valid offline/PostgreSQL gates, isolated Chromium full-stack acceptance, and controlled runtime/gold/shadow/live entrypoints; external live acceptance requires explicit approval\n");
