import { existsSync, readFileSync } from "node:fs";

const boundaries = [
  {
    file: "packages/agent/src/conversation-turn-executor.ts",
    maxLines: 800,
    requires: ["./proposal-grounding.js", "./referent-planning.js"],
  },
  {
    file: "packages/runtime/src/postgres-conversation-repository.ts",
    maxLines: 950,
    requires: ["./postgres-conversation-storage.js", "./postgres-turn-commit.js"],
  },
  {
    file: "packages/runtime/src/telemetry.ts",
    maxLines: 450,
    requires: ["./runtime-metrics.js", "./telemetry-safety.js", "./agent-telemetry.js"],
  },
];

const extractedResponsibilities = [
  ["packages/agent/src/proposal-grounding.ts", "groundTurnPlanProposal"],
  ["packages/agent/src/referent-planning.ts", "stabilizePlanReferents"],
  ["packages/runtime/src/postgres-conversation-storage.ts", "hydrateSnapshot"],
  ["packages/runtime/src/postgres-turn-commit.ts", "commitPostgresConversationTurn"],
  ["packages/runtime/src/runtime-metrics.ts", "bindRuntimeMetrics"],
  ["packages/runtime/src/telemetry-safety.ts", "redactTelemetryData"],
  ["packages/runtime/src/agent-telemetry.ts", "createAgentEventObserver"],
];

const failures = [];
for (const boundary of boundaries) {
  if (!existsSync(boundary.file)) {
    failures.push(`${boundary.file}: missing façade`);
    continue;
  }
  const content = readFileSync(boundary.file, "utf8");
  const lineCount = content.split(/\r?\n/u).length;
  if (lineCount > boundary.maxLines) {
    failures.push(`${boundary.file}: ${lineCount} lines exceeds responsibility budget ${boundary.maxLines}`);
  }
  for (const dependency of boundary.requires) {
    if (!content.includes(dependency)) failures.push(`${boundary.file}: missing responsibility boundary ${dependency}`);
  }
}

for (const [file, responsibility] of extractedResponsibilities) {
  if (!existsSync(file)) {
    failures.push(`${file}: missing extracted responsibility`);
    continue;
  }
  if (!readFileSync(file, "utf8").includes(responsibility)) {
    failures.push(`${file}: missing responsibility marker ${responsibility}`);
  }
}

if (failures.length > 0) {
  throw new Error(`maintainability boundaries:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`maintainability boundaries: ${boundaries.length} façades and ${extractedResponsibilities.length} responsibility modules valid`);

