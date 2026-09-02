import { expect, test, type Route } from "@playwright/test";

const conversationId = "11111111-1111-4111-8111-111111111111";
const leadA = "ql_sg";
const leadB = "ql_us";
const developmentAccessToken = "signed-development-token";

function quoteLead(
  quoteLeadRef: string,
  title: string,
  merchantLabel: string,
  currency: string,
  amount: string,
  cnyAmount: string | null,
) {
  return {
    quoteLeadRef,
    canonicalModel: "WH-1000XM5",
    representativeTitle: title,
    condition: quoteLeadRef === leadA ? "NEW" : "REFURBISHED",
    merchantLabel,
    merchantDomain: `${merchantLabel.toLowerCase().replaceAll(" ", "-")}.example`,
    outboundUrl: `https://buywhere.example/out/${quoteLeadRef}`,
    priceRanges: [{
      originalPrice: { currency, minAmount: amount, maxAmount: amount },
      cnyEstimate: cnyAmount ? {
        minAmount: cnyAmount,
        maxAmount: cnyAmount,
        fxObservedAt: "2026-09-01T04:00:00.000Z",
        fxExpiresAt: "2026-09-02T04:00:00.000Z",
      } : null,
    }],
    observationCount: quoteLeadRef === leadA ? 2 : 1,
    firstObservedAt: "2026-09-01T05:00:00.000Z",
    latestObservedAt: "2026-09-01T05:10:00.000Z",
  };
}

