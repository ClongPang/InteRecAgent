import { describe, expect, it } from "vitest";

import {
  createDevelopmentFaultManifest,
  evaluateFaultAcceptance,
  parseFaultManifest,
  parseFaultObservations,
  type FaultManifest,
  type FaultObservation,
} from "../src/index.js";

function observationsFor(manifest: FaultManifest): FaultObservation[] {
  return manifest.rows.map((row) => ({
    schemaVersion: "interec-fault-observation-v1",
    source: "ISOLATED_POSTGRES_PROCESS",
    faultId: row.faultId,
    implementationVersion: manifest.implementationVersion,
    databaseSchemaVersion: manifest.databaseSchemaVersion,
    valid: true,
    invalidReason: null,
    terminalState: row.expectedTerminalState,
    recoveryCompleted: true,
    stateCheckPassed: true,
    replyCheckPassed: true,
    eventCheckPassed: true,
    sideEffectCheckPassed: true,
    invalidActorCommitSucceeded: false,
    concurrentSuccessfulClaims: 1,
    formalStateRevisionCount: 1,
    formalAssistantMessageCount: 1,
    persistedSuccessfulStepRepeated: false,
    transactionResidueDetected: false,
    outboxDeliveryCorrect: true,
    providerCallsPerStep: row.faultGroup.startsWith("PROVIDER") ? { "research:market:US": 1 } : {},
  }));
}

describe("80-trial fault acceptance evaluator", () => {
  it("freezes eight groups of ten and passes a complete evidence corpus", () => {
    const manifest = createDevelopmentFaultManifest("release-a", "schema-a");
    const report = evaluateFaultAcceptance(manifest, observationsFor(manifest));
    expect(report).toMatchObject({ passed: true, plannedTrials: 80, validTrials: 80, invalidTrials: 0, recoveryConsistency: { numerator: 80, denominator: 80, value: 1, passed: true }, failures: [] });
    expect(Object.values(report.groupResults)).toEqual(Array.from({ length: 8 }, () => ({ passed: 10, total: 10 })));
  });

  it("does not average away stale commits, duplicate replies or transaction residue", () => {
    const manifest = createDevelopmentFaultManifest("release-a", "schema-a");
    const observations = observationsFor(manifest);
    observations.find((item) => item.faultId === "fault-04-01")!.invalidActorCommitSucceeded = true;
    observations.find((item) => item.faultId === "fault-06-01")!.formalAssistantMessageCount = 2;
    observations.find((item) => item.faultId === "fault-05-01")!.transactionResidueDetected = true;
    const report = evaluateFaultAcceptance(manifest, observations);
    expect(report.passed).toBe(false);
    expect(report.safety).toMatchObject({
      staleOrConflictingAttemptCommits: { occurrences: 1, passed: false },
      duplicateReplyCommits: { occurrences: 1, passed: false },
      transactionResidue: { occurrences: 1, passed: false },
    });
  });

  it("reports provider duplicate calls diagnostically without hiding affected trials", () => {
    const manifest = createDevelopmentFaultManifest("release-a", "schema-a");
    const observations = observationsFor(manifest);
    observations[0]!.providerCallsPerStep["research:market:US"] = 3;
    const report = evaluateFaultAcceptance(manifest, observations);
    expect(report.passed).toBe(true);
    expect(report.providerDuplicateCalls).toMatchObject({ extraCalls: 2, affectedTrials: 1, denominator: 80 });
  });

  it("rejects missing, invalid, mixed-version and self-reported fixture evidence", () => {
    const manifest = createDevelopmentFaultManifest("release-a", "schema-a");
    const observations = observationsFor(manifest);
    observations.pop();
    observations[0]!.valid = false;
    observations[0]!.invalidReason = "barrier_not_reached";
    observations[1]!.implementationVersion = "release-b";
    const report = evaluateFaultAcceptance(manifest, observations);
    expect(report.passed).toBe(false);
    expect(report.validTrials).toBe(77);
    expect(report.failures).toEqual(expect.arrayContaining([
      "invalid_trial:fault-01-01:barrier_not_reached",
      "version_mismatch:fault-01-02",
      "missing_observation:fault-08-10",
    ]));

    const raw = structuredClone(observations) as unknown as Array<Record<string, unknown>>;
    raw[0]!["source"] = "IN_MEMORY_SIMULATION";
    expect(() => parseFaultObservations(raw)).toThrow("FAULT_OBSERVATION_SOURCE_INVALID");
  });

  it("strictly parses the frozen manifest and rejects scale drift", () => {
    const manifest = createDevelopmentFaultManifest("release-a", "schema-a");
    expect(parseFaultManifest(JSON.parse(JSON.stringify(manifest))).rows).toHaveLength(80);
    manifest.rows.pop();
    expect(() => parseFaultManifest(manifest)).toThrow("FAULT_MANIFEST_SCALE_INVALID:79/80");
  });
});
