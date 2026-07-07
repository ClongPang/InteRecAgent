import { createFeedbackRequest, mockApiClient } from "./client";
import { recommendationFixture } from "../test/fixtures/chat";

test("createFeedbackRequest preserves turn and anchor context", () => {
  const request = createFeedbackRequest(
    recommendationFixture,
    "Too expensive",
    "price",
    "prod_headphones_001"
  );

  expect(request).toEqual({
    session_id: "sess_demo",
    turn_id: "turn_001",
    message: "Too expensive",
    feedback_text: "Too expensive",
    feedback_type: "price",
    anchor_product_id: "prod_headphones_001"
  });
});

test("mockApiClient returns unsupported fixture for live commerce requests", async () => {
  const response = await mockApiClient.chat({ message: "Can you buy it and check stock?" });

  expect(response.status).toBe("unsupported");
  expect(response.unsupported?.cannot_do).toContain("Checkout");
});
