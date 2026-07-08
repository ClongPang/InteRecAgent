import { expect, test } from "@playwright/test";

test("internal trace route shows full stage details and replay", async ({ page }) => {
  await page.goto("/internal/trace");

  await expect(page.getByRole("heading", { name: "Internal Trace Console" })).toBeVisible();
  await expect(page.getByLabel("Trace stages")).toContainText("Task route");
  await expect(page.getByLabel("Trace stages")).toContainText("Filtering");
  await expect(page.locator("pre")).toContainText("turn_001");

  await page.getByRole("button", { name: "Replay turn" }).click();
  await expect(page.getByText("Replay completed")).toBeVisible();
});

test("evaluation route shows metrics and run lookup", async ({ page }) => {
  await page.goto("/internal/eval");

  await expect(page.getByRole("heading", { name: "Evaluation dashboard" })).toBeVisible();
  await expect(page.getByLabel("Catalog readiness")).toContainText("Not ready");
  await expect(page.getByLabel("Catalog readiness")).toContainText("normalized_catalog.jsonl");
  await expect(page.getByLabel("Task case readiness")).toContainText("Not ready");
  await expect(page.getByLabel("Task case readiness")).toContainText("task_cases.jsonl");
  await expect(page.getByLabel("Profile readiness")).toContainText("Not ready");
  await expect(page.getByLabel("Profile readiness")).toContainText("user_profiles.jsonl");
  await expect(page.getByLabel("Vector index readiness")).toContainText("Not ready");
  await expect(page.getByLabel("Vector index readiness")).toContainText("product_index.jsonl");
  await expect(page.getByLabel("Evaluation metrics")).toContainText("task_type_accuracy");

  await page.getByLabel("Run ID").fill("eval_selected");
  await page.getByRole("button", { name: "Load run" }).click();
  await expect(page.getByText("Run: eval_selected")).toBeVisible();
});

test("consumer route does not expose raw trace details", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("pre")).toHaveCount(0);
  await expect(page.getByText("raw_profile")).toHaveCount(0);
  await expect(page.getByText("Internal Trace Console")).toHaveCount(0);
});
