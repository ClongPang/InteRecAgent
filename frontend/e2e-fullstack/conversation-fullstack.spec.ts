import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const API_URL = "http://127.0.0.1:8081";
const AUTH_SECRET = "interec-fullstack-e2e-secret-0123456789abcdef";
const AUTH_ISSUER = "interec-fullstack-e2e";
const AUTH_AUDIENCE = "interec-fullstack-browser";

type Scenario = "coverage" | "clarification-search" | "retry-after-commit-failure" | "sse-recovery";

function tokenFor(testName: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: AUTH_ISSUER,
    aud: AUTH_AUDIENCE,
    sub: `owner-${randomUUID()}`,
    tenant_id: `browser-e2e-${testName.replace(/[^a-z0-9]+/giu, "-").slice(0, 40)}-${randomUUID()}`,
    nbf: now - 5,
    exp: now + 600,
  })).toString("base64url");
  const signature = createHmac("sha256", AUTH_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function prepareScenario(scenario: Scenario): Promise<void> {
  const response = await fetch(`${API_URL}/__e2e/scenarios/${scenario}`, { method: "POST" });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ scenario, ready: true });
}

async function connect(page: Page, testName: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(tokenFor(testName));
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已连接")).toBeVisible();
}

async function sendMessage(page: Page, content: string): Promise<void> {
  await page.getByLabel("给推荐 Agent 发消息").fill(content);
  await page.getByRole("button", { name: /开始对话|发送/u }).click();
}

test.describe.configure({ mode: "serial" });

test("runs a real authenticated API-worker-PostgreSQL turn", async ({ page }) => {
  await prepareScenario("coverage");
  await connect(page, "coverage");
  await sendMessage(page, "之前搜索过哪些市场？");

  await expect(page.getByText("我先按现有证据核对这个前提。")).toBeVisible();
  await expect(page.getByText("暂无可验证的历史市场检索覆盖记录。")).toBeVisible();
  await expect(page.getByText("状态版本 1")).toBeVisible();
  await expect(page.getByText("之前搜索过哪些市场？")).toBeVisible();
});

test("asks and resolves a purchase-market clarification before real provider orchestration", async ({ page }) => {
  await prepareScenario("clarification-search");
  await connect(page, "clarification-search");
  await sendMessage(page, "想买头戴式耳机，预算 2500 元");

  await expect(page.getByRole("region", { name: "需要补充的信息" })).toContainText("想比较哪些购买市场");
  await expect(page.getByText("状态版本 1")).toBeVisible();
  await page.getByRole("button", { name: "两边都比较" }).click();

  await expect(page.getByRole("heading", { name: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bose QuietComfort Ultra Noise Cancelling Headphones", exact: true })).toBeVisible();
  await expect(page.getByText("预算 2500 CNY")).toBeVisible();
  await expect(page.getByText("US 市场")).toBeVisible();
  await expect(page.getByText("SG 市场")).toBeVisible();
  await expect(page.getByText("状态版本 2")).toBeVisible();
  await expect(page.getByText("选择了：US_SG")).toBeVisible();
});

test("shows a terminal failure and retries the original durable input successfully", async ({ page }) => {
  await prepareScenario("retry-after-commit-failure");
  await connect(page, "retry");
  await sendMessage(page, "之前搜索过哪些市场？");

  const failure = page.getByRole("alert").filter({ hasText: "这一轮没有完成" });
  await expect(failure).toBeVisible();
  await expect(page.getByText("状态版本 0")).toBeVisible();
  const faultStatus = await fetch(`${API_URL}/__e2e/fault-status`).then((response) => response.json()) as {
    turnId: string | null;
    injectedFailures: number;
  };
  expect(faultStatus.turnId).not.toBeNull();
  expect(faultStatus.injectedFailures).toBeGreaterThan(0);

  await failure.getByRole("button", { name: "重试这一轮" }).click();
  await expect(failure).toBeHidden();
  await expect(page.getByText("我先按现有证据核对这个前提。")).toBeVisible();
  await expect(page.getByText("状态版本 1")).toBeVisible();
});

test("reconnects a closed SSE stream with a monotone event cursor", async ({ page }) => {
  await prepareScenario("sse-recovery");
  const cursors: number[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith("/events")) return;
    const header = request.headers()["last-event-id"];
    const value = Number(url.searchParams.get("afterSeq") ?? header ?? "0");
    if (Number.isSafeInteger(value)) cursors.push(value);
  });

  await connect(page, "sse-recovery");
  await sendMessage(page, "之前搜索过哪些市场？");
  await expect(page.getByText("状态版本 1")).toBeVisible();
  await expect(page.getByText("我先按现有证据核对这个前提。")).toBeVisible();

  await expect.poll(() => cursors.length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => cursors.some((cursor) => cursor > 0)).toBe(true);
  expect(cursors.every((cursor, index) => index === 0 || cursor >= cursors[index - 1]!)).toBe(true);
  await expect(page.getByLabel("本轮进度")).toContainText("回复已发布");
});
