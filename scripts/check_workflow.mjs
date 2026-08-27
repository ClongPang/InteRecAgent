import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(root, ".github/workflows/quality.yml");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
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
for (const required of ["acceptance:runtime-smoke", "acceptance:gold", "acceptance:shadow", "acceptance:operations", "live:turn:once", "observability:check"]) {
  if (!packageJson.scripts?.[required]) throw new Error(`ACCEPTANCE_SCRIPT_MISSING:${required}`);
}

process.stdout.write("workflow: valid offline/PostgreSQL gates and controlled runtime/gold/shadow/live entrypoints; external live acceptance requires explicit approval\n");
