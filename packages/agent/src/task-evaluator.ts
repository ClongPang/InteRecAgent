export const EVALUATION_FAMILIES = [
  "clarify_resume",
  "multi_market_offer_search",
  "compound_operations",
  "compare_existing",
  "market_refilter",
  "preference_rerank",
  "target_correction",
  "reject_and_undo",
  "focus_and_restart",
  "unknown_facts",
  "partial_provider_failure",
  "interrupt_and_supersede",
  "category_validation_modes",
] as const;

export type EvaluationFamily = typeof EVALUATION_FAMILIES[number];
export type EvaluationMode = "DEVELOPMENT" | "HELD_OUT";
export type MetricEligibility = "STATE" | "REFERENT" | "OPERATIONS" | "CANDIDATE" | "FACT";

export interface OperationPredicate {
  kind: string;
  params?: Record<string, unknown>;
  resolvedOfferRefs?: string[];
}

export interface ExpectedReferent {
  operationKind: string;
  offerRefs: string[];
}

export interface ProviderBudget {
  min: number;
  max: number;
}

export interface ListingEligibilityLabel {
  offerRef: string;
  qualified: boolean;
  resultLevel: "RECOMMENDATION" | "SEARCH_RESULTS" | "REJECT";
}

export interface SourceFieldReferenceLabel {
  sourceFactRef: string;
  offerRef: string;
  predicate: string;
  normalizedValue: unknown;
  unitOrCurrency: string | null;
  evidenceScope: string;
}

export interface RequiredResponseField {
  offerRef: string;
  predicate: string;
  normalizedValue: unknown;
  unitOrCurrency: string | null;
  evidenceScope: string;
}

export interface EvaluationTurnSpec {
  turnIndex: number;
  userInput: string;
  expectedGoal: Record<string, unknown>;
  forbiddenGoalPaths: string[];
  requiredOperations: OperationPredicate[];
  forbiddenOperations: OperationPredicate[];
  expectedReferents: ExpectedReferent[];
  providerBudgets: Record<string, ProviderBudget>;
  allowedOutcomes: string[];
  requiredCandidateRefs: string[];
  requiredAnswerSlots: string[];
  requiredResponseFields: RequiredResponseField[];
  expectedTerminalStates: string[];
}

export interface EvaluationTaskSpec {
  schemaVersion: "interec-eval-task-v1";
  taskId: string;
  family: EvaluationFamily;
  fixtureVersion: string;
  fixtureHasQualifiedOffer: boolean;
  requiresQualifiedOutput: boolean;
  metricEligibility: MetricEligibility[];
  turns: EvaluationTurnSpec[];
  listingEligibilityLabels: ListingEligibilityLabel[];
  sourceFieldReferenceLabels: SourceFieldReferenceLabel[];
}

export interface PlannedTrial {
  trialId: string;
  taskId: string;
  runIndex: 1 | 2 | 3;
}

export interface EvaluationManifest {
  schemaVersion: "interec-eval-manifest-v1";
  mode: EvaluationMode;
  implementationVersion: string;
  modelId: string;
  modelParametersHash: string;
  promptVersion: string;
  evaluatorVersion: string;
  fixtureVersion: string;
  tasks: EvaluationTaskSpec[];
  trials: PlannedTrial[];
}

export interface ActualOperation {
  kind: string;
  params: Record<string, unknown>;
  resolvedOfferRefs: string[];
  status: string;
}

export interface ActualFact {
  offerRef: string;
  predicate: string;
  normalizedValue: unknown;
  unitOrCurrency: string | null;
  evidenceScope: string;
  evidenceSourceFactRefs: string[];
  userVisible: boolean;
}

export interface EvaluationTurnArtifact {
  turnIndex: number;
  goal: Record<string, unknown>;
  operations: ActualOperation[];
  providerCalls: Record<string, number>;
  outcome: string;
  recommendedOfferRefs: string[];
  answeredSlots: string[];
  facts: ActualFact[];
  unannotatedUserVisibleFactCount: number;
  terminalState: string;
}

export interface EvaluationTrialArtifact {
  schemaVersion: "interec-eval-trial-v1";
  trialId: string;
  taskId: string;
  runIndex: 1 | 2 | 3;
  status: "VALID" | "INVALID";
  invalidReason: string | null;
  implementationVersion: string;
  modelId: string;
  modelParametersHash: string;
  promptVersion: string;
  evaluatorVersion: string;
  fixtureVersion: string;
  replayOrLive: "REPLAY" | "LIVE";
  turns: EvaluationTurnArtifact[];
}

export interface MetricResult {
  numerator: number;
  denominator: number;
  value: number | null;
  threshold: number;
  passed: boolean;
}

export interface TrialEvaluation {
  trialId: string;
  taskId: string;
  runIndex: number;
  success: boolean;
  failures: string[];
  counts: {
    expectedOperations: number;
    matchedOperations: number;
    expectedReferents: number;
    matchedReferents: number;
    recommendedCandidates: number;
    qualifiedRecommendedCandidates: number;
    visibleFacts: number;
    evidenceConsistentFacts: number;
    expectedAnswerSlots: number;
    answeredRequiredSlots: number;
    forbiddenOperations: number;
  };
  stateEligible: boolean;
  stateCorrect: boolean;
  positiveOutputEligible: boolean;
  positiveOutputCorrect: boolean;
}

