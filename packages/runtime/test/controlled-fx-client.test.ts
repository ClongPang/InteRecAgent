import type { FxSnapshot } from "@retail-price/domain";
import { describe, expect, it, vi } from "vitest";

import { ControlledFxClient } from "../src/controlled-fx-client.js";
import type { ConversationRepository, ToolReservation } from "../src/conversation-repository-types.js";
import type { FxPort } from "../src/fx-provider.js";
import type { PostgresProviderCallController } from "../src/provider-call-controller.js";

const snapshot: FxSnapshot = {
  id: "fx-1",
  base: "SGD",
  quote: "CNY",
  rate: "5.60",
  provider: "fxratesapi",
  observedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-01T01:00:00.000Z",
};

function execution(result: Record<string, unknown> | null = null): ToolReservation["execution"] {
  return {
    id: "tool-1",
    turnId: "turn-1",
    attempt: 1,
    stepKey: "quote:lookup:fx:SGD",
    requestHash: "request-hash",
    status: result ? "SUCCEEDED" : "RUNNING",
    request: { provider: "fxratesapi", base: "SGD", quote: "CNY" },
    result,
    errorCode: null,
  };
}

function harness(reservation: ToolReservation | null) {
  const repository = {
    reserveToolExecution: vi.fn(async () => reservation),
    completeToolExecution: vi.fn(async () => true),
    failToolExecution: vi.fn(async () => true),
  } as unknown as ConversationRepository;
  const source = { getRate: vi.fn(async () => snapshot) } satisfies FxPort;
  const controller = {
    acquire: vi.fn(async () => "permit-1"),
    release: vi.fn(async () => undefined),
  } as unknown as PostgresProviderCallController;
  const client = new ControlledFxClient(source, repository, controller, {
    tenantId: "tenant-1",
    turnId: "turn-1",
    attempt: 1,
    fenceToken: "9",
    operationId: "lookup",
  });
  return { client, repository, source, controller };
}

describe("ControlledFxClient", () => {
  it("reuses an idempotently completed FX observation without provider admission", async () => {
    const setup = harness({ action: "REUSE", execution: execution(snapshot as unknown as Record<string, unknown>) });

    await expect(setup.client.getRate("sgd")).resolves.toEqual(snapshot);

    expect(setup.repository.reserveToolExecution).toHaveBeenCalledWith(
      "turn-1",
      1,
      "9",
      "quote:lookup:fx:SGD",
      { provider: "fxratesapi", base: "SGD", quote: "CNY" },
    );
    expect(setup.controller.acquire).not.toHaveBeenCalled();
    expect(setup.source.getRate).not.toHaveBeenCalled();
  });

  it("returns a retryable in-progress error for a concurrent reservation", async () => {
    const setup = harness({ action: "WAIT", execution: execution() });

    const error = await setup.client.getRate("SGD").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: "FX_TOOL_IN_PROGRESS", retryable: true });
    expect(setup.controller.acquire).not.toHaveBeenCalled();
  });

  it("rejects a stale fence before acquiring a provider permit", async () => {
    const setup = harness(null);

    await expect(setup.client.getRate("SGD")).rejects.toThrow("FX_TOOL_FENCE_REJECTED");
    expect(setup.controller.acquire).not.toHaveBeenCalled();
  });

  it("persists one fresh observation before releasing a successful permit", async () => {
    const setup = harness({ action: "CALL", execution: execution() });
    const signal = new AbortController().signal;

    await expect(setup.client.getRate("sgd", signal)).resolves.toEqual(snapshot);

    expect(setup.controller.acquire).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      turnId: "turn-1",
      stepKey: "quote:lookup:fx:SGD",
      provider: "fxratesapi",
      isRetry: false,
    }));
    expect(setup.source.getRate).toHaveBeenCalledWith("SGD", signal);
    expect(setup.repository.completeToolExecution).toHaveBeenCalledWith(
      "turn-1",
      1,
      "9",
      "quote:lookup:fx:SGD",
      "request-hash",
      snapshot,
    );
    expect(setup.controller.release).toHaveBeenCalledWith("permit-1", { success: true });
    expect(setup.repository.failToolExecution).not.toHaveBeenCalled();
  });

  it("records and releases a failure when the fenced result write is rejected", async () => {
    const setup = harness({ action: "CALL", execution: execution() });
    vi.mocked(setup.repository.completeToolExecution).mockResolvedValue(false);

    await expect(setup.client.getRate("SGD")).rejects.toThrow("FX_TOOL_RESULT_FENCE_REJECTED");

    expect(setup.repository.failToolExecution).toHaveBeenCalledWith(
      "turn-1",
      1,
      "9",
      "quote:lookup:fx:SGD",
      "request-hash",
      "FX_TOOL_RESULT_FENCE_REJECTED",
    );
    expect(setup.controller.release).toHaveBeenCalledWith("permit-1", {
      success: false,
      errorCode: "FX_TOOL_RESULT_FENCE_REJECTED",
    });
  });

  it("records admission and non-Error provider failures without inventing a result", async () => {
    const admission = harness({ action: "CALL", execution: execution() });
    vi.mocked(admission.controller.acquire).mockRejectedValue(new Error("PROVIDER_CIRCUIT_OPEN"));
    await expect(admission.client.getRate("SGD")).rejects.toThrow("PROVIDER_CIRCUIT_OPEN");
    expect(admission.repository.failToolExecution).toHaveBeenCalledWith(
      "turn-1", 1, "9", "quote:lookup:fx:SGD", "request-hash", "PROVIDER_CIRCUIT_OPEN",
    );
    expect(admission.controller.release).not.toHaveBeenCalled();

    const provider = harness({ action: "CALL", execution: execution() });
    vi.mocked(provider.source.getRate).mockRejectedValue("network vanished");
    await expect(provider.client.getRate("SGD")).rejects.toBe("network vanished");
    expect(provider.repository.failToolExecution).toHaveBeenCalledWith(
      "turn-1", 1, "9", "quote:lookup:fx:SGD", "request-hash", "PROVIDER_FAILED",
    );
    expect(provider.controller.release).toHaveBeenCalledWith("permit-1", {
      success: false,
      errorCode: "PROVIDER_FAILED",
    });
  });
});
