import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { waitForTerminationSignal } from "../src/process-lifecycle.js";

describe("process lifecycle", () => {
  it("gives graceful shutdown one signal owner and removes the losing listener", async () => {
    const source = new EventEmitter();
    const signal = waitForTerminationSignal(source);

    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(1);
    source.emit("SIGTERM");

    await expect(signal).resolves.toBe("SIGTERM");
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });
});