function projection(compared: boolean) {
  const leads = [
    quoteLead(leadA, "Sony WH-1000XM5 Wireless Headphones — Black", "SG Audio", "SGD", "399.90", "2219.45"),
    quoteLead(leadB, "Sony WH-1000XM5 Wireless Headphones — Refurbished", "Outlet Audio", "USD", "249.99", null),
  ];
  const messages = [
    {
      id: "message-user-quote",
      conversationId,
      seq: 1,
      role: "USER",
      payload: { type: "MESSAGE", content: "Sony WH-1000XM5 headphones" },
      consumedByTurnId: "turn-quote",
      createdAt: "2026-09-01T05:00:00.000Z",
    },
    {
      id: "message-assistant-quote",
      conversationId,
      seq: 2,
      role: "ASSISTANT",
      payload: {
        outcome: "QUOTE_LEADS",
        text: "已记录这次报价观测，共发布 2 个报价线索。原币价格、成色和入口见报价区；请打开商家页确认最终价格、准确型号/版本、成色与是否可购买。部分入口可能是推广或联盟链接。",
        envelope: {
          outcome: "QUOTE_LEADS",
          addressedOpIds: ["target", "lookup"],
          disclosureCodes: ["MERCHANT_PAGE_CHECK_REQUIRED", "AFFILIATE_LINK_DISCLOSURE"],
          text: "已记录这次报价观测，共发布 2 个报价线索。原币价格、成色和入口见报价区；请打开商家页确认最终价格、准确型号/版本、成色与是否可购买。部分入口可能是推广或联盟链接。",
        },
      },
      consumedByTurnId: null,
      createdAt: "2026-09-01T05:10:00.000Z",
    },
    ...(compared ? [{
      id: "message-assistant-compare",
      conversationId,
      seq: 3,
      role: "ASSISTANT",
      payload: {
        outcome: "CHAT",
        text: "已按当前报价观测更新对话视图，没有重新调用报价服务。报价是观测线索；请打开商家页确认最终价格、准确型号/版本、成色与是否可购买。部分入口可能是推广或联盟链接。",
        envelope: {
          outcome: "CHAT",
          addressedOpIds: ["compare"],
          disclosureCodes: ["MERCHANT_PAGE_CHECK_REQUIRED", "AFFILIATE_LINK_DISCLOSURE"],
          text: "已按当前报价观测更新对话视图，没有重新调用报价服务。报价是观测线索；请打开商家页确认最终价格、准确型号/版本、成色与是否可购买。部分入口可能是推广或联盟链接。",
        },
      },
      consumedByTurnId: null,
      createdAt: "2026-09-01T05:11:00.000Z",
    }] : []),
  ];
  const revision = compared ? 2 : 1;
  return {
    conversation: {
      id: conversationId,
      status: "OPEN",
      contractVersion: "quote-leads-sg-v1",
      currentRevision: revision,
      createdAt: "2026-09-01T05:00:00.000Z",
      updatedAt: "2026-09-01T05:11:00.000Z",
    },
    activeTurn: null,
    latestTurn: {
      id: compared ? "turn-compare" : "turn-quote",
      status: "COMPLETED",
      attempt: 1,
      deadlineAt: "2026-09-01T05:12:00.000Z",
      errorCode: null,
      createdAt: "2026-09-01T05:00:00.000Z",
      completedAt: "2026-09-01T05:11:00.000Z",
    },
    state: {
      revision,
      status: "OPEN",
      quote: {
        contractVersion: "quote-leads-sg-v1",
        version: revision,
        target: {
          targetRef: "qt_sony",
          rawText: "Sony WH-1000XM5 headphones",
          brand: "Sony",
          canonicalModel: "WH-1000XM5",
          productType: "headphones",
          requiredQualifiers: [],
          conditionPreference: "ANY",
          canonicalQuery: "Sony WH-1000XM5 headphones",
          confirmation: "LEXICALLY_GROUNDED",
          normalizationChanges: [],
        },
        pendingTargetConfirmation: null,
        leadSet: {
          contractVersion: "quote-leads-sg-v1",
          quoteLeadSetRef: "qls_browser",
          targetRef: "qt_sony",
          outcome: "QUOTE_LEADS",
          reasonCodes: [],
          providerStatus: "OK_RESULTS",
          providerFailureCode: null,
          providerRetryable: null,
          providerContractVersion: "buywhere-test",
          leads,
          observedAt: "2026-09-01T05:10:00.000Z",
        },
        displayQuoteLeadRefs: [leadA, leadB],
        excludedQuoteLeadRefs: [],
        comparisonQuoteLeadRefs: compared ? [leadA, leadB] : [],
        focusQuoteLeadRef: null,
      },
    },
    messages,
    latestAssistantMessage: messages.at(-1),
    eventCursor: 0,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test("completes an exact-model quote-to-comparison flow without legacy shopping semantics", async ({ page }) => {
  const receivedInputs: unknown[] = [];
  let compared = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/dev/auth" && request.method() === "POST") {
      await fulfillJson(route, { session: {
        accessToken: developmentAccessToken,
        expiresAt: "2026-09-01T13:00:00.000Z",
      } });
      return;
    }
    expect(request.headers()["authorization"]).toBe(`Bearer ${developmentAccessToken}`);
    if (url.pathname.endsWith("/events")) {
      await route.abort("aborted");
      return;
    }
    if (url.pathname === "/api/conversations" && request.method() === "POST") {
      await fulfillJson(route, { conversation: { id: conversationId, contractVersion: "quote-leads-sg-v1" } }, 201);
      return;
    }
    if (url.pathname.endsWith("/turns") && request.method() === "POST") {
      const body = request.postDataJSON() as { input: { type?: string; content?: string } };
      receivedInputs.push(body.input);
      compared = body.input.content?.startsWith("请比较第") ?? false;
      await fulfillJson(route, { turn: {
        id: compared ? "turn-compare" : "turn-quote",
        status: "ACCEPTED",
        attempt: 0,
        deadlineAt: "2026-09-01T05:12:00.000Z",
        errorCode: null,
        createdAt: "2026-09-01T05:00:00.000Z",
      } }, 202);
      return;
    }
    if (url.pathname === `/api/conversations/${conversationId}` && request.method() === "GET") {
      await fulfillJson(route, { projection: projection(compared) });
      return;
    }
    await fulfillJson(route, { error: { code: "E2E_ROUTE_NOT_IMPLEMENTED" } }, 500);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "输入准确商品型号" })).toBeVisible();
  await page.getByLabel("给报价助手发消息").fill("Sony WH-1000XM5 headphones");
  await page.getByRole("button", { name: "开始查询" }).click();

  await expect(page.getByRole("heading", { name: "Sony WH-1000XM5 Wireless Headphones — Black" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sony WH-1000XM5 Wireless Headphones — Refurbished" })).toBeVisible();
  await expect(page.getByText("SGD 399.90")).toBeVisible();
  await expect(page.getByText("USD 249.99")).toBeVisible();
  await expect(page.getByText(/约.*CNY/u)).toBeVisible();
  const outbound = page.getByRole("link", { name: "打开商家页确认" }).first();
  await expect(outbound).toHaveAttribute("href", `https://buywhere.example/out/${leadA}`);
  await expect(outbound).toHaveAttribute("rel", /sponsored/u);

  const compareButtons = page.getByRole("button", { name: "加入对比" });
  await compareButtons.nth(0).click();
  await compareButtons.nth(0).click();
  await page.getByRole("button", { name: "对比所选线索" }).click();

  await expect(page.getByText("没有重新调用报价服务", { exact: false })).toBeVisible();
  expect(receivedInputs).toEqual([
    { type: "MESSAGE", content: "Sony WH-1000XM5 headphones" },
    { type: "MESSAGE", content: "请比较第 1、2 条报价线索，不要重新查询。" },
  ]);
  await expect(page.locator("body")).not.toContainText("配送");
  await expect(page.locator("body")).not.toContainText("库存");
  await expect(page.locator("body")).not.toContainText("全网最低");
});
