import { expect, test } from "@playwright/test";

test("consumer recommendation flow supports feedback and unsupported fallback", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "InteRecAgent" })).toBeVisible();
  await expect(page.getByLabel("System status")).toContainText("InteRecAgent API · ok");

  await page.getByLabel("Message").fill("Recommend wireless headphones under 100 dollars");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Recommendation 1: AeroLite Wireless Commuter Headphones")).toBeVisible();
  await expect(page.getByLabel("Agent workflow panel")).toContainText("single_item_recommendation");
  await expect(page.getByLabel("Product comparison")).toContainText("Suggested choice");

  await page
    .getByLabel("Recommendation 1: AeroLite Wireless Commuter Headphones")
    .getByRole("button", { name: "Show cheaper" })
    .click();
  await expect(page.getByLabel("What changed")).toContainText("price");

  await page.getByLabel("Message").fill("Can I buy it now and check live stock?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Catalog recommendations are still available")).toBeVisible();
});

test("consumer workspace can restore a session summary", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Session ID").fill("sess_e2e_restore");
  await page.getByRole("button", { name: "Load session" }).click();

  await expect(page.getByLabel("Session summary")).toContainText("sess_e2e_restore");
  await expect(page.getByLabel("Session summary")).toContainText("wireless headphones");
});

test("clarification flow accepts option answers", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Message").fill("Recommend something for work");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What kind of product should I focus on for work?" })).toBeVisible();

  await page.getByRole("button", { name: "Mouse" }).click();
  await expect(page.getByLabel("Recommendation results")).toContainText("AeroLite Wireless Commuter Headphones");
});