export interface EvaluationReport {
  schemaVersion: "interec-eval-report-v1";
  mode: EvaluationMode;
  implementationVersion: string;
  modelId: string;
  modelParametersHash: string;
  promptVersion: string;
  evaluatorVersion: string;
  fixtureVersion: string;
  passed: boolean;
  plannedTrialCount: number;
  validTrialCount: number;
  invalidTrialCount: number;
  taskCount: number;
  stableTaskCount: number;
  metrics: {
    endToEndTaskSuccess: MetricResult;
    threeRunStability: MetricResult;
    multiTurnConstraintState: MetricResult;
    candidateReferentAccuracy: MetricResult;
    requiredOperationCoverage: MetricResult;
    requiredAnswerRecall: MetricResult;
    positiveOutputRate: MetricResult;
    recommendationPrecision: MetricResult;
    factEvidenceConsistency: MetricResult;
  };
  counts: {
    forbiddenOperations: number;
    wrongCandidateRecommendations: number;
    inconsistentFacts: number;
  };
  familyStableTasks: Partial<Record<EvaluationFamily, { stable: number; total: number; passed: boolean }>>;
  trials: TrialEvaluation[];
  failures: string[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`EVAL_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`EVAL_FIELD_INVALID:${path}`);
  return value.trim();
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`EVAL_FIELD_INVALID:${path}`);
  return value.map((item) => item.trim());
}

function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`EVAL_FIELD_INVALID:${path}`);
  return Number(value);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`EVAL_FIELD_INVALID:${path}`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`EVAL_FIELD_UNKNOWN:${path}.${key}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equal(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function subset(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(expectedRecord).every(([key, value]) => Object.hasOwn(actualRecord, key) && subset(value, actualRecord[key]));
  }
  return equal(expected, actual);
}

function pathValue(value: Record<string, unknown>, path: string): { exists: boolean; value: unknown } {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function clonedJsonValue(value: unknown, path: string): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`EVAL_FIELD_INVALID:${path}`);
  }
  try {
    return structuredClone(value);
  } catch {
    throw new Error(`EVAL_FIELD_INVALID:${path}`);
  }
}

function matchesOperation(predicate: OperationPredicate, operation: ActualOperation): boolean {
  if (predicate.kind !== operation.kind) return false;
  if (predicate.params && !subset(predicate.params, operation.params)) return false;
  if (predicate.resolvedOfferRefs && !sameSet(predicate.resolvedOfferRefs, operation.resolvedOfferRefs)) return false;
  return operation.status === "APPLIED" || operation.status === "SUCCEEDED";
}

function matchOneToOne(expected: readonly OperationPredicate[], actual: readonly ActualOperation[]): number {
  const used = new Set<number>();
  let matched = 0;
  for (const predicate of expected) {
    const index = actual.findIndex((operation, candidateIndex) => !used.has(candidateIndex) && matchesOperation(predicate, operation));
    if (index >= 0) {
      used.add(index);
      matched += 1;
    }
  }
  return matched;
}

function metric(numerator: number, denominator: number, threshold: number): MetricResult {
  const value = denominator > 0 ? numerator / denominator : null;
  return { numerator, denominator, value, threshold, passed: value !== null && value >= threshold };
}

function parseOperationPredicate(value: unknown, path: string): OperationPredicate {
  const item = record(value, path);
  exactKeys(item, ["kind", "params", "resolvedOfferRefs"], path);
  return {
    kind: stringValue(item["kind"], `${path}.kind`),
    ...(item["params"] === undefined ? {} : { params: record(item["params"], `${path}.params`) }),
    ...(item["resolvedOfferRefs"] === undefined ? {} : { resolvedOfferRefs: stringArray(item["resolvedOfferRefs"], `${path}.resolvedOfferRefs`) }),
  };
}

function parseRequiredResponseField(value: unknown, path: string): RequiredResponseField {
  const item = record(value, path);
  exactKeys(item, ["offerRef", "predicate", "normalizedValue", "unitOrCurrency", "evidenceScope"], path);
  const unit = item["unitOrCurrency"];
  if (unit !== null && typeof unit !== "string") throw new Error(`EVAL_FIELD_INVALID:${path}.unitOrCurrency`);
  return {
    offerRef: stringValue(item["offerRef"], `${path}.offerRef`),
    predicate: stringValue(item["predicate"], `${path}.predicate`),
    normalizedValue: clonedJsonValue(item["normalizedValue"], `${path}.normalizedValue`),
    unitOrCurrency: unit,
    evidenceScope: stringValue(item["evidenceScope"], `${path}.evidenceScope`),
  };
}

