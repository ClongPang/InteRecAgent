import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresProviderCallController,
  ProviderCallControlError,
  type ProviderCallContext,
} from "../src/provider-call-controller.js";

type QueryResult = { rowCount?: number | null; rows?: Array<Record<string, unknown>> };

function fakePool(handler: (sql: string, params: unknown[] | undefined) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  const release = vi.fn();
  const client = { query, release };
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, client, query, release };
}

function context(overrides: Partial<ProviderCallContext> = {}): ProviderCallContext {
  return {
    tenantId: "tenant-1",
    turnId: "turn-1",
    attempt: 2,
    fenceToken: "17",
    stepKey: "quote:lookup:buywhere",
    provider: "buywhere-quote-v2",
    isRetry: false,
    ...overrides,
  };
}

interface AcquireFixture {
  validRowCount?: number;
  circuitOpen?: boolean;
  counts?: Partial<Record<"cluster_active" | "tenant_active" | "minute_requests" | "day_requests" | "turn_retries", string>>;
}

function acquirePool(fixture: AcquireFixture = {}) {
  const counts = {
    cluster_active: "0",
    tenant_active: "0",
    minute_requests: "0",
    day_requests: "0",
    turn_retries: "0",
    ...fixture.counts,
  };
  return fakePool((sql) => {
    if (sql.includes("FROM interec_agent.turns t")) return { rowCount: fixture.validRowCount ?? 1, rows: [{ id: "turn-1" }] };
    if (sql.includes("FROM interec_agent.provider_circuits")) return { rowCount: 1, rows: [{ open: fixture.circuitOpen ?? false }] };
    if (sql.includes("FROM interec_agent.provider_permits WHERE")) return { rowCount: 1, rows: [counts] };
    return { rowCount: 1, rows: [] };
  });
}

describe("PostgresProviderCallController", () => {
  it("acquires one fenced provider permit in a transaction", async () => {
    const fixture = acquirePool();
    const controller = new PostgresProviderCallController(fixture.pool, { permitSeconds: 12 });

    const permitId = await controller.acquire(context());

    expect(permitId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.query).toHaveBeenCalledWith("BEGIN");
    expect(fixture.query).toHaveBeenCalledWith("COMMIT");
    expect(fixture.query).not.toHaveBeenCalledWith("ROLLBACK");
    const insertion = fixture.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO interec_agent.provider_permits"));
    expect(insertion?.[1]).toEqual([
      permitId,
      "tenant-1",
      "buywhere-quote-v2",
      "turn-1",
      2,
      "quote:lookup:buywhere",
      false,
      12,
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "stale fence", fixture: { validRowCount: 0 }, expected: "PROVIDER_FENCE_REJECTED", retry: false },
    { name: "open circuit", fixture: { circuitOpen: true }, expected: "PROVIDER_CIRCUIT_OPEN", retry: false },
    { name: "cluster bulkhead", fixture: { counts: { cluster_active: "8" } }, expected: "PROVIDER_BULKHEAD_FULL", retry: false },
    { name: "tenant concurrency", fixture: { counts: { tenant_active: "2" } }, expected: "TENANT_PROVIDER_CONCURRENCY_EXCEEDED", retry: false },
    { name: "minute quota", fixture: { counts: { minute_requests: "30" } }, expected: "TENANT_PROVIDER_RPM_EXCEEDED", retry: false },
    { name: "daily quota", fixture: { counts: { day_requests: "500" } }, expected: "TENANT_PROVIDER_DAILY_QUOTA_EXCEEDED", retry: false },
    { name: "turn retry budget", fixture: { counts: { turn_retries: "1" } }, expected: "PROVIDER_RETRY_BUDGET_EXHAUSTED", retry: true },
  ])("rejects $name before a network call", async ({ fixture: input, expected, retry }) => {
    const fixture = acquirePool(input);
    const controller = new PostgresProviderCallController(fixture.pool);

    const error = await controller.acquire(context({ isRetry: retry })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderCallControlError);
    expect(error).toMatchObject({ name: "ProviderCallControlError", code: expected, message: expected });
    expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fixture.query).not.toHaveBeenCalledWith("COMMIT");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each([
    { success: true, errorCode: undefined, expectedStatus: "SUCCEEDED", expectedSql: "consecutive_failures = 0" },
    { success: false, errorCode: "BUYWHERE_TIMEOUT", expectedStatus: "FAILED", expectedSql: "consecutive_failures = consecutive_failures + 1" },
  ])("releases a permit and updates circuit health for success=$success", async ({ success, errorCode, expectedStatus, expectedSql }) => {
    const fixture = fakePool((sql) => {
      if (sql.includes("UPDATE interec_agent.provider_permits")) return { rowCount: 1, rows: [{ provider: "buywhere-quote-v2" }] };
      return { rowCount: 1, rows: [] };
    });
    const controller = new PostgresProviderCallController(fixture.pool, {
      circuitFailureThreshold: 2,
      circuitOpenSeconds: 45,
    });

    await controller.release("permit-1", { success, ...(errorCode ? { errorCode } : {}) });

    expect(fixture.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE interec_agent.provider_permits"),
      ["permit-1", expectedStatus, errorCode ?? null],
    );
    expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes(expectedSql))).toBe(true);
    expect(fixture.query).toHaveBeenCalledWith("COMMIT");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("commits an idempotent no-op when the permit was already released", async () => {
    const fixture = fakePool((sql) => sql.includes("UPDATE interec_agent.provider_permits")
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [] });
    const controller = new PostgresProviderCallController(fixture.pool);

    await controller.release("already-released", { success: true });

    expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes("provider_circuits"))).toBe(false);
    expect(fixture.query).toHaveBeenCalledWith("COMMIT");
  });

  it("rolls back and releases the connection when a release transaction fails", async () => {
    const fixture = fakePool((sql) => {
      if (sql.includes("UPDATE interec_agent.provider_permits")) throw new Error("DB_UNAVAILABLE");
      return { rowCount: 1, rows: [] };
    });
    const controller = new PostgresProviderCallController(fixture.pool);

    await expect(controller.release("permit-1", { success: false })).rejects.toThrow("DB_UNAVAILABLE");
    expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
