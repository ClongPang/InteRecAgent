import { describe, expect, it, vi } from "vitest";

import { retryLangfuseControlPlaneRead } from "../src/langfuse-control-plane.js";

describe("Langfuse control-plane read resilience", () => {
  it("retries transport failures but not deterministic 4xx responses", async () => {
    const transient = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue("ok");
    await expect(retryLangfuseControlPlaneRead(transient, { attempts: 2, baseDelayMs: 0 })).resolves.toBe("ok");
    expect(transient).toHaveBeenCalledTimes(2);

    const invalid = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    await expect(retryLangfuseControlPlaneRead(invalid, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow("not found");
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
