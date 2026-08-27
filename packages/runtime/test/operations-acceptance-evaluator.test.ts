import { describe, expect, it } from "vitest";

import {
  evaluateOperationsAcceptance,
  parseOperationsAcceptanceEvidence,
  parseOperationsAcceptancePolicy,
  type OperationsAcceptanceEvidence,
  type OperationsAcceptancePolicy,
} from "../src/operations-acceptance-evaluator.js";

const alertNames = ["latency", "failure", "safety"];
const policy: OperationsAcceptancePolicy = {
  requiredDashboardPanelIds: [1, 2, 3],
  requiredAlertNames: alertNames,
  requiredIntegrityChecks: ["schemaChecksum", "messageLedger"],
  maxRestoreSeconds: 1800,
  maxRpoSeconds: 300,
  minimumApprovers: 2,
};
const evidence: OperationsAcceptanceEvidence = {
  source: "TARGET_ENVIRONMENT_OBSERVED",
  implementationVersion: "release-a",
  environment: "staging",
  observedAt: "2026-08-27T01:00:00.000Z",
  metrics: {
    otlpMetricsObserved: true,
    dashboardPanelIds: [1, 2, 3],
    deliveredAlertNames: alertNames,
    onCallAcknowledgedBy: "on-call-a",
    contentLeakChecksPassed: true,
  },
  rollback: {
    actualRestoreExecuted: true,
    snapshotId: "snapshot-a",
    checkpointAt: "2026-08-27T01:01:00.000Z",
    completedAt: "2026-08-27T01:10:00.000Z",
    drainSeconds: 30,
    restoreSeconds: 540,
    rpoSeconds: 120,
    revisionBefore: 12,
    revisionAfter: 12,
    eventCursorBefore: 35,
    eventCursorAfter: 35,
    integrityChecks: ["schemaChecksum", "messageLedger"],
    approvedBy: ["product-a", "operations-a"],
  },
};

describe("target operations acceptance", () => {
  it("passes only with observed dashboards, delivered alerts, on-call acknowledgement and an actual bounded restore", () => {
    expect(evaluateOperationsAcceptance(evidence, policy)).toEqual({ passed: true, failures: [] });
  });

  it("reports missing alert delivery and rollback data divergence", () => {
    const report = evaluateOperationsAcceptance({
      ...evidence,
      metrics: { ...evidence.metrics, deliveredAlertNames: ["latency"] },
      rollback: { ...evidence.rollback, revisionAfter: 11, rpoSeconds: 301, approvedBy: ["operations-a"] },
    }, policy);
    expect(report.failures).toEqual(expect.arrayContaining([
      "alert_not_delivered:failure",
      "alert_not_delivered:safety",
      "rpo_seconds:301/300",
      "rollback_revision_mismatch",
      "approvers:1/2",
    ]));
  });

  it("cannot reuse evidence from another release or environment", () => {
    expect(evaluateOperationsAcceptance(evidence, policy, { implementationVersion: "release-b", environment: "production" }).failures)
      .toEqual(expect.arrayContaining(["unexpected_implementation_version", "unexpected_target_environment"]));
  });

  it("rejects unobserved or content-bearing evidence before scoring", () => {
    expect(() => parseOperationsAcceptanceEvidence({ ...evidence, source: "SYNTHETIC" })).toThrow("OPERATIONS_SOURCE_NOT_TARGET_OBSERVED");
    expect(() => parseOperationsAcceptanceEvidence({ ...evidence, rawPrompt: "must never be stored here" })).toThrow("OPERATIONS_FIELD_UNEXPECTED:evidence.rawPrompt");
    expect(parseOperationsAcceptancePolicy({ schemaVersion: 1, ...policy })).toEqual(policy);
  });
});
