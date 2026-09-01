import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const documentationFiles = [
  "README.md",
  "docs/quote-lead-refactor-execution-plan.md",
  "docs/adr/0007-singapore-known-model-quote-leads.md",
  "docs/adr/0008-maintainable-module-architecture.md",
  "docs/acceptance/quote-lead-phase-0-baseline-2026-09-01.md",
  "docs/acceptance/quote-lead-phase-1-provider-2026-09-01.md",
  "docs/acceptance/quote-lead-phase-2-domain-evidence-2026-09-01.md",
  "docs/acceptance/quote-lead-phase-3-agent-api-ui-2026-09-01.md",
  "docs/acceptance/quote-lead-phase-4-single-implementation-quality-2026-09-01.md",
  "docs/acceptance/quote-lead-phase-5-live-final-2026-09-01.md",
];

const retiredActiveNames = [
  "packages/agent/src/turn-agent.ts",
  "packages/agent/src/conversation-turn-executor.ts",
  "packages/runtime/src/conversation-offer-search-service.ts",
  "packages/runtime/src/providers.ts",
];

const failures = [];
for (const file of documentationFiles) {
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

if (failures.length > 0) {
  throw new Error(`documentation drift:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`documentation drift: ${documentationFiles.length} active documents, ${retiredActiveNames.length} retired names, local links valid`);
