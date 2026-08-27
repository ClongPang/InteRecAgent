export interface OperationsAcceptancePolicy {
  requiredDashboardPanelIds: number[];
  requiredAlertNames: string[];
  requiredIntegrityChecks: string[];
  maxRestoreSeconds: number;
  maxRpoSeconds: number;
  minimumApprovers: number;
}

export interface OperationsAcceptanceEvidence {
  source: "TARGET_ENVIRONMENT_OBSERVED";
  implementationVersion: string;
  environment: string;
  observedAt: string;
  metrics: {
    otlpMetricsObserved: boolean;
    dashboardPanelIds: number[];
    deliveredAlertNames: string[];
    onCallAcknowledgedBy: string;
    contentLeakChecksPassed: boolean;
  };
  rollback: {
    actualRestoreExecuted: boolean;
    snapshotId: string;
    checkpointAt: string;
    completedAt: string;
    drainSeconds: number;
    restoreSeconds: number;
    rpoSeconds: number;
    revisionBefore: number;
    revisionAfter: number;
    eventCursorBefore: number;
    eventCursorAfter: number;
    integrityChecks: string[];
    approvedBy: string[];
  };
}

export interface OperationsAcceptanceReport {
  passed: boolean;
  failures: string[];
}

export interface OperationsAcceptanceTarget {
  implementationVersion: string;
  environment: string;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`OPERATIONS_FIELD_UNEXPECTED:${path}.${unexpected[0]}`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return value.trim();
}

function countValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function countList(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return [...new Set(value as number[])];
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return value;
}

function isoDate(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`OPERATIONS_FIELD_INVALID:${path}`);
  return text;
}

export function parseOperationsAcceptancePolicy(value: unknown): OperationsAcceptancePolicy {
  const item = record(value, "policy");
  exactKeys(item, ["schemaVersion", "requiredDashboardPanelIds", "requiredAlertNames", "requiredIntegrityChecks", "maxRestoreSeconds", "maxRpoSeconds", "minimumApprovers"], "policy");
  if (item["schemaVersion"] !== 1) throw new Error("OPERATIONS_POLICY_VERSION_UNSUPPORTED");
  return {
    requiredDashboardPanelIds: countList(item["requiredDashboardPanelIds"], "policy.requiredDashboardPanelIds"),
    requiredAlertNames: stringList(item["requiredAlertNames"], "policy.requiredAlertNames"),
    requiredIntegrityChecks: stringList(item["requiredIntegrityChecks"], "policy.requiredIntegrityChecks"),
    maxRestoreSeconds: countValue(item["maxRestoreSeconds"], "policy.maxRestoreSeconds"),
    maxRpoSeconds: countValue(item["maxRpoSeconds"], "policy.maxRpoSeconds"),
    minimumApprovers: countValue(item["minimumApprovers"], "policy.minimumApprovers"),
  };
}

