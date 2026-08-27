import type pg from "pg";
import type { ObservableCallback, ObservableGauge } from "@opentelemetry/api";

import { runtimeMetrics } from "./telemetry.js";

export interface OperationalMetricsRegistration {
  close(): void;
}

interface OperationalGauges {
  queueDepth: Pick<ObservableGauge, "addCallback" | "removeCallback">;
  outboxBacklog: Pick<ObservableGauge, "addCallback" | "removeCallback">;
}

export function registerPostgresOperationalMetrics(
  pool: Pick<pg.Pool, "query">,
  gauges: OperationalGauges = {
    queueDepth: runtimeMetrics.queueDepth,
    outboxBacklog: runtimeMetrics.outboxBacklog,
  },
): OperationalMetricsRegistration {
  const observeQueue: ObservableCallback = async (result) => {
    try {
      const query = await pool.query<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count
         FROM interec_agent.turns
         WHERE status = ANY($1::text[])
         GROUP BY status`,
        [["ACCEPTED", "CLAIMED", "RUNNING", "COMMITTING"]],
      );
      const counts = new Map(query.rows.map((row) => [row.status, Number(row.count)]));
      for (const status of ["ACCEPTED", "CLAIMED", "RUNNING", "COMMITTING"]) {
        result.observe(counts.get(status) ?? 0, { status });
      }
    } catch {
      // A failed observation must never alter the Conversation worker.
    }
  };
  const observeOutbox: ObservableCallback = async (result) => {
    try {
      const query = await pool.query<{ pending: number; dead_lettered: number }>(
        `SELECT
           count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
           count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered
         FROM interec_agent.outbox`,
      );
      result.observe(Number(query.rows[0]?.pending ?? 0), { state: "pending" });
      result.observe(Number(query.rows[0]?.dead_lettered ?? 0), { state: "dead_lettered" });
    } catch {
      // A failed observation must never alter the Conversation worker.
    }
  };
  gauges.queueDepth.addCallback(observeQueue);
  gauges.outboxBacklog.addCallback(observeOutbox);
  return {
    close: () => {
      gauges.queueDepth.removeCallback(observeQueue);
      gauges.outboxBacklog.removeCallback(observeOutbox);
    },
  };
}
