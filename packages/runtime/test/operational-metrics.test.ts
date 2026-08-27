import { describe, expect, it, vi } from "vitest";
import type { ObservableCallback } from "@opentelemetry/api";

import { registerPostgresOperationalMetrics } from "../src/operational-metrics.js";

describe("PostgreSQL operational metrics", () => {
  it("observes every active queue state and outbox state without high-cardinality identifiers", async () => {
    let queueCallback: ObservableCallback | null = null;
    let outboxCallback: ObservableCallback | null = null;
    const queueDepth = {
      addCallback: vi.fn((callback: ObservableCallback) => { queueCallback = callback; }),
      removeCallback: vi.fn(),
    };
    const outboxBacklog = {
      addCallback: vi.fn((callback: ObservableCallback) => { outboxCallback = callback; }),
      removeCallback: vi.fn(),
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: "ACCEPTED", count: 3 }, { status: "RUNNING", count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ pending: 4, dead_lettered: 2 }] });
    const registration = registerPostgresOperationalMetrics({ query } as never, { queueDepth, outboxBacklog });
    const queueObserve = vi.fn();
    const outboxObserve = vi.fn();
    await queueCallback!({ observe: queueObserve } as never);
    await outboxCallback!({ observe: outboxObserve } as never);
    expect(queueObserve.mock.calls).toEqual([
      [3, { status: "ACCEPTED" }],
      [0, { status: "CLAIMED" }],
      [1, { status: "RUNNING" }],
      [0, { status: "COMMITTING" }],
    ]);
    expect(outboxObserve.mock.calls).toEqual([[4, { state: "pending" }], [2, { state: "dead_lettered" }]]);
    registration.close();
    expect(queueDepth.removeCallback).toHaveBeenCalledWith(queueCallback);
    expect(outboxBacklog.removeCallback).toHaveBeenCalledWith(outboxCallback);
  });

  it("isolates metric query failures from the worker", async () => {
    const callbacks: ObservableCallback[] = [];
    const gauge = { addCallback: (callback: ObservableCallback) => callbacks.push(callback), removeCallback: vi.fn() };
    registerPostgresOperationalMetrics({ query: vi.fn().mockRejectedValue(new Error("DB_METRICS_FAILED")) } as never, { queueDepth: gauge, outboxBacklog: gauge });
    await expect(Promise.all(callbacks.map((callback) => callback({ observe: vi.fn() } as never)))).resolves.toBeDefined();
  });
});
