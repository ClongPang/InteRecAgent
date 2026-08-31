import { expect, test, type Route } from "@playwright/test";

const conversationId = "11111111-1111-4111-8111-111111111111";
const offerA = "offer-us-headphones";
const offerB = "offer-sg-headphones";

function candidate(offerRef: string, title: string, market: "US" | "SG", amount: string) {
  return {
    offerRef,
    title,
    canonicalModel: null,
    categoryId: "headphones",
    itemRole: "PRIMARY_PRODUCT",
    condition: "NEW",
    retrievalMarket: market,
    merchant: market === "US" ? "US Audio" : "SG Audio",
    cnyAmount: amount,
    stock: "IN_STOCK",
    claimIds: [`claim-${offerRef}`],
    marketEvidenceLevel: "PROVIDER_ATTESTED",
    rankingReasonCodes: ["LEXICOGRAPHIC_RANK_VECTOR_V1"],
    ranking: {
      validationMode: "RULE_VALIDATED",
      identityResolution: "LISTING_LEVEL",
      identityKey: null,
      matchedPreferenceKeys: [],
      contradictedPreferenceKeys: [],
      rankVector: {
        eligibilityTier: 1,
        targetCoverage: 1,
        positiveCoverage: 1,
        negativeConflicts: 0,
        evidenceTier: 1,
        stockTier: 1,
        priceTieBreaker: amount,
      },
    },
  };
}

function claim(offerRef: string, renderedText: string) {
  return {
    claimId: `claim-${offerRef}`,
    kind: "PRICE",
    renderedText,
    canonicalValue: { amount: renderedText.match(/\d+/u)?.[0] ?? "0", currency: "CNY" },
    offerRefs: [offerRef],
    evidenceRefs: [{
      artifactRef: `artifact-${offerRef}`,
      source: "buywhere",
      observedAt: "2026-08-31T08:00:00.000Z",
      jsonPath: "$.price.amount",
    }],
  };
}

