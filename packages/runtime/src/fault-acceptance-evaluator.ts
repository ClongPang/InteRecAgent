export const FAULT_GROUPS = [
  "PROVIDER_ACCEPTED_BEFORE_RESPONSE",
  "PROVIDER_RETURNED_BEFORE_PERSIST",
  "STEP_PERSISTED_BEFORE_FINAL_COMMIT",
  "LEASE_TAKEOVER",
  "FINAL_TRANSACTION",
  "IDEMPOTENCY_AND_RETRY",
  "SUPERSEDE_REVISION_CONCURRENCY",
  "OUTBOX_DELIVERY",
] as const;

export type FaultGroup = typeof FAULT_GROUPS[number];
export type FaultEligibleMetric =
  | "STALE_COMMIT"
  | "CONCURRENT_CLAIM"
  | "DUPLICATE_STATE"
  | "DUPLICATE_REPLY"
  | "STEP_REUSE"
  | "TRANSACTION_RESIDUE"
  | "OUTBOX_DELIVERY"
  | "PROVIDER_CALLS";

export interface FaultManifestRow {
  faultId: string;
  faultGroup: FaultGroup;
  crashpointOrBarrier: string;
  precondition: string;
  logicalTurnId: string;
  attemptSequence: number[];
  invalidActorId: string | null;
  invalidActorCommitAttempted: boolean;
  expectedRecoveryAction: string;
  expectedTerminalState: string;
  eligibleMetrics: FaultEligibleMetric[];
  repeatIndex: number;
  schedulingSeed: number;
}

export interface FaultManifest {
  schemaVersion: "interec-fault-manifest-v1";
  mode: "DEVELOPMENT" | "SEALED";
  implementationVersion: string;
  databaseSchemaVersion: string;
  rows: FaultManifestRow[];
}

export interface FaultObservation {
  schemaVersion: "interec-fault-observation-v1";
  source: "ISOLATED_POSTGRES_PROCESS";
  faultId: string;
  implementationVersion: string;
  databaseSchemaVersion: string;
  valid: boolean;
  invalidReason: string | null;
  terminalState: string;
  recoveryCompleted: boolean;
  stateCheckPassed: boolean;
  replyCheckPassed: boolean;
  eventCheckPassed: boolean;
  sideEffectCheckPassed: boolean;
  invalidActorCommitSucceeded: boolean;
  concurrentSuccessfulClaims: number;
  formalStateRevisionCount: number;
  formalAssistantMessageCount: number;
  persistedSuccessfulStepRepeated: boolean;
  transactionResidueDetected: boolean;
  outboxDeliveryCorrect: boolean;
  providerCallsPerStep: Record<string, number>;
}

export interface FaultSafetyMetric {
  occurrences: number;
  denominator: number;
  passed: boolean;
}

export interface FaultAcceptanceReport {
  schemaVersion: "interec-fault-report-v1";
  passed: boolean;
  plannedTrials: number;
  validTrials: number;
  invalidTrials: number;
  recoveryConsistency: { numerator: number; denominator: number; value: number | null; passed: boolean };
  safety: {
    staleOrConflictingAttemptCommits: FaultSafetyMetric;
    concurrentDuplicateClaims: FaultSafetyMetric;
    duplicateStateCommits: FaultSafetyMetric;
    duplicateReplyCommits: FaultSafetyMetric;
    repeatedPersistedSteps: FaultSafetyMetric;
    transactionResidue: FaultSafetyMetric;
    outboxDeliveryFailures: FaultSafetyMetric;
  };
  providerDuplicateCalls: {
    extraCalls: number;
    affectedTrials: number;
    denominator: number;
    byGroup: Partial<Record<FaultGroup, { extraCalls: number; affectedTrials: number; denominator: number }>>;
  };
  groupResults: Record<FaultGroup, { passed: number; total: number }>;
  failures: string[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`FAULT_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`FAULT_FIELD_UNKNOWN:${path}.${key}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`FAULT_FIELD_INVALID:${path}`);
  return value.trim();
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`FAULT_FIELD_INVALID:${path}`);
  return Number(value);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`FAULT_FIELD_INVALID:${path}`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) throw new Error(`FAULT_FIELD_INVALID:${path}`);
  return value.map((entry) => entry.trim());
}

