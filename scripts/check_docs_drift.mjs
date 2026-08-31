import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const documentationFiles = [
  "README.md",
  "docs/project-architecture-interview-guide.md",
  "docs/acceptance/search-attempt-coverage-implementation-2026-08-29.md",
];

const retiredActiveNames = [
  "RESEARCH_OFFERS",
  "INSPECT_RESEARCH_COVERAGE",
  "GOAL_BECAME_RESEARCH_READY",
  "packages/agent/src/intent-compiler.ts",
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