function parseTask(value: unknown, path: string): EvaluationTaskSpec {
  const item = record(value, path);
  exactKeys(item, ["schemaVersion", "taskId", "family", "fixtureVersion", "fixtureHasQualifiedOffer", "requiresQualifiedOutput", "metricEligibility", "turns", "listingEligibilityLabels", "sourceFieldReferenceLabels"], path);
  if (item["schemaVersion"] !== "interec-eval-task-v1") throw new Error(`EVAL_SCHEMA_INVALID:${path}.schemaVersion`);
  const family = stringValue(item["family"], `${path}.family`);
  if (!(EVALUATION_FAMILIES as readonly string[]).includes(family)) throw new Error(`EVAL_FAMILY_INVALID:${family}`);
  const eligibility = stringArray(item["metricEligibility"], `${path}.metricEligibility`);
  const allowedEligibility = new Set<MetricEligibility>(["STATE", "REFERENT", "OPERATIONS", "CANDIDATE", "FACT"]);
  if (eligibility.some((entry) => !allowedEligibility.has(entry as MetricEligibility))) throw new Error(`EVAL_ELIGIBILITY_INVALID:${path}`);
  if (!Array.isArray(item["turns"]) || item["turns"].length < 2 || item["turns"].length > 4) throw new Error(`EVAL_TURNS_INVALID:${path}`);
  const turns = item["turns"].map((turn, index) => {
    const turnItem = record(turn, `${path}.turns.${index}`);
    exactKeys(turnItem, ["turnIndex", "userInput", "expectedGoal", "forbiddenGoalPaths", "requiredOperations", "forbiddenOperations", "expectedReferents", "providerBudgets", "allowedOutcomes", "requiredCandidateRefs", "requiredAnswerSlots", "requiredResponseFields", "expectedTerminalStates"], `${path}.turns.${index}`);
    const providerBudgets: Record<string, ProviderBudget> = {};
    for (const [provider, rawBudget] of Object.entries(record(turnItem["providerBudgets"], `${path}.turns.${index}.providerBudgets`))) {
      const budget = record(rawBudget, `${path}.turns.${index}.providerBudgets.${provider}`);
      exactKeys(budget, ["min", "max"], `${path}.turns.${index}.providerBudgets.${provider}`);
      const min = count(budget["min"], `${path}.turns.${index}.providerBudgets.${provider}.min`);
      const max = count(budget["max"], `${path}.turns.${index}.providerBudgets.${provider}.max`);
      if (max < min) throw new Error(`EVAL_PROVIDER_BUDGET_INVALID:${path}.turns.${index}.${provider}`);
      providerBudgets[provider] = { min, max };
    }
    const referentsRaw = turnItem["expectedReferents"];
    if (!Array.isArray(referentsRaw)) throw new Error(`EVAL_FIELD_INVALID:${path}.turns.${index}.expectedReferents`);
    const expectedReferents = referentsRaw.map((entry, referentIndex) => {
      const referent = record(entry, `${path}.turns.${index}.expectedReferents.${referentIndex}`);
      exactKeys(referent, ["operationKind", "offerRefs"], `${path}.turns.${index}.expectedReferents.${referentIndex}`);
      return { operationKind: stringValue(referent["operationKind"], `${path}.turns.${index}.expectedReferents.${referentIndex}.operationKind`), offerRefs: stringArray(referent["offerRefs"], `${path}.turns.${index}.expectedReferents.${referentIndex}.offerRefs`) };
    });
    const requiredOperations = turnItem["requiredOperations"];
    const forbiddenOperations = turnItem["forbiddenOperations"];
    const requiredResponseFields = turnItem["requiredResponseFields"];
    if (!Array.isArray(requiredOperations) || !Array.isArray(forbiddenOperations) || !Array.isArray(requiredResponseFields)) throw new Error(`EVAL_FIELD_INVALID:${path}.turns.${index}`);
    return {
      turnIndex: count(turnItem["turnIndex"], `${path}.turns.${index}.turnIndex`),
      userInput: stringValue(turnItem["userInput"], `${path}.turns.${index}.userInput`),
      expectedGoal: record(turnItem["expectedGoal"], `${path}.turns.${index}.expectedGoal`),
      forbiddenGoalPaths: stringArray(turnItem["forbiddenGoalPaths"], `${path}.turns.${index}.forbiddenGoalPaths`),
      requiredOperations: requiredOperations.map((operation, operationIndex) => parseOperationPredicate(operation, `${path}.turns.${index}.requiredOperations.${operationIndex}`)),
      forbiddenOperations: forbiddenOperations.map((operation, operationIndex) => parseOperationPredicate(operation, `${path}.turns.${index}.forbiddenOperations.${operationIndex}`)),
      expectedReferents,
      providerBudgets,
      allowedOutcomes: stringArray(turnItem["allowedOutcomes"], `${path}.turns.${index}.allowedOutcomes`),
      requiredCandidateRefs: stringArray(turnItem["requiredCandidateRefs"], `${path}.turns.${index}.requiredCandidateRefs`),
      requiredAnswerSlots: stringArray(turnItem["requiredAnswerSlots"], `${path}.turns.${index}.requiredAnswerSlots`),
      requiredResponseFields: requiredResponseFields.map((fact, factIndex) => parseRequiredResponseField(fact, `${path}.turns.${index}.requiredResponseFields.${factIndex}`)),
      expectedTerminalStates: stringArray(turnItem["expectedTerminalStates"], `${path}.turns.${index}.expectedTerminalStates`),
    };
  });
  const listingsRaw = item["listingEligibilityLabels"];
  const sourceFactsRaw = item["sourceFieldReferenceLabels"];
  if (!Array.isArray(listingsRaw) || !Array.isArray(sourceFactsRaw)) throw new Error(`EVAL_FIELD_INVALID:${path}.independentGold`);
  const listingEligibilityLabels = listingsRaw.map((entry, index) => {
    const listing = record(entry, `${path}.listingEligibilityLabels.${index}`);
    exactKeys(listing, ["offerRef", "qualified", "resultLevel"], `${path}.listingEligibilityLabels.${index}`);
    const resultLevel = stringValue(listing["resultLevel"], `${path}.listingEligibilityLabels.${index}.resultLevel`);
    if (!(new Set<string>(["RECOMMENDATION", "SEARCH_RESULTS", "REJECT"])).has(resultLevel)) throw new Error(`EVAL_RESULT_LEVEL_INVALID:${resultLevel}`);
    return { offerRef: stringValue(listing["offerRef"], `${path}.listingEligibilityLabels.${index}.offerRef`), qualified: booleanValue(listing["qualified"], `${path}.listingEligibilityLabels.${index}.qualified`), resultLevel: resultLevel as ListingEligibilityLabel["resultLevel"] };
  });
  const sourceFieldReferenceLabels = sourceFactsRaw.map((entry, index) => {
    const fact = record(entry, `${path}.sourceFieldReferenceLabels.${index}`);
    exactKeys(fact, ["sourceFactRef", "offerRef", "predicate", "normalizedValue", "unitOrCurrency", "evidenceScope"], `${path}.sourceFieldReferenceLabels.${index}`);
    const parsed = parseRequiredResponseField({ offerRef: fact["offerRef"], predicate: fact["predicate"], normalizedValue: fact["normalizedValue"], unitOrCurrency: fact["unitOrCurrency"], evidenceScope: fact["evidenceScope"] }, `${path}.sourceFieldReferenceLabels.${index}.value`);
    return { sourceFactRef: stringValue(fact["sourceFactRef"], `${path}.sourceFieldReferenceLabels.${index}.sourceFactRef`), ...parsed };
  });
  const listingRefs = listingEligibilityLabels.map((listing) => listing.offerRef);
  if (new Set(listingRefs).size !== listingRefs.length) throw new Error(`EVAL_LISTING_GOLD_DUPLICATE:${path}`);
  const sourceFactRefs = sourceFieldReferenceLabels.map((fact) => fact.sourceFactRef);
  if (new Set(sourceFactRefs).size !== sourceFactRefs.length) throw new Error(`EVAL_SOURCE_FACT_GOLD_DUPLICATE:${path}`);
  if (sourceFieldReferenceLabels.some((fact) => !listingRefs.includes(fact.offerRef))) throw new Error(`EVAL_SOURCE_FACT_OFFER_UNKNOWN:${path}`);
  return {
    schemaVersion: "interec-eval-task-v1",
    taskId: stringValue(item["taskId"], `${path}.taskId`),
    family: family as EvaluationFamily,
    fixtureVersion: stringValue(item["fixtureVersion"], `${path}.fixtureVersion`),
    fixtureHasQualifiedOffer: booleanValue(item["fixtureHasQualifiedOffer"], `${path}.fixtureHasQualifiedOffer`),
    requiresQualifiedOutput: booleanValue(item["requiresQualifiedOutput"], `${path}.requiresQualifiedOutput`),
    metricEligibility: eligibility as MetricEligibility[],
    turns,
    listingEligibilityLabels,
    sourceFieldReferenceLabels,
  };
}

