import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableCallback,
  type ObservableGauge,
  type UpDownCounter,
} from "@opentelemetry/api";

export const TELEMETRY_SERVICE_VERSION = "0.2.0";

class DeferredHistogram {
  private instrument: Histogram | null = null;
  public bind(instrument: Histogram): void { this.instrument = instrument; }
  public record(value: number, attributes?: Attributes): void { this.instrument?.record(value, attributes); }
}

class DeferredCounter {
  private instrument: Counter | null = null;
  public bind(instrument: Counter): void { this.instrument = instrument; }
  public add(value: number, attributes?: Attributes): void { this.instrument?.add(value, attributes); }
}

class DeferredUpDownCounter {
  private instrument: UpDownCounter | null = null;
  public bind(instrument: UpDownCounter): void { this.instrument = instrument; }
  public add(value: number, attributes?: Attributes): void { this.instrument?.add(value, attributes); }
}

class DeferredObservableGauge {
  private instrument: ObservableGauge | null = null;
  private readonly callbacks = new Set<ObservableCallback>();
  public bind(instrument: ObservableGauge): void {
    if (this.instrument) for (const callback of this.callbacks) this.instrument.removeCallback(callback);
    this.instrument = instrument;
    for (const callback of this.callbacks) instrument.addCallback(callback);
  }
  public addCallback(callback: ObservableCallback): void {
    this.callbacks.add(callback);
    this.instrument?.addCallback(callback);
  }
  public removeCallback(callback: ObservableCallback): void {
    this.callbacks.delete(callback);
    this.instrument?.removeCallback(callback);
  }
}

export const runtimeMetrics = {
  turnDuration: new DeferredHistogram(),
  queueWait: new DeferredHistogram(),
  queueDepth: new DeferredObservableGauge(),
  apiEnqueueDuration: new DeferredHistogram(),
  apiProjectionDuration: new DeferredHistogram(),
  sseLag: new DeferredHistogram(),
  sseConnections: new DeferredUpDownCounter(),
  providerDuration: new DeferredHistogram(),
  providerErrors: new DeferredCounter(),
  candidateCacheLookups: new DeferredCounter(),
  candidateAdmissions: new DeferredCounter(),
  semanticRelevanceAttempts: new DeferredCounter(),
  clarificationDecisions: new DeferredCounter(),
  clarificationResolutions: new DeferredCounter(),
  planReviewDecisions: new DeferredCounter(),
  goalFieldRetentionChecks: new DeferredCounter(),
  answerabilityDecisions: new DeferredCounter(),
  uncertaintyMisattributions: new DeferredCounter(),
  feedbackEvents: new DeferredCounter(),
  terminalTurns: new DeferredCounter(),
  outboxPublished: new DeferredCounter(),
  outboxFailures: new DeferredCounter(),
  outboxDeadLetters: new DeferredCounter(),
  outboxBacklog: new DeferredObservableGauge(),
  fenceRejectedWrites: new DeferredCounter(),
  claimValidationFailures: new DeferredCounter(),
  safetyBlocks: new DeferredCounter(),
  evidenceBlocks: new DeferredCounter(),
  invokeAgentDuration: new DeferredHistogram(),
  inferenceCalls: new DeferredHistogram(),
  toolCalls: new DeferredHistogram(),
  telemetryLinkFailures: new DeferredCounter(),
};

export function bindRuntimeMetrics(): void {
  const meter = metrics.getMeter("interec-agent", TELEMETRY_SERVICE_VERSION);
  const instruments = {
    turnDuration: meter.createHistogram("rec_agent.turn.duration", { unit: "s" }),
    queueWait: meter.createHistogram("rec_agent.queue.wait.duration", { unit: "s" }),
    queueDepth: meter.createObservableGauge("rec_agent.queue.depth", { unit: "{turn}" }),
    apiEnqueueDuration: meter.createHistogram("rec_agent.api.enqueue.duration", { unit: "s" }),
    apiProjectionDuration: meter.createHistogram("rec_agent.api.projection.duration", { unit: "s" }),
    sseLag: meter.createHistogram("rec_agent.sse.lag.duration", { unit: "s" }),
    sseConnections: meter.createUpDownCounter("rec_agent.sse.connections", { unit: "{connection}" }),
    providerDuration: meter.createHistogram("rec_agent.provider.request.duration", { unit: "s" }),
    providerErrors: meter.createCounter("rec_agent.provider.errors", { unit: "{error}" }),
    candidateCacheLookups: meter.createCounter("rec_agent.candidate_cache.lookups", { unit: "{lookup}" }),
    candidateAdmissions: meter.createCounter("rec_agent.candidate.admissions", { unit: "{candidate}" }),
    semanticRelevanceAttempts: meter.createCounter("rec_agent.semantic_relevance.attempts", { unit: "{attempt}" }),
    clarificationDecisions: meter.createCounter("rec_agent.clarification.decisions", { unit: "{decision}" }),
    clarificationResolutions: meter.createCounter("rec_agent.clarification.resolutions", { unit: "{resolution}" }),
    planReviewDecisions: meter.createCounter("rec_agent.plan_review.decisions", { unit: "{decision}" }),
    goalFieldRetentionChecks: meter.createCounter("rec_agent.goal.retention_checks", { unit: "{check}" }),
    answerabilityDecisions: meter.createCounter("rec_agent.answerability.decisions", { unit: "{decision}" }),
    uncertaintyMisattributions: meter.createCounter("rec_agent.uncertainty.misattributions", { unit: "{violation}" }),
    feedbackEvents: meter.createCounter("rec_agent.feedback.events", { unit: "{event}" }),
    terminalTurns: meter.createCounter("rec_agent.turn.terminal", { unit: "{turn}" }),
    outboxPublished: meter.createCounter("rec_agent.outbox.published", { unit: "{message}" }),
    outboxFailures: meter.createCounter("rec_agent.outbox.failures", { unit: "{failure}" }),
    outboxDeadLetters: meter.createCounter("rec_agent.outbox.dead_letters", { unit: "{message}" }),
    outboxBacklog: meter.createObservableGauge("rec_agent.outbox.backlog", { unit: "{message}" }),
    fenceRejectedWrites: meter.createCounter("rec_agent.fence.rejected_writes", { unit: "{write}" }),
    claimValidationFailures: meter.createCounter("rec_agent.claim_validation_failures", { unit: "{failure}" }),
    safetyBlocks: meter.createCounter("rec_agent.safety_blocks", { unit: "{block}" }),
    evidenceBlocks: meter.createCounter("rec_agent.evidence_blocks", { unit: "{block}" }),
    invokeAgentDuration: meter.createHistogram("gen_ai.invoke_agent.duration", { unit: "s" }),
    inferenceCalls: meter.createHistogram("gen_ai.invoke_agent.inference_calls", { unit: "{call}" }),
    toolCalls: meter.createHistogram("gen_ai.invoke_agent.tool_calls", { unit: "{call}" }),
    telemetryLinkFailures: meter.createCounter("rec_agent.telemetry.link_failures", { unit: "{failure}" }),
  };
  for (const key of Object.keys(runtimeMetrics) as Array<keyof typeof runtimeMetrics>) {
    runtimeMetrics[key].bind(instruments[key] as never);
  }
}

