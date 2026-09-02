import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const documentationFiles = [
  "README.md",
  "docs/quote-lead-refactor-execution-plan.md",
  "docs/identity-grounded-quote-agent-execution-plan.md",
  "docs/adr/0002-langfuse-observability.md",
  "docs/adr/0003-source-grounded-offers.md",
  "docs/adr/0004-conversational-turn-runtime.md",
  "docs/adr/0005-policy-constrained-pi-agent-planning.md",
  "docs/adr/0006-maintainability-refactor-and-quality-gates.md",
  "docs/adr/0007-singapore-known-model-quote-leads.md",
  "docs/adr/0008-maintainable-module-architecture.md",
  "docs/adr/0009-identity-grounded-agent-decision-core.md",
  "docs/adr/0010-production-provider-trace-and-export-truthfulness.md",
  "docs/agent-trace-observability-refactor.md",
  "docs/acceptance/completed-phases.md",
];

const livingCurrentFiles = [
  "README.md",
  "docs/quote-lead-refactor-execution-plan.md",
  "docs/identity-grounded-quote-agent-execution-plan.md",
  "docs/adr/0002-langfuse-observability.md",
  "docs/adr/0007-singapore-known-model-quote-leads.md",
  "docs/adr/0008-maintainable-module-architecture.md",
  "docs/adr/0009-identity-grounded-agent-decision-core.md",
  "docs/adr/0010-production-provider-trace-and-export-truthfulness.md",
  "docs/agent-trace-observability-refactor.md",
  "docs/acceptance/completed-phases.md",
];

const retiredActiveNames = [
  "packages/agent/src/turn-agent.ts",
  "packages/agent/src/conversation-turn-executor.ts",
  "packages/runtime/src/conversation-offer-search-service.ts",
  "packages/runtime/src/providers.ts",
];

const retiredProtocolNames = ["commit_turn_plan", "publish_reply"];

const failures = [];
for (const file of documentationFiles) {
  if (!existsSync(file)) {
    failures.push(`${file}: missing`);
    continue;
  }
  const content = readFileSync(file, "utf8");
  for (const retiredName of retiredActiveNames) {
    if (content.includes(retiredName)) failures.push(`${file}: retired active name ${retiredName}`);
  }

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1]?.trim();
    if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0] ?? "");
    if (!path || path.includes(" ")) continue;
    const absolute = resolve(dirname(file), path);
    if (!existsSync(absolute)) failures.push(`${file}: missing local link target ${target}`);
  }
}

for (const file of livingCurrentFiles) {
  const content = readFileSync(file, "utf8");
  for (const token of retiredProtocolNames) {
    if (content.includes(token)) failures.push(`${file}: living document still names retired protocol ${token}`);
  }
}

if (failures.length > 0) {
  throw new Error(`documentation drift:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`documentation drift: ${documentationFiles.length} active documents, ${retiredActiveNames.length} retired names, local links valid`);