export function parseEvaluationManifest(value: unknown): EvaluationManifest {
  const item = record(value, "manifest");
  exactKeys(item, ["schemaVersion", "mode", "implementationVersion", "modelId", "modelParametersHash", "promptVersion", "evaluatorVersion", "fixtureVersion", "tasks", "trials"], "manifest");
  if (item["schemaVersion"] !== "interec-eval-manifest-v1") throw new Error("EVAL_MANIFEST_SCHEMA_INVALID");
  const mode = item["mode"];
  if (mode !== "DEVELOPMENT" && mode !== "HELD_OUT") throw new Error("EVAL_MANIFEST_MODE_INVALID");
  if (!Array.isArray(item["tasks"]) || !Array.isArray(item["trials"])) throw new Error("EVAL_MANIFEST_COLLECTION_INVALID");
  const tasks = item["tasks"].map((task, index) => parseTask(task, `manifest.tasks.${index}`));
  const trials = item["trials"].map((trial, index) => {
    const trialItem = record(trial, `manifest.trials.${index}`);
    exactKeys(trialItem, ["trialId", "taskId", "runIndex"], `manifest.trials.${index}`);
    const runIndex = count(trialItem["runIndex"], `manifest.trials.${index}.runIndex`);
    if (runIndex < 1 || runIndex > 3) throw new Error(`EVAL_RUN_INDEX_INVALID:${runIndex}`);
    return { trialId: stringValue(trialItem["trialId"], `manifest.trials.${index}.trialId`), taskId: stringValue(trialItem["taskId"], `manifest.trials.${index}.taskId`), runIndex: runIndex as 1 | 2 | 3 };
  });
  const manifest: EvaluationManifest = {
    schemaVersion: "interec-eval-manifest-v1",
    mode,
    implementationVersion: stringValue(item["implementationVersion"], "manifest.implementationVersion"),
    modelId: stringValue(item["modelId"], "manifest.modelId"),
    modelParametersHash: stringValue(item["modelParametersHash"], "manifest.modelParametersHash"),
    promptVersion: stringValue(item["promptVersion"], "manifest.promptVersion"),
    evaluatorVersion: stringValue(item["evaluatorVersion"], "manifest.evaluatorVersion"),
    fixtureVersion: stringValue(item["fixtureVersion"], "manifest.fixtureVersion"),
    tasks,
    trials,
  };
  validateEvaluationManifest(manifest);
  return manifest;
}

