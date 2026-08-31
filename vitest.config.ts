import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
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