function projection(compared: boolean) {
  const first = candidate(offerA, "Alpha Noise Cancelling Headphones", "US", "2199");
  const second = candidate(offerB, "Beta Commuter Headphones", "SG", "2399");
  const claims = [claim(offerA, "Alpha 折合人民币约 2199 元。"), claim(offerB, "Beta 折合人民币约 2399 元。")];
  const messages = [
    {
      id: "message-user-search",
      conversationId,
      seq: 1,
      role: "USER",
      payload: { type: "MESSAGE", content: "想买降噪耳机，预算 2500 元，对比美国和新加坡" },
      consumedByTurnId: "turn-search",
      createdAt: "2026-08-31T08:00:00.000Z",
    },
    {
      id: "message-assistant-search",
      conversationId,
      seq: 2,
      role: "ASSISTANT",
      payload: {
        text: "我已完成本轮检索和证据校验。",
        envelope: {
          outcome: "RECOMMENDATION",
          addressedOpIds: ["search"],
          blocks: [
            { type: "TRANSITION", text: "我已完成本轮检索和证据校验。" },
            { type: "CLAIM", claimId: `claim-${offerA}` },
            { type: "CLAIM", claimId: `claim-${offerB}` },
          ],
          nextMoves: [],
        },
        groundedClaims: { claims },
      },
      consumedByTurnId: null,
      createdAt: "2026-08-31T08:00:01.000Z",
    },
    ...(compared ? [{
      id: "message-assistant-compare",
      conversationId,
      seq: 3,
      role: "ASSISTANT",
      payload: {
        text: "我按当前可验证证据列出对比。",
        envelope: {
          outcome: "CHAT",
          addressedOpIds: ["compare"],
          blocks: [
            { type: "TRANSITION", text: "我按当前可验证证据列出对比。" },
            { type: "COMPARISON", claimIds: [`claim-${offerA}`, `claim-${offerB}`] },
          ],
          nextMoves: [],
        },
        groundedClaims: { claims },
      },
      consumedByTurnId: null,
      createdAt: "2026-08-31T08:00:02.000Z",
    }] : []),
  ];
  const revision = compared ? 2 : 1;
  return {
    conversation: {
      id: conversationId,
      status: "OPEN",
      currentRevision: revision,
      createdAt: "2026-08-31T08:00:00.000Z",
      updatedAt: "2026-08-31T08:00:02.000Z",
    },
    activeTurn: null,
    latestTurn: {
      id: compared ? "turn-compare" : "turn-search",
      status: "COMPLETED",
      attempt: 1,
      deadlineAt: "2026-08-31T08:01:00.000Z",
      errorCode: null,
      createdAt: "2026-08-31T08:00:00.000Z",
      completedAt: "2026-08-31T08:00:02.000Z",
    },
    state: {
      revision,
      goalRevision: {
        version: revision,
        goal: {
          target: { categoryId: "headphones", targetText: "降噪耳机", canonicalModel: null, itemRole: "PRIMARY_PRODUCT", condition: "ANY" },
          budget: { amount: "2500", currency: "CNY" },
          retrievalMarkets: ["SG", "US"],
          deliveryDestination: null,
          stockPreference: "ANY",
          hardConstraints: [{ key: "noise_cancelling", operator: "EQ", value: true }],
          preferences: [],
          exclusions: [],
          unresolved: [],
        },
      },
      dialogue: {
        pendingClarification: null,
        focusOfferRef: null,
        comparisonOfferRefs: compared ? [offerA, offerB] : [],
      },
      workingSet: {
        version: revision,
        pool: [first, second],
        displayOfferRefs: [offerA, offerB],
        mentionedOfferRefs: [offerA, offerB],
        comparisonOfferRefs: compared ? [offerA, offerB] : [],
        rejectedOfferRefs: [],
        focusOfferRef: null,
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

test("completes a search-to-comparison shopping flow in the browser", async ({ page }) => {
  const receivedInputs: unknown[] = [];
  let compared = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) {
      await route.abort("aborted");
      return;
    }
    if (url.pathname === "/api/conversations" && request.method() === "POST") {
      await fulfillJson(route, { conversation: { id: conversationId } }, 201);
      return;
    }
    if (url.pathname.endsWith("/turns") && request.method() === "POST") {
      const body = request.postDataJSON() as { input: unknown };
      receivedInputs.push(body.input);
      compared = (body.input as { type?: string }).type === "SET_COMPARISON";
      await fulfillJson(route, { turn: {
        id: compared ? "turn-compare" : "turn-search",
        status: "ACCEPTED",
        attempt: 0,
        deadlineAt: "2026-08-31T08:01:00.000Z",
        errorCode: null,
        createdAt: "2026-08-31T08:00:00.000Z",
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
  await page.getByLabel("访问令牌").fill("signed-development-token");
  await page.getByRole("button", { name: "连接" }).click();
  await page.getByLabel("给推荐 Agent 发消息").fill("想买降噪耳机，预算 2500 元，对比美国和新加坡");
  await page.getByRole("button", { name: "开始对话" }).click();

  await expect(page.getByText("Alpha Noise Cancelling Headphones")).toBeVisible();
  await expect(page.getByText("Beta Commuter Headphones")).toBeVisible();
  await expect(page.getByText("预算 2500 CNY")).toBeVisible();

  const compareButtons = page.getByRole("button", { name: "加入对比" });
  await compareButtons.nth(0).click();
  await compareButtons.nth(1).click();
  await page.getByRole("button", { name: "比较所选" }).click();

  await expect(page.getByText("我按当前可验证证据列出对比。")).toBeVisible();
  expect(receivedInputs).toEqual([
    { type: "MESSAGE", content: "想买降噪耳机，预算 2500 元，对比美国和新加坡" },
    { type: "SET_COMPARISON", offerRefs: [offerA, offerB] },
  ]);
});