export function parseOperationsAcceptanceEvidence(value: unknown): OperationsAcceptanceEvidence {
  const item = record(value, "evidence");
  exactKeys(item, ["source", "implementationVersion", "environment", "observedAt", "metrics", "rollback"], "evidence");
  if (item["source"] !== "TARGET_ENVIRONMENT_OBSERVED") throw new Error("OPERATIONS_SOURCE_NOT_TARGET_OBSERVED");
  const metrics = record(item["metrics"], "evidence.metrics");
  exactKeys(metrics, ["otlpMetricsObserved", "dashboardPanelIds", "deliveredAlertNames", "onCallAcknowledgedBy", "contentLeakChecksPassed"], "evidence.metrics");
  const rollback = record(item["rollback"], "evidence.rollback");
  exactKeys(rollback, ["actualRestoreExecuted", "snapshotId", "checkpointAt", "completedAt", "drainSeconds", "restoreSeconds", "rpoSeconds", "revisionBefore", "revisionAfter", "eventCursorBefore", "eventCursorAfter", "integrityChecks", "approvedBy"], "evidence.rollback");
  return {
    source: "TARGET_ENVIRONMENT_OBSERVED",
    implementationVersion: stringValue(item["implementationVersion"], "evidence.implementationVersion"),
    environment: stringValue(item["environment"], "evidence.environment"),
    observedAt: isoDate(item["observedAt"], "evidence.observedAt"),
    metrics: {
      otlpMetricsObserved: booleanValue(metrics["otlpMetricsObserved"], "evidence.metrics.otlpMetricsObserved"),
      dashboardPanelIds: countList(metrics["dashboardPanelIds"], "evidence.metrics.dashboardPanelIds"),
      deliveredAlertNames: stringList(metrics["deliveredAlertNames"], "evidence.metrics.deliveredAlertNames"),
      onCallAcknowledgedBy: stringValue(metrics["onCallAcknowledgedBy"], "evidence.metrics.onCallAcknowledgedBy"),
      contentLeakChecksPassed: booleanValue(metrics["contentLeakChecksPassed"], "evidence.metrics.contentLeakChecksPassed"),
    },
    rollback: {
      actualRestoreExecuted: booleanValue(rollback["actualRestoreExecuted"], "evidence.rollback.actualRestoreExecuted"),
      snapshotId: stringValue(rollback["snapshotId"], "evidence.rollback.snapshotId"),
      checkpointAt: isoDate(rollback["checkpointAt"], "evidence.rollback.checkpointAt"),
      completedAt: isoDate(rollback["completedAt"], "evidence.rollback.completedAt"),
      drainSeconds: countValue(rollback["drainSeconds"], "evidence.rollback.drainSeconds"),
      restoreSeconds: countValue(rollback["restoreSeconds"], "evidence.rollback.restoreSeconds"),
      rpoSeconds: countValue(rollback["rpoSeconds"], "evidence.rollback.rpoSeconds"),
      revisionBefore: countValue(rollback["revisionBefore"], "evidence.rollback.revisionBefore"),
      revisionAfter: countValue(rollback["revisionAfter"], "evidence.rollback.revisionAfter"),
      eventCursorBefore: countValue(rollback["eventCursorBefore"], "evidence.rollback.eventCursorBefore"),
      eventCursorAfter: countValue(rollback["eventCursorAfter"], "evidence.rollback.eventCursorAfter"),
      integrityChecks: stringList(rollback["integrityChecks"], "evidence.rollback.integrityChecks"),
      approvedBy: stringList(rollback["approvedBy"], "evidence.rollback.approvedBy"),
    },
  };
}

export function evaluateOperationsAcceptance(
  evidence: OperationsAcceptanceEvidence,
  policy: OperationsAcceptancePolicy,
  target?: OperationsAcceptanceTarget,
): OperationsAcceptanceReport {
  const panels = new Set(evidence.metrics.dashboardPanelIds);
  const alerts = new Set(evidence.metrics.deliveredAlertNames);
  const checks = new Set(evidence.rollback.integrityChecks);
  const failures = [
    ...(target && evidence.implementationVersion !== target.implementationVersion ? ["unexpected_implementation_version"] : []),
    ...(target && evidence.environment !== target.environment ? ["unexpected_target_environment"] : []),
    ...(!evidence.metrics.otlpMetricsObserved ? ["otlp_metrics_not_observed"] : []),
    ...(!evidence.metrics.contentLeakChecksPassed ? ["content_leak_check_failed"] : []),
    ...policy.requiredDashboardPanelIds.filter((id) => !panels.has(id)).map((id) => `dashboard_panel_missing:${id}`),
    ...policy.requiredAlertNames.filter((name) => !alerts.has(name)).map((name) => `alert_not_delivered:${name}`),
    ...(!evidence.rollback.actualRestoreExecuted ? ["rollback_restore_not_executed"] : []),
    ...(Date.parse(evidence.rollback.completedAt) < Date.parse(evidence.rollback.checkpointAt) ? ["rollback_time_order_invalid"] : []),
    ...(evidence.rollback.restoreSeconds > policy.maxRestoreSeconds ? [`restore_seconds:${evidence.rollback.restoreSeconds}/${policy.maxRestoreSeconds}`] : []),
    ...(evidence.rollback.rpoSeconds > policy.maxRpoSeconds ? [`rpo_seconds:${evidence.rollback.rpoSeconds}/${policy.maxRpoSeconds}`] : []),
    ...(evidence.rollback.revisionAfter !== evidence.rollback.revisionBefore ? ["rollback_revision_mismatch"] : []),
    ...(evidence.rollback.eventCursorAfter !== evidence.rollback.eventCursorBefore ? ["rollback_event_cursor_mismatch"] : []),
    ...policy.requiredIntegrityChecks.filter((name) => !checks.has(name)).map((name) => `integrity_check_missing:${name}`),
    ...(evidence.rollback.approvedBy.length < policy.minimumApprovers ? [`approvers:${evidence.rollback.approvedBy.length}/${policy.minimumApprovers}`] : []),
  ];
  return { passed: failures.length === 0, failures };
}
