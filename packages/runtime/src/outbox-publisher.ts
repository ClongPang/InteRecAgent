import type pg from "pg";

import { runtimeMetrics } from "./telemetry.js";

export interface OutboxMessage {
  id: string;
  eventId: string;
  topic: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

export interface OutboxSink {
  publish(message: OutboxMessage): Promise<void>;
}

export interface OutboxPublisherOptions {
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBaseSeconds?: number;
  topics?: string[];
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "OUTBOX_PUBLISH_FAILED";
  return text.match(/[A-Z][A-Z0-9_]{2,99}/)?.[0] ?? "OUTBOX_PUBLISH_FAILED";
}

export class PostgresOutboxPublisher {
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly retryBaseSeconds: number;
  private readonly topics: string[];

  public constructor(
    private readonly pool: pg.Pool,
    private readonly sink: OutboxSink,
    private readonly options: OutboxPublisherOptions,
  ) {
    if (!options.workerId.trim()) throw new Error("OUTBOX_WORKER_ID_REQUIRED");
    this.batchSize = options.batchSize ?? 50;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.retryBaseSeconds = options.retryBaseSeconds ?? 2;
    this.topics = options.topics?.map((topic) => topic.trim()).filter(Boolean) ?? ["conversation.events"];
    if (this.topics.length === 0) throw new Error("OUTBOX_TOPIC_REQUIRED");
  }

  public async claimBatch(): Promise<OutboxMessage[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE retail_price_agent.outbox
         SET locked_by = NULL, locked_until = NULL
         WHERE published_at IS NULL AND dead_lettered_at IS NULL
           AND locked_until <= clock_timestamp()`,
      );
      const selected = await client.query<{ id: string }>(
        `SELECT id FROM retail_price_agent.outbox
         WHERE published_at IS NULL AND dead_lettered_at IS NULL AND topic = ANY($3::text[])
           AND available_at <= clock_timestamp() AND locked_by IS NULL
           AND attempt_count < $1
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [this.maxAttempts, this.batchSize, this.topics],
      );
      const claimed: OutboxMessage[] = [];
      for (const row of selected.rows) {
        const result = await client.query<Record<string, unknown>>(
          `UPDATE retail_price_agent.outbox
           SET locked_by = $2, locked_until = clock_timestamp() + make_interval(secs => $3),
               attempt_count = attempt_count + 1
           WHERE id = $1 RETURNING *`,
          [row.id, this.options.workerId, this.leaseSeconds],
        );
        const value = result.rows[0]!;
        claimed.push({
          id: String(value["id"]),
          eventId: String(value["event_id"]),
          topic: String(value["topic"]),
          payload: value["payload"] as Record<string, unknown>,
          attemptCount: Number(value["attempt_count"]),
        });
      }
      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async runBatch(): Promise<{ published: number; failed: number; deadLettered: number }> {
    const messages = await this.claimBatch();
    let published = 0;
    let failed = 0;
    let deadLettered = 0;
    for (const message of messages) {
      try {
        await this.sink.publish(message);
        const result = await this.pool.query(
          `UPDATE retail_price_agent.outbox
           SET published_at = clock_timestamp(), locked_by = NULL, locked_until = NULL, last_error = NULL
           WHERE id = $1 AND locked_by = $2 AND published_at IS NULL AND dead_lettered_at IS NULL`,
          [message.id, this.options.workerId],
        );
        if (result.rowCount === 1) published += 1;
      } catch (error) {
        const terminal = message.attemptCount >= this.maxAttempts;
        const delay = Math.min(this.retryBaseSeconds * 2 ** Math.max(message.attemptCount - 1, 0), 300);
        const result = await this.pool.query(
          `UPDATE retail_price_agent.outbox
           SET locked_by = NULL, locked_until = NULL, last_error = $3,
               dead_lettered_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
               available_at = CASE WHEN $4 THEN available_at ELSE clock_timestamp() + make_interval(secs => $5) END
           WHERE id = $1 AND locked_by = $2 AND published_at IS NULL AND dead_lettered_at IS NULL`,
          [message.id, this.options.workerId, safeError(error), terminal, delay],
        );
        if (result.rowCount === 1) {
          if (terminal) deadLettered += 1;
          else failed += 1;
        }
      }
    }
    if (published > 0) runtimeMetrics.outboxPublished.add(published);
    if (failed > 0) runtimeMetrics.outboxFailures.add(failed);
    if (deadLettered > 0) runtimeMetrics.outboxDeadLetters.add(deadLettered);
    return { published, failed, deadLettered };
  }

  public async backlog(): Promise<{ pending: number; deadLettered: number }>{
    const result = await this.pool.query<{ pending: number; dead_lettered: number }>(
      `SELECT
         count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
         count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered
       FROM retail_price_agent.outbox`,
    );
    return { pending: result.rows[0]?.pending ?? 0, deadLettered: result.rows[0]?.dead_lettered ?? 0 };
  }
}