export function validateEvaluationManifest(manifest: EvaluationManifest): void {
  const taskIds = new Set<string>();
  for (const task of manifest.tasks) {
    if (taskIds.has(task.taskId)) throw new Error(`EVAL_TASK_DUPLICATE:${task.taskId}`);
    taskIds.add(task.taskId);
    if (task.fixtureVersion !== manifest.fixtureVersion) throw new Error(`EVAL_FIXTURE_VERSION_MISMATCH:${task.taskId}`);
    const indexes = task.turns.map((turn) => turn.turnIndex);
    if (new Set(indexes).size !== indexes.length || indexes.some((index, position) => index !== position + 1)) throw new Error(`EVAL_TURN_INDEX_INVALID:${task.taskId}`);
  }
  const trialIds = new Set<string>();
  const taskRuns = new Map<string, Set<number>>();
  for (const trial of manifest.trials) {
    if (trialIds.has(trial.trialId)) throw new Error(`EVAL_TRIAL_DUPLICATE:${trial.trialId}`);
    trialIds.add(trial.trialId);
    if (!taskIds.has(trial.taskId)) throw new Error(`EVAL_TRIAL_TASK_UNKNOWN:${trial.taskId}`);
    const runs = taskRuns.get(trial.taskId) ?? new Set<number>();
    if (runs.has(trial.runIndex)) throw new Error(`EVAL_TASK_RUN_DUPLICATE:${trial.taskId}:${trial.runIndex}`);
    runs.add(trial.runIndex);
    taskRuns.set(trial.taskId, runs);
  }
  for (const task of manifest.tasks) {
    const runs = taskRuns.get(task.taskId) ?? new Set<number>();
    if (runs.size !== 3 || ![1, 2, 3].every((runIndex) => runs.has(runIndex))) throw new Error(`EVAL_TASK_RUNS_INCOMPLETE:${task.taskId}`);
  }
  if (manifest.mode === "DEVELOPMENT") {
    if (manifest.tasks.length < 2) throw new Error("EVAL_DEVELOPMENT_TASK_COUNT_MIN:2");
    if (!manifest.tasks.some((task) => task.requiresQualifiedOutput) || !manifest.tasks.some((task) => !task.fixtureHasQualifiedOffer)) throw new Error("EVAL_DEVELOPMENT_NEEDS_POSITIVE_AND_NEGATIVE");
    return;
  }
  if (manifest.tasks.length !== 39 || manifest.trials.length !== 117) throw new Error(`EVAL_HELD_OUT_SCALE_INVALID:${manifest.tasks.length}:${manifest.trials.length}`);
  for (const family of EVALUATION_FAMILIES) {
    const countForFamily = manifest.tasks.filter((task) => task.family === family).length;
    if (countForFamily !== 3) throw new Error(`EVAL_HELD_OUT_FAMILY_COUNT:${family}:${countForFamily}`);
  }
  const positiveTasks = manifest.tasks.filter((task) => task.fixtureHasQualifiedOffer && task.requiresQualifiedOutput);
  if (positiveTasks.length < 18) throw new Error(`EVAL_POSITIVE_TASK_COUNT:${positiveTasks.length}/18`);
  const plannedPositiveFacts = positiveTasks.reduce((sum, task) => {
    const uniqueFacts = new Set(task.turns.flatMap((turn) => turn.requiredResponseFields.map(factKey)));
    return sum + uniqueFacts.size * 3;
  }, 0);
  if (plannedPositiveFacts < 108) throw new Error(`EVAL_FACT_DENOMINATOR:${plannedPositiveFacts}/108`);
}

function parseActualFact(value: unknown, path: string): ActualFact {
  const item = record(value, path);
  exactKeys(item, ["offerRef", "predicate", "normalizedValue", "unitOrCurrency", "evidenceScope", "evidenceSourceFactRefs", "userVisible"], path);
  const unit = item["unitOrCurrency"];
  if (unit !== null && typeof unit !== "string") throw new Error(`EVAL_FIELD_INVALID:${path}.unitOrCurrency`);
  return {
    offerRef: stringValue(item["offerRef"], `${path}.offerRef`),
    predicate: stringValue(item["predicate"], `${path}.predicate`),
    normalizedValue: clonedJsonValue(item["normalizedValue"], `${path}.normalizedValue`),
    unitOrCurrency: unit,
    evidenceScope: stringValue(item["evidenceScope"], `${path}.evidenceScope`),
    evidenceSourceFactRefs: stringArray(item["evidenceSourceFactRefs"], `${path}.evidenceSourceFactRefs`),
    userVisible: booleanValue(item["userVisible"], `${path}.userVisible`),
  };
}

function parseTrial(value: unknown, path: string): EvaluationTrialArtifact {
  const item = record(value, path);
  exactKeys(item, ["schemaVersion", "trialId", "taskId", "runIndex", "status", "invalidReason", "implementationVersion", "modelId", "modelParametersHash", "promptVersion", "evaluatorVersion", "fixtureVersion", "replayOrLive", "turns"], path);
  if (item["schemaVersion"] !== "interec-eval-trial-v1") throw new Error(`EVAL_TRIAL_SCHEMA_INVALID:${path}`);
  const runIndex = count(item["runIndex"], `${path}.runIndex`);
  if (runIndex < 1 || runIndex > 3) throw new Error(`EVAL_RUN_INDEX_INVALID:${runIndex}`);
  if (item["status"] !== "VALID" && item["status"] !== "INVALID") throw new Error(`EVAL_TRIAL_STATUS_INVALID:${path}`);
  if (item["invalidReason"] !== null && typeof item["invalidReason"] !== "string") throw new Error(`EVAL_FIELD_INVALID:${path}.invalidReason`);
  if (item["status"] === "VALID" && item["invalidReason"] !== null) throw new Error(`EVAL_TRIAL_INVALID_REASON_UNEXPECTED:${path}`);
  if (item["status"] === "INVALID" && (typeof item["invalidReason"] !== "string" || item["invalidReason"].trim() === "")) throw new Error(`EVAL_TRIAL_INVALID_REASON_REQUIRED:${path}`);
  if (item["replayOrLive"] !== "REPLAY" && item["replayOrLive"] !== "LIVE") throw new Error(`EVAL_TRIAL_ENV_INVALID:${path}`);
  if (!Array.isArray(item["turns"])) throw new Error(`EVAL_FIELD_INVALID:${path}.turns`);
  const turns = item["turns"].map((turn, index) => {
    const turnItem = record(turn, `${path}.turns.${index}`);
    exactKeys(turnItem, ["turnIndex", "goal", "operations", "providerCalls", "outcome", "recommendedOfferRefs", "answeredSlots", "facts", "unannotatedUserVisibleFactCount", "terminalState"], `${path}.turns.${index}`);
    if (!Array.isArray(turnItem["operations"]) || !Array.isArray(turnItem["facts"])) throw new Error(`EVAL_FIELD_INVALID:${path}.turns.${index}`);
    const operations = turnItem["operations"].map((operation, operationIndex) => {
      const operationItem = record(operation, `${path}.turns.${index}.operations.${operationIndex}`);
      exactKeys(operationItem, ["kind", "params", "resolvedOfferRefs", "status"], `${path}.turns.${index}.operations.${operationIndex}`);
      return { kind: stringValue(operationItem["kind"], `${path}.turns.${index}.operations.${operationIndex}.kind`), params: record(operationItem["params"], `${path}.turns.${index}.operations.${operationIndex}.params`), resolvedOfferRefs: stringArray(operationItem["resolvedOfferRefs"], `${path}.turns.${index}.operations.${operationIndex}.resolvedOfferRefs`), status: stringValue(operationItem["status"], `${path}.turns.${index}.operations.${operationIndex}.status`) };
    });
    const providerCalls: Record<string, number> = {};
    for (const [provider, rawCount] of Object.entries(record(turnItem["providerCalls"], `${path}.turns.${index}.providerCalls`))) providerCalls[provider] = count(rawCount, `${path}.turns.${index}.providerCalls.${provider}`);
    return {
      turnIndex: count(turnItem["turnIndex"], `${path}.turns.${index}.turnIndex`),
      goal: record(turnItem["goal"], `${path}.turns.${index}.goal`),
      operations,
      providerCalls,
      outcome: stringValue(turnItem["outcome"], `${path}.turns.${index}.outcome`),
      recommendedOfferRefs: stringArray(turnItem["recommendedOfferRefs"], `${path}.turns.${index}.recommendedOfferRefs`),
      answeredSlots: stringArray(turnItem["answeredSlots"], `${path}.turns.${index}.answeredSlots`),
      facts: turnItem["facts"].map((fact, factIndex) => parseActualFact(fact, `${path}.turns.${index}.facts.${factIndex}`)),
      unannotatedUserVisibleFactCount: count(turnItem["unannotatedUserVisibleFactCount"], `${path}.turns.${index}.unannotatedUserVisibleFactCount`),
      terminalState: stringValue(turnItem["terminalState"], `${path}.turns.${index}.terminalState`),
    };
  });
  return {
    schemaVersion: "interec-eval-trial-v1",
    trialId: stringValue(item["trialId"], `${path}.trialId`),
    taskId: stringValue(item["taskId"], `${path}.taskId`),
    runIndex: runIndex as 1 | 2 | 3,
    status: item["status"],
    invalidReason: item["invalidReason"],
    implementationVersion: stringValue(item["implementationVersion"], `${path}.implementationVersion`),
    modelId: stringValue(item["modelId"], `${path}.modelId`),
    modelParametersHash: stringValue(item["modelParametersHash"], `${path}.modelParametersHash`),
    promptVersion: stringValue(item["promptVersion"], `${path}.promptVersion`),
    evaluatorVersion: stringValue(item["evaluatorVersion"], `${path}.evaluatorVersion`),
    fixtureVersion: stringValue(item["fixtureVersion"], `${path}.fixtureVersion`),
    replayOrLive: item["replayOrLive"],
    turns,
  };
}

