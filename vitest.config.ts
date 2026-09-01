import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/index.ts",
        "packages/api/src/conversation-api-main.ts",
        "packages/runtime/src/conversation-worker-main.ts",
        "packages/runtime/src/migrate.ts",
        "packages/runtime/src/agent-telemetry.ts",
        "packages/runtime/src/operational-metrics.ts",
        "packages/runtime/src/outbox-publisher.ts",
        "packages/runtime/src/runtime-metrics.ts",
        "packages/runtime/src/telemetry.ts",
        "packages/runtime/src/telemetry-runtime.ts",
        "packages/runtime/src/turn-observability.ts",
        "packages/runtime/src/turn-terminal-metrics.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 60,
        branches: 57,
        functions: 71,
        lines: 64,
      },
    },
  },
});
