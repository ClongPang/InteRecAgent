import { randomUUID } from "node:crypto";

import type pg from "pg";

export interface ProviderCallContext {
  tenantId: string;
  turnId: string;
  attempt: number;
  fenceToken: string;
  stepKey: string;
  provider: string;
  isRetry: boolean;
}

export interface ProviderGovernorLimits {
  clusterConcurrency: number;
  tenantConcurrency: number;
  tenantRequestsPerMinute: number;
  tenantRequestsPerDay: number;
  retryBudgetPerTurn: number;
  permitSeconds: number;
  circuitFailureThreshold: number;
  circuitOpenSeconds: number;
}

const DEFAULT_LIMITS: ProviderGovernorLimits = {
  clusterConcurrency: 8,
  tenantConcurrency: 2,
  tenantRequestsPerMinute: 30,
  tenantRequestsPerDay: 500,
  retryBudgetPerTurn: 1,
  permitSeconds: 30,
  circuitFailureThreshold: 3,
  circuitOpenSeconds: 30,
};

export class ProviderGovernorError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ProviderGovernorError";
  }
}

export class PostgresProviderGovernor {
  private readonly limits: ProviderGovernorLimits;

  public constructor(private readonly pool: pg.Pool, limits: Partial<ProviderGovernorLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  public async acquire(context: ProviderCallContext): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`provider:${context.provider}`]);
      const valid = await client.query(
        `SELECT t.id
         FROM interec_agent.turns t
         JOIN interec_agent.conversations c ON c.id = t.conversation_id
         WHERE t.id = $1 AND t.attempt = $2 AND t.fence_token = $3::bigint
           AND t.status = 'RUNNING' AND t.lease_expires_at > clock_timestamp()
           AND t.deadline_at > clock_timestamp() AND c.tenant_id = $4
         FOR UPDATE OF t`,
        [context.turnId, context.attempt, context.fenceToken, context.tenantId],
      );
      if (valid.rowCount !== 1) throw new ProviderGovernorError("PROVIDER_FENCE_REJECTED");
      await client.query(
        `UPDATE interec_agent.provider_permits
         SET status = 'EXPIRED', completed_at = clock_timestamp(), error_code = 'PERMIT_EXPIRED'
         WHERE provider = $1 AND status = 'ACTIVE' AND expires_at <= clock_timestamp()`,
        [context.provider],
      );
      await client.query(
        `INSERT INTO interec_agent.provider_circuits (provider) VALUES ($1)
         ON CONFLICT (provider) DO NOTHING`,
        [context.provider],
      );
      const circuit = await client.query<{ open: boolean }>(
        `SELECT open_until IS NOT NULL AND open_until > clock_timestamp() AS open
         FROM interec_agent.provider_circuits WHERE provider = $1 FOR UPDATE`,
        [context.provider],
      );
      if (circuit.rows[0]?.open) throw new ProviderGovernorError("PROVIDER_CIRCUIT_OPEN");
      const counts = await client.query<{ cluster_active: string; tenant_active: string; minute_requests: string; day_requests: string; turn_retries: string }>(
        `SELECT
           count(*) FILTER (WHERE status = 'ACTIVE') AS cluster_active,
           count(*) FILTER (WHERE status = 'ACTIVE' AND tenant_id = $2) AS tenant_active,
           count(*) FILTER (WHERE tenant_id = $2 AND acquired_at >= clock_timestamp() - interval '1 minute') AS minute_requests,
           count(*) FILTER (WHERE tenant_id = $2 AND acquired_at >= date_trunc('day', clock_timestamp())) AS day_requests,
           count(*) FILTER (WHERE turn_id = $3 AND is_retry) AS turn_retries
         FROM interec_agent.provider_permits WHERE provider = $1`,
        [context.provider, context.tenantId, context.turnId],
      );
      const count = counts.rows[0]!;
      if (Number(count.cluster_active) >= this.limits.clusterConcurrency) throw new ProviderGovernorError("PROVIDER_BULKHEAD_FULL");
      if (Number(count.tenant_active) >= this.limits.tenantConcurrency) throw new ProviderGovernorError("TENANT_PROVIDER_CONCURRENCY_EXCEEDED");
      if (Number(count.minute_requests) >= this.limits.tenantRequestsPerMinute) throw new ProviderGovernorError("TENANT_PROVIDER_RPM_EXCEEDED");
      if (Number(count.day_requests) >= this.limits.tenantRequestsPerDay) throw new ProviderGovernorError("TENANT_PROVIDER_DAILY_QUOTA_EXCEEDED");
      if (context.isRetry && Number(count.turn_retries) >= this.limits.retryBudgetPerTurn) throw new ProviderGovernorError("PROVIDER_RETRY_BUDGET_EXHAUSTED");
      const id = randomUUID();
      await client.query(
        `INSERT INTO interec_agent.provider_permits
           (id, tenant_id, provider, turn_id, attempt, step_key, is_retry, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', clock_timestamp() + make_interval(secs => $8))`,
        [id, context.tenantId, context.provider, context.turnId, context.attempt, context.stepKey, context.isRetry, this.limits.permitSeconds],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async release(permitId: string, outcome: { success: boolean; errorCode?: string }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const permit = await client.query<{ provider: string }>(
        `UPDATE interec_agent.provider_permits
         SET status = $2, error_code = $3, completed_at = clock_timestamp()
         WHERE id = $1 AND status = 'ACTIVE' RETURNING provider`,
        [permitId, outcome.success ? "SUCCEEDED" : "FAILED", outcome.errorCode ?? null],
      );
      const provider = permit.rows[0]?.provider;
      if (provider) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`provider:${provider}`]);
        if (outcome.success) {
          await client.query(
            `UPDATE interec_agent.provider_circuits
             SET consecutive_failures = 0, open_until = NULL, updated_at = clock_timestamp()
             WHERE provider = $1`,
            [provider],
          );
        } else {
          await client.query(
            `UPDATE interec_agent.provider_circuits
             SET consecutive_failures = consecutive_failures + 1,
                 open_until = CASE WHEN consecutive_failures + 1 >= $2
                   THEN clock_timestamp() + make_interval(secs => $3) ELSE open_until END,
                 updated_at = clock_timestamp()
             WHERE provider = $1`,
            [provider, this.limits.circuitFailureThreshold, this.limits.circuitOpenSeconds],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