export function createDevelopmentFaultManifest(
  implementationVersion = "development",
  databaseSchemaVersion = "conversation-schema-v1",
): FaultManifest {
  const rows: FaultManifestRow[] = [];
  for (const [groupIndex, faultGroup] of FAULT_GROUPS.entries()) {
    for (let repeatIndex = 1; repeatIndex <= 10; repeatIndex += 1) {
      let crashpointOrBarrier = faultGroup.toLowerCase();
      let expectedTerminalState = "COMPLETED";
      const eligibleMetrics: FaultEligibleMetric[] = ["DUPLICATE_STATE", "DUPLICATE_REPLY", "PROVIDER_CALLS"];
      let invalidActorCommitAttempted = false;
      let invalidActorId: string | null = null;
      if (faultGroup === "STEP_PERSISTED_BEFORE_FINAL_COMMIT") eligibleMetrics.push("STEP_REUSE");
      if (faultGroup === "LEASE_TAKEOVER") {
        eligibleMetrics.push("STALE_COMMIT");
        invalidActorCommitAttempted = true;
        invalidActorId = `stale-worker-${repeatIndex}`;
      }
      if (faultGroup === "FINAL_TRANSACTION") {
        eligibleMetrics.push("TRANSACTION_RESIDUE");
        crashpointOrBarrier = repeatIndex <= 5 ? "final_transaction_before_commit" : "final_transaction_commit_ack_lost";
      }
      if (faultGroup === "SUPERSEDE_REVISION_CONCURRENCY") {
        if (repeatIndex <= 4) crashpointOrBarrier = "supersede";
        else if (repeatIndex <= 7) crashpointOrBarrier = "revision_conflict";
        else {
          crashpointOrBarrier = "concurrent_claim";
          eligibleMetrics.push("CONCURRENT_CLAIM");
        }
        if (repeatIndex <= 7) {
          eligibleMetrics.push("STALE_COMMIT");
          invalidActorCommitAttempted = true;
          invalidActorId = `conflicting-worker-${repeatIndex}`;
        }
      }
      if (faultGroup === "OUTBOX_DELIVERY") {
        eligibleMetrics.push("OUTBOX_DELIVERY");
        crashpointOrBarrier = repeatIndex <= 3
          ? "outbox_dead_letter"
          : repeatIndex <= 6
            ? "outbox_retry_then_success"
            : "outbox_sink_success_before_ack";
        if (repeatIndex <= 3) expectedTerminalState = "DEAD_LETTER";
      }
      rows.push({
        faultId: `fault-${String(groupIndex + 1).padStart(2, "0")}-${String(repeatIndex).padStart(2, "0")}`,
        faultGroup,
        crashpointOrBarrier,
        precondition: "isolated database reset and barrier armed",
        logicalTurnId: `logical-turn-${groupIndex + 1}-${repeatIndex}`,
        attemptSequence: invalidActorCommitAttempted ? [1, 2] : [1],
        invalidActorId,
        invalidActorCommitAttempted,
        expectedRecoveryAction: expectedTerminalState === "DEAD_LETTER" ? "move outbox row to dead letter" : "restart and converge to one committed result",
        expectedTerminalState,
        eligibleMetrics: [...new Set(eligibleMetrics)],
        repeatIndex,
        schedulingSeed: (groupIndex + 1) * 10_000 + repeatIndex,
      });
    }
  }
  return { schemaVersion: "interec-fault-manifest-v1", mode: "DEVELOPMENT", implementationVersion, databaseSchemaVersion, rows };
}

