import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "frontend/e2e",
  fullyParallel: false,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev --workspace frontend -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