export function parseEvaluationTrials(value: unknown): EvaluationTrialArtifact[] {
  if (!Array.isArray(value)) throw new Error("EVAL_TRIALS_ARRAY_REQUIRED");
  return value.map((trial, index) => parseTrial(trial, `trials.${index}`));
}

function factKey(fact: RequiredResponseField | ActualFact | SourceFieldReferenceLabel): string {
  return canonical([fact.offerRef, fact.predicate, fact.normalizedValue, fact.unitOrCurrency, fact.evidenceScope]);
}

function evaluateTrial(task: EvaluationTaskSpec, artifact: EvaluationTrialArtifact): TrialEvaluation {
  const failures: string[] = [];
  const listingLabels = new Map(task.listingEligibilityLabels.map((listing) => [listing.offerRef, listing]));
  const sourceFieldLabels = new Map(task.sourceFieldReferenceLabels.map((fact) => [fact.sourceFactRef, fact]));
  let expectedOperations = 0;
  let matchedOperations = 0;
  let expectedReferents = 0;
  let matchedReferents = 0;
  let recommendedCandidates = 0;
  let qualifiedRecommendedCandidates = 0;
  let unannotatedFacts = 0;
  const uniqueFactConsistency = new Map<string, boolean>();
  let expectedAnswerSlots = 0;
  let answeredRequiredSlots = 0;
  let forbiddenOperations = 0;
  let stateCorrect = true;

  if (artifact.turns.length !== task.turns.length) failures.push(`turn_count:${artifact.turns.length}/${task.turns.length}`);
  for (const expected of task.turns) {
    const actual = artifact.turns.find((turn) => turn.turnIndex === expected.turnIndex);
    if (!actual) {
      failures.push(`turn_missing:${expected.turnIndex}`);
      stateCorrect = false;
      continue;
    }
    if (!subset(expected.expectedGoal, actual.goal) || expected.forbiddenGoalPaths.some((path) => pathValue(actual.goal, path).exists)) {
      failures.push(`goal:${expected.turnIndex}`);
      stateCorrect = false;
    }
    expectedOperations += expected.requiredOperations.length;
    const recalled = matchOneToOne(expected.requiredOperations, actual.operations);
    matchedOperations += recalled;
    if (recalled !== expected.requiredOperations.length) failures.push(`required_operations:${expected.turnIndex}:${recalled}/${expected.requiredOperations.length}`);
    const forbidden = actual.operations.filter((operation) => expected.forbiddenOperations.some((predicate) => matchesOperation(predicate, operation))).length;
    forbiddenOperations += forbidden;
    if (forbidden > 0) failures.push(`forbidden_operations:${expected.turnIndex}:${forbidden}`);
    for (const referent of expected.expectedReferents) {
      expectedReferents += referent.offerRefs.length;
      const matchingRefs = new Set(actual.operations
        .filter((operation) => operation.kind === referent.operationKind && (operation.status === "APPLIED" || operation.status === "SUCCEEDED"))
        .flatMap((operation) => operation.resolvedOfferRefs));
      const matchedForReferent = referent.offerRefs.filter((offerRef) => matchingRefs.has(offerRef)).length;
      matchedReferents += matchedForReferent;
      if (matchedForReferent !== referent.offerRefs.length) failures.push(`referent:${expected.turnIndex}:${referent.operationKind}:${matchedForReferent}/${referent.offerRefs.length}`);
    }
    for (const [provider, budget] of Object.entries(expected.providerBudgets)) {
      const actualCalls = actual.providerCalls[provider] ?? 0;
      if (actualCalls < budget.min || actualCalls > budget.max) failures.push(`provider_budget:${expected.turnIndex}:${provider}:${actualCalls}/${budget.min}-${budget.max}`);
    }
    if (!expected.allowedOutcomes.includes(actual.outcome)) failures.push(`outcome:${expected.turnIndex}:${actual.outcome}`);
    if (!expected.expectedTerminalStates.includes(actual.terminalState)) failures.push(`terminal_state:${expected.turnIndex}:${actual.terminalState}`);
    expectedAnswerSlots += expected.requiredAnswerSlots.length;
    for (const slot of expected.requiredAnswerSlots) {
      if (actual.answeredSlots.includes(slot)) answeredRequiredSlots += 1;
      else failures.push(`answer_slot:${expected.turnIndex}:${slot}`);
    }
    for (const requiredRef of expected.requiredCandidateRefs) if (!actual.recommendedOfferRefs.includes(requiredRef)) failures.push(`required_candidate:${expected.turnIndex}:${requiredRef}`);
    for (const offerRef of actual.recommendedOfferRefs) {
      recommendedCandidates += 1;
      const gold = listingLabels.get(offerRef);
      if (gold?.qualified === true && gold.resultLevel === "RECOMMENDATION") qualifiedRecommendedCandidates += 1;
      else failures.push(`unqualified_recommendation:${expected.turnIndex}:${offerRef}`);
    }
    const visible = actual.facts.filter((fact) => fact.userVisible);
    unannotatedFacts += actual.unannotatedUserVisibleFactCount;
    if (actual.unannotatedUserVisibleFactCount > 0) failures.push(`unannotated_facts:${expected.turnIndex}:${actual.unannotatedUserVisibleFactCount}`);
    for (const fact of visible) {
      const validEvidence = fact.evidenceSourceFactRefs.some((sourceFactRef) => {
        const gold = sourceFieldLabels.get(sourceFactRef);
        return gold !== undefined && factKey(gold) === factKey(fact);
      });
      const key = factKey(fact);
      uniqueFactConsistency.set(key, (uniqueFactConsistency.get(key) ?? true) && validEvidence);
      if (!validEvidence) failures.push(`fact_evidence:${expected.turnIndex}:${fact.offerRef}:${fact.predicate}`);
    }
    const actualFactKeys = new Set(visible.map(factKey));
    for (const requiredFact of expected.requiredResponseFields) if (!actualFactKeys.has(factKey(requiredFact))) failures.push(`required_fact:${expected.turnIndex}:${requiredFact.offerRef}:${requiredFact.predicate}`);
  }
  const visibleFacts = uniqueFactConsistency.size + unannotatedFacts;
  const evidenceConsistentFacts = [...uniqueFactConsistency.values()].filter(Boolean).length;
  const positiveOutputEligible = task.fixtureHasQualifiedOffer && task.requiresQualifiedOutput;
  const positiveOutputCorrect = !positiveOutputEligible || qualifiedRecommendedCandidates > 0;
  if (!positiveOutputCorrect) failures.push("positive_output_missing");
  return {
    trialId: artifact.trialId,
    taskId: artifact.taskId,
    runIndex: artifact.runIndex,
    success: failures.length === 0,
    failures,
    counts: { expectedOperations, matchedOperations, expectedReferents, matchedReferents, recommendedCandidates, qualifiedRecommendedCandidates, visibleFacts, evidenceConsistentFacts, expectedAnswerSlots, answeredRequiredSlots, forbiddenOperations },
    stateEligible: task.metricEligibility.includes("STATE"),
    stateCorrect,
    positiveOutputEligible,
    positiveOutputCorrect,
  };
}

