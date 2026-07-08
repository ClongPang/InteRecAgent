import { render, screen, within } from "@testing-library/react";
import App from "./App";
import { recommendationFixture } from "./test/fixtures/chat";

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

test.each([
  ["desktop", 1280, 900],
  ["mobile", 390, 844]
])("keeps the primary shopping workflow reachable on %s", (_label, width, height) => {
  setViewport(width, height);
  render(<App initialTurn={recommendationFixture} path="/" />);

  expect(screen.getByLabelText("Shopping workspace")).toBeInTheDocument();
  expect(screen.getByLabelText("Chat thread")).toHaveTextContent(recommendationFixture.message);
  expect(screen.getByLabelText("Recommendation results")).toHaveTextContent(
    "AeroLite Wireless Commuter Headphones"
  );
  expect(screen.getByLabelText("Agent workflow panel")).toHaveTextContent("single_item_recommendation");
  expect(screen.getByLabelText("Product comparison")).toHaveTextContent("Suggested choice");
  expect(screen.getByLabelText("Message")).toBeEnabled();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("mobile layout preserves product actions and evidence access", () => {
  setViewport(390, 844);
  render(<App initialTurn={recommendationFixture} path="/" />);

  const firstCard = screen.getByLabelText("Recommendation 1: AeroLite Wireless Commuter Headphones");
  expect(within(firstCard).getByRole("button", { name: "View evidence" })).toBeEnabled();
  expect(within(firstCard).getByRole("button", { name: "Show cheaper" })).toBeEnabled();
  expect(within(firstCard).getByRole("button", { name: "Avoid brand" })).toBeEnabled();
});