export function parseFaultManifest(value: unknown): FaultManifest {
  const item = record(value, "manifest");
  exactKeys(item, ["schemaVersion", "mode", "implementationVersion", "databaseSchemaVersion", "rows"], "manifest");
  if (item["schemaVersion"] !== "interec-fault-manifest-v1") throw new Error("FAULT_MANIFEST_SCHEMA_INVALID");
  if (item["mode"] !== "DEVELOPMENT" && item["mode"] !== "SEALED") throw new Error("FAULT_MANIFEST_MODE_INVALID");
  if (!Array.isArray(item["rows"])) throw new Error("FAULT_MANIFEST_ROWS_INVALID");
  const allowedMetrics = new Set<FaultEligibleMetric>(["STALE_COMMIT", "CONCURRENT_CLAIM", "DUPLICATE_STATE", "DUPLICATE_REPLY", "STEP_REUSE", "TRANSACTION_RESIDUE", "OUTBOX_DELIVERY", "PROVIDER_CALLS"]);
  const rows = item["rows"].map((value, index): FaultManifestRow => {
    const path = `manifest.rows.${index}`;
    const row = record(value, path);
    exactKeys(row, ["faultId", "faultGroup", "crashpointOrBarrier", "precondition", "logicalTurnId", "attemptSequence", "invalidActorId", "invalidActorCommitAttempted", "expectedRecoveryAction", "expectedTerminalState", "eligibleMetrics", "repeatIndex", "schedulingSeed"], path);
    const group = text(row["faultGroup"], `${path}.faultGroup`);
    if (!(FAULT_GROUPS as readonly string[]).includes(group)) throw new Error(`FAULT_GROUP_INVALID:${group}`);
    const attemptSequence = row["attemptSequence"];
    if (!Array.isArray(attemptSequence) || attemptSequence.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 1)) throw new Error(`FAULT_FIELD_INVALID:${path}.attemptSequence`);
    const invalidActorId = row["invalidActorId"];
    if (invalidActorId !== null && typeof invalidActorId !== "string") throw new Error(`FAULT_FIELD_INVALID:${path}.invalidActorId`);
    const eligibleMetrics = strings(row["eligibleMetrics"], `${path}.eligibleMetrics`);
    if (eligibleMetrics.some((metric) => !allowedMetrics.has(metric as FaultEligibleMetric))) throw new Error(`FAULT_ELIGIBILITY_INVALID:${path}`);
    return {
      faultId: text(row["faultId"], `${path}.faultId`),
      faultGroup: group as FaultGroup,
      crashpointOrBarrier: text(row["crashpointOrBarrier"], `${path}.crashpointOrBarrier`),
      precondition: text(row["precondition"], `${path}.precondition`),
      logicalTurnId: text(row["logicalTurnId"], `${path}.logicalTurnId`),
      attemptSequence: attemptSequence.map(Number),
      invalidActorId,
      invalidActorCommitAttempted: booleanValue(row["invalidActorCommitAttempted"], `${path}.invalidActorCommitAttempted`),
      expectedRecoveryAction: text(row["expectedRecoveryAction"], `${path}.expectedRecoveryAction`),
      expectedTerminalState: text(row["expectedTerminalState"], `${path}.expectedTerminalState`),
      eligibleMetrics: eligibleMetrics as FaultEligibleMetric[],
      repeatIndex: integer(row["repeatIndex"], `${path}.repeatIndex`),
      schedulingSeed: integer(row["schedulingSeed"], `${path}.schedulingSeed`),
    };
  });
  const manifest: FaultManifest = {
    schemaVersion: "interec-fault-manifest-v1",
    mode: item["mode"],
    implementationVersion: text(item["implementationVersion"], "manifest.implementationVersion"),
    databaseSchemaVersion: text(item["databaseSchemaVersion"], "manifest.databaseSchemaVersion"),
    rows,
  };
  validateFaultManifest(manifest);
  return manifest;
}

