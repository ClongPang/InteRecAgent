import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "frontend/e2e-fullstack",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 20_000 },
  reporter: process.env["CI"] ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium-fullstack", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node --import tsx scripts/fullstack_e2e_server.ts",
      url: "http://127.0.0.1:8081/health/ready",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev --workspace frontend -- --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