function sameVersion(manifest: EvaluationManifest, artifact: EvaluationTrialArtifact): boolean {
  return artifact.implementationVersion === manifest.implementationVersion
    && artifact.modelId === manifest.modelId
    && artifact.modelParametersHash === manifest.modelParametersHash
    && artifact.promptVersion === manifest.promptVersion
    && artifact.evaluatorVersion === manifest.evaluatorVersion
    && artifact.fixtureVersion === manifest.fixtureVersion;
}

export function evaluateTaskTrials(manifest: EvaluationManifest, artifacts: EvaluationTrialArtifact[]): EvaluationReport {
  validateEvaluationManifest(manifest);
  const failures: string[] = [];
  const planned = new Map(manifest.trials.map((trial) => [trial.trialId, trial]));
  const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  const evaluations: TrialEvaluation[] = [];
  let invalidTrialCount = 0;
  for (const artifact of artifacts) {
    if (seen.has(artifact.trialId)) {
      failures.push(`duplicate_artifact:${artifact.trialId}`);
      continue;
    }
    seen.add(artifact.trialId);
    const plannedTrial = planned.get(artifact.trialId);
    if (!plannedTrial || plannedTrial.taskId !== artifact.taskId || plannedTrial.runIndex !== artifact.runIndex) {
      failures.push(`unplanned_artifact:${artifact.trialId}`);
      continue;
    }
    if (!sameVersion(manifest, artifact)) {
      failures.push(`version_mismatch:${artifact.trialId}`);
      continue;
    }
    if (artifact.status === "INVALID") {
      invalidTrialCount += 1;
      failures.push(`invalid_trial:${artifact.trialId}:${artifact.invalidReason ?? "UNKNOWN"}`);
      continue;
    }
    const task = taskById.get(artifact.taskId)!;
    evaluations.push(evaluateTrial(task, artifact));
  }
  for (const trialId of planned.keys()) if (!seen.has(trialId)) failures.push(`missing_artifact:${trialId}`);

  const successful = evaluations.filter((evaluation) => evaluation.success).length;
  const stableByTask = new Map<string, boolean>();
  for (const task of manifest.tasks) {
    const taskEvaluations = evaluations.filter((evaluation) => evaluation.taskId === task.taskId);
    stableByTask.set(task.taskId, taskEvaluations.length === 3 && taskEvaluations.every((evaluation) => evaluation.success));
  }
  const stableTaskCount = [...stableByTask.values()].filter(Boolean).length;
  const eligibleState = evaluations.filter((evaluation) => taskById.get(evaluation.taskId)!.metricEligibility.includes("STATE"));
  const eligibleReferent = evaluations.filter((evaluation) => taskById.get(evaluation.taskId)!.metricEligibility.includes("REFERENT"));
  const eligibleOperations = evaluations.filter((evaluation) => taskById.get(evaluation.taskId)!.metricEligibility.includes("OPERATIONS"));
  const eligibleCandidate = evaluations.filter((evaluation) => taskById.get(evaluation.taskId)!.metricEligibility.includes("CANDIDATE"));
  const eligibleFact = evaluations.filter((evaluation) => taskById.get(evaluation.taskId)!.metricEligibility.includes("FACT"));
  const positive = evaluations.filter((evaluation) => evaluation.positiveOutputEligible);
  const sum = (items: TrialEvaluation[], select: (item: TrialEvaluation) => number) => items.reduce((total, item) => total + select(item), 0);
  const metrics = {
    endToEndTaskSuccess: metric(successful, manifest.trials.length, 100 / 117),
    threeRunStability: metric(stableTaskCount, manifest.tasks.length, 28 / 39),
    multiTurnConstraintState: metric(eligibleState.filter((evaluation) => evaluation.stateCorrect).length, eligibleState.length, 0.98),
    candidateReferentAccuracy: metric(sum(eligibleReferent, (evaluation) => evaluation.counts.matchedReferents), sum(eligibleReferent, (evaluation) => evaluation.counts.expectedReferents), 0.98),
    requiredOperationCoverage: metric(sum(eligibleOperations, (evaluation) => evaluation.counts.matchedOperations), sum(eligibleOperations, (evaluation) => evaluation.counts.expectedOperations), 0.95),
    requiredAnswerRecall: metric(sum(evaluations, (evaluation) => evaluation.counts.answeredRequiredSlots), sum(evaluations, (evaluation) => evaluation.counts.expectedAnswerSlots), 0.95),
    positiveOutputRate: metric(positive.filter((evaluation) => evaluation.positiveOutputCorrect).length, positive.length, 0.9),
    recommendationPrecision: metric(sum(eligibleCandidate, (evaluation) => evaluation.counts.qualifiedRecommendedCandidates), sum(eligibleCandidate, (evaluation) => evaluation.counts.recommendedCandidates), 1),
    factEvidenceConsistency: metric(sum(eligibleFact, (evaluation) => evaluation.counts.evidenceConsistentFacts), sum(eligibleFact, (evaluation) => evaluation.counts.visibleFacts), 1),
  };
  const familyStableTasks: EvaluationReport["familyStableTasks"] = {};
  for (const family of EVALUATION_FAMILIES) {
    const familyTasks = manifest.tasks.filter((task) => task.family === family);
    if (familyTasks.length === 0) continue;
    const stable = familyTasks.filter((task) => stableByTask.get(task.taskId) === true).length;
    familyStableTasks[family] = { stable, total: familyTasks.length, passed: manifest.mode === "DEVELOPMENT" || stable >= 2 };
  }
  const counts = {
    forbiddenOperations: sum(evaluations, (evaluation) => evaluation.counts.forbiddenOperations),
    wrongCandidateRecommendations: sum(evaluations, (evaluation) => evaluation.counts.recommendedCandidates - evaluation.counts.qualifiedRecommendedCandidates),
    inconsistentFacts: sum(evaluations, (evaluation) => evaluation.counts.visibleFacts - evaluation.counts.evidenceConsistentFacts),
  };
  const requiredMetricEntries = Object.entries(metrics).filter(([name, value]) => {
    if (manifest.mode === "HELD_OUT") return true;
    return !(["endToEndTaskSuccess", "threeRunStability"] as string[]).includes(name) && value.denominator > 0;
  });
  failures.push(...requiredMetricEntries.filter(([, value]) => !value.passed).map(([name, value]) => `metric:${name}:${value.numerator}/${value.denominator}`));
  if (counts.forbiddenOperations > 0) failures.push(`forbidden_operations:${counts.forbiddenOperations}`);
  if (counts.wrongCandidateRecommendations > 0) failures.push(`wrong_candidate_recommendations:${counts.wrongCandidateRecommendations}`);
  if (counts.inconsistentFacts > 0) failures.push(`inconsistent_facts:${counts.inconsistentFacts}`);
  if (manifest.mode === "HELD_OUT") {
    for (const [family, result] of Object.entries(familyStableTasks)) if (!result.passed) failures.push(`family_stability:${family}:${result.stable}/${result.total}`);
  }
  return {
    schemaVersion: "interec-eval-report-v1",
    mode: manifest.mode,
    implementationVersion: manifest.implementationVersion,
    modelId: manifest.modelId,
    modelParametersHash: manifest.modelParametersHash,
    promptVersion: manifest.promptVersion,
    evaluatorVersion: manifest.evaluatorVersion,
    fixtureVersion: manifest.fixtureVersion,
    passed: failures.length === 0,
    plannedTrialCount: manifest.trials.length,
    validTrialCount: evaluations.length,
    invalidTrialCount,
    taskCount: manifest.tasks.length,
    stableTaskCount,
    metrics,
    counts,
    familyStableTasks,
    trials: evaluations,
    failures,
  };
}