export function validateFaultManifest(manifest: FaultManifest): void {
  if (manifest.rows.length !== 80) throw new Error(`FAULT_MANIFEST_SCALE_INVALID:${manifest.rows.length}/80`);
  const ids = manifest.rows.map((row) => row.faultId);
  if (new Set(ids).size !== ids.length) throw new Error("FAULT_ID_DUPLICATE");
  const seeds = manifest.rows.map((row) => row.schedulingSeed);
  if (new Set(seeds).size !== seeds.length) throw new Error("FAULT_SCHEDULING_SEED_DUPLICATE");
  for (const row of manifest.rows) {
    if (new Set(row.eligibleMetrics).size !== row.eligibleMetrics.length) throw new Error(`FAULT_ELIGIBILITY_DUPLICATE:${row.faultId}`);
    if (new Set(row.attemptSequence).size !== row.attemptSequence.length
      || row.attemptSequence.some((attempt, index) => index > 0 && attempt <= row.attemptSequence[index - 1]!)) {
      throw new Error(`FAULT_ATTEMPT_SEQUENCE_INVALID:${row.faultId}`);
    }
    if (row.invalidActorCommitAttempted !== Boolean(row.invalidActorId)
      || (row.invalidActorCommitAttempted && !row.eligibleMetrics.includes("STALE_COMMIT"))) {
      throw new Error(`FAULT_INVALID_ACTOR_REGISTRATION_INVALID:${row.faultId}`);
    }
  }
  for (const group of FAULT_GROUPS) {
    const rows = manifest.rows.filter((row) => row.faultGroup === group);
    if (rows.length !== 10) throw new Error(`FAULT_GROUP_SCALE_INVALID:${group}:${rows.length}/10`);
    const repeats = rows.map((row) => row.repeatIndex).sort((left, right) => left - right);
    if (repeats.some((repeat, index) => repeat !== index + 1)) throw new Error(`FAULT_GROUP_REPEATS_INVALID:${group}`);
  }
  const group7 = manifest.rows.filter((row) => row.faultGroup === "SUPERSEDE_REVISION_CONCURRENCY");
  if (group7.filter((row) => row.crashpointOrBarrier === "supersede").length !== 4
    || group7.filter((row) => row.crashpointOrBarrier === "revision_conflict").length !== 3
    || group7.filter((row) => row.crashpointOrBarrier === "concurrent_claim").length !== 3) {
    throw new Error("FAULT_GROUP_7_DISTRIBUTION_INVALID");
  }
  const group5 = manifest.rows.filter((row) => row.faultGroup === "FINAL_TRANSACTION");
  if (group5.filter((row) => row.crashpointOrBarrier === "final_transaction_before_commit").length !== 5
    || group5.filter((row) => row.crashpointOrBarrier === "final_transaction_commit_ack_lost").length !== 5) {
    throw new Error("FAULT_GROUP_5_DISTRIBUTION_INVALID");
  }
  const group8 = manifest.rows.filter((row) => row.faultGroup === "OUTBOX_DELIVERY");
  if (group8.filter((row) => row.crashpointOrBarrier === "outbox_dead_letter").length !== 3
    || group8.filter((row) => row.crashpointOrBarrier === "outbox_retry_then_success").length !== 3
    || group8.filter((row) => row.crashpointOrBarrier === "outbox_sink_success_before_ack").length !== 4) {
    throw new Error("FAULT_GROUP_8_DISTRIBUTION_INVALID");
  }
}

export function parseFaultObservations(value: unknown): FaultObservation[] {
  if (!Array.isArray(value)) throw new Error("FAULT_OBSERVATIONS_ARRAY_REQUIRED");
  return value.map((value, index): FaultObservation => {
    const path = `observations.${index}`;
    const item = record(value, path);
    exactKeys(item, ["schemaVersion", "source", "faultId", "implementationVersion", "databaseSchemaVersion", "valid", "invalidReason", "terminalState", "recoveryCompleted", "stateCheckPassed", "replyCheckPassed", "eventCheckPassed", "sideEffectCheckPassed", "invalidActorCommitSucceeded", "concurrentSuccessfulClaims", "formalStateRevisionCount", "formalAssistantMessageCount", "persistedSuccessfulStepRepeated", "transactionResidueDetected", "outboxDeliveryCorrect", "providerCallsPerStep"], path);
    if (item["schemaVersion"] !== "interec-fault-observation-v1") throw new Error(`FAULT_OBSERVATION_SCHEMA_INVALID:${path}`);
    if (item["source"] !== "ISOLATED_POSTGRES_PROCESS") throw new Error(`FAULT_OBSERVATION_SOURCE_INVALID:${path}`);
    if (item["invalidReason"] !== null && typeof item["invalidReason"] !== "string") throw new Error(`FAULT_FIELD_INVALID:${path}.invalidReason`);
    const providerCallsPerStep: Record<string, number> = {};
    for (const [step, calls] of Object.entries(record(item["providerCallsPerStep"], `${path}.providerCallsPerStep`))) providerCallsPerStep[step] = integer(calls, `${path}.providerCallsPerStep.${step}`);
    return {
      schemaVersion: "interec-fault-observation-v1",
      source: "ISOLATED_POSTGRES_PROCESS",
      faultId: text(item["faultId"], `${path}.faultId`),
      implementationVersion: text(item["implementationVersion"], `${path}.implementationVersion`),
      databaseSchemaVersion: text(item["databaseSchemaVersion"], `${path}.databaseSchemaVersion`),
      valid: booleanValue(item["valid"], `${path}.valid`),
      invalidReason: item["invalidReason"],
      terminalState: text(item["terminalState"], `${path}.terminalState`),
      recoveryCompleted: booleanValue(item["recoveryCompleted"], `${path}.recoveryCompleted`),
      stateCheckPassed: booleanValue(item["stateCheckPassed"], `${path}.stateCheckPassed`),
      replyCheckPassed: booleanValue(item["replyCheckPassed"], `${path}.replyCheckPassed`),
      eventCheckPassed: booleanValue(item["eventCheckPassed"], `${path}.eventCheckPassed`),
      sideEffectCheckPassed: booleanValue(item["sideEffectCheckPassed"], `${path}.sideEffectCheckPassed`),
      invalidActorCommitSucceeded: booleanValue(item["invalidActorCommitSucceeded"], `${path}.invalidActorCommitSucceeded`),
      concurrentSuccessfulClaims: integer(item["concurrentSuccessfulClaims"], `${path}.concurrentSuccessfulClaims`),
      formalStateRevisionCount: integer(item["formalStateRevisionCount"], `${path}.formalStateRevisionCount`),
      formalAssistantMessageCount: integer(item["formalAssistantMessageCount"], `${path}.formalAssistantMessageCount`),
      persistedSuccessfulStepRepeated: booleanValue(item["persistedSuccessfulStepRepeated"], `${path}.persistedSuccessfulStepRepeated`),
      transactionResidueDetected: booleanValue(item["transactionResidueDetected"], `${path}.transactionResidueDetected`),
      outboxDeliveryCorrect: booleanValue(item["outboxDeliveryCorrect"], `${path}.outboxDeliveryCorrect`),
      providerCallsPerStep,
    };
  });
}

function safetyMetric(
  plannedRows: FaultManifestRow[],
  observedRows: Array<{ row: FaultManifestRow; observation: FaultObservation }>,
  metric: FaultEligibleMetric,
  occurs: (observation: FaultObservation) => boolean,
): FaultSafetyMetric {
  const denominator = plannedRows.filter((row) => row.eligibleMetrics.includes(metric)).length;
  const eligibleObservations = observedRows.filter(({ row }) => row.eligibleMetrics.includes(metric));
  const occurrences = eligibleObservations.filter(({ observation }) => occurs(observation)).length;
  return { occurrences, denominator, passed: denominator > 0 && eligibleObservations.length === denominator && occurrences === 0 };
}

export function evaluateFaultAcceptance(manifest: FaultManifest, observations: FaultObservation[]): FaultAcceptanceReport {
  validateFaultManifest(manifest);
  const failures: string[] = [];
  const planned = new Map(manifest.rows.map((row) => [row.faultId, row]));
  const seen = new Set<string>();
  const valid: Array<{ row: FaultManifestRow; observation: FaultObservation; trialPassed: boolean }> = [];
  let invalidTrials = 0;
  for (const observation of observations) {
    if (seen.has(observation.faultId)) {
      failures.push(`duplicate_observation:${observation.faultId}`);
      continue;
    }
    seen.add(observation.faultId);
    const row = planned.get(observation.faultId);
    if (!row) {
      failures.push(`unplanned_observation:${observation.faultId}`);
      continue;
    }
    if (observation.implementationVersion !== manifest.implementationVersion || observation.databaseSchemaVersion !== manifest.databaseSchemaVersion) {
      failures.push(`version_mismatch:${observation.faultId}`);
      continue;
    }
    if (!observation.valid) {
      invalidTrials += 1;
      failures.push(`invalid_trial:${observation.faultId}:${observation.invalidReason ?? "UNKNOWN"}`);
      continue;
    }
    const trialPassed = observation.terminalState === row.expectedTerminalState
      && observation.recoveryCompleted
      && observation.stateCheckPassed
      && observation.replyCheckPassed
      && observation.eventCheckPassed
      && observation.sideEffectCheckPassed
      && (!row.eligibleMetrics.includes("OUTBOX_DELIVERY") || observation.outboxDeliveryCorrect);
    if (!trialPassed) failures.push(`recovery_inconsistent:${observation.faultId}`);
    valid.push({ row, observation, trialPassed });
  }
  for (const faultId of planned.keys()) if (!seen.has(faultId)) failures.push(`missing_observation:${faultId}`);
  const pairs = valid.map(({ row, observation }) => ({ row, observation }));
  const safety = {
    staleOrConflictingAttemptCommits: safetyMetric(manifest.rows, pairs, "STALE_COMMIT", (observation) => observation.invalidActorCommitSucceeded),
    concurrentDuplicateClaims: safetyMetric(manifest.rows, pairs, "CONCURRENT_CLAIM", (observation) => observation.concurrentSuccessfulClaims > 1),
    duplicateStateCommits: safetyMetric(manifest.rows, pairs, "DUPLICATE_STATE", (observation) => observation.formalStateRevisionCount > 1),
    duplicateReplyCommits: safetyMetric(manifest.rows, pairs, "DUPLICATE_REPLY", (observation) => observation.formalAssistantMessageCount > 1),
    repeatedPersistedSteps: safetyMetric(manifest.rows, pairs, "STEP_REUSE", (observation) => observation.persistedSuccessfulStepRepeated),
    transactionResidue: safetyMetric(manifest.rows, pairs, "TRANSACTION_RESIDUE", (observation) => observation.transactionResidueDetected),
    outboxDeliveryFailures: safetyMetric(manifest.rows, pairs, "OUTBOX_DELIVERY", (observation) => !observation.outboxDeliveryCorrect),
  };
  for (const [name, result] of Object.entries(safety)) if (!result.passed) failures.push(`safety:${name}:${result.occurrences}/${result.denominator}`);
  const providerEligible = valid.filter(({ row }) => row.eligibleMetrics.includes("PROVIDER_CALLS"));
  const plannedProviderEligible = manifest.rows.filter((row) => row.eligibleMetrics.includes("PROVIDER_CALLS"));
  const providerDuplicateCalls = {
    extraCalls: 0,
    affectedTrials: 0,
    denominator: plannedProviderEligible.length,
    byGroup: {} as Partial<Record<FaultGroup, { extraCalls: number; affectedTrials: number; denominator: number }>>,
  };
  for (const group of FAULT_GROUPS) {
    const trials = providerEligible.filter(({ row }) => row.faultGroup === group);
    const extras = trials.map(({ observation }) => Object.values(observation.providerCallsPerStep).reduce((sum, count) => sum + Math.max(0, count - 1), 0));
    const entry = {
      extraCalls: extras.reduce((sum, value) => sum + value, 0),
      affectedTrials: extras.filter((value) => value > 0).length,
      denominator: plannedProviderEligible.filter((row) => row.faultGroup === group).length,
    };
    providerDuplicateCalls.byGroup[group] = entry;
    providerDuplicateCalls.extraCalls += entry.extraCalls;
    providerDuplicateCalls.affectedTrials += entry.affectedTrials;
  }
  const groupResults = Object.fromEntries(FAULT_GROUPS.map((group) => {
    const trials = valid.filter(({ row }) => row.faultGroup === group);
    return [group, { passed: trials.filter(({ trialPassed }) => trialPassed).length, total: manifest.rows.filter((row) => row.faultGroup === group).length }];
  })) as Record<FaultGroup, { passed: number; total: number }>;
  const consistent = valid.filter(({ trialPassed }) => trialPassed).length;
  const recoveryConsistency = { numerator: consistent, denominator: manifest.rows.length, value: manifest.rows.length > 0 ? consistent / manifest.rows.length : null, passed: consistent === 80 };
  if (!recoveryConsistency.passed) failures.push(`recovery_consistency:${consistent}/80`);
  return {
    schemaVersion: "interec-fault-report-v1",
    passed: failures.length === 0,
    plannedTrials: manifest.rows.length,
    validTrials: valid.length,
    invalidTrials,
    recoveryConsistency,
    safety,
    providerDuplicateCalls,
    groupResults,
    failures,
  };
}
