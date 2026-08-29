import { createHash } from "node:crypto";

import { EVALUATION_FAMILIES, type EvaluationFamily } from "./task-evaluator.js";

export const BLUEPRINT_AXIS_KEYS = [
  "targetArchetype",
  "marketPattern",
  "budgetMode",
  "languageStyle",
  "candidateOrder",
  "environmentAction",
] as const;

export const GOLD_FIXTURE_OUTCOMES = [
  "QUALIFIED_RECOMMENDATION",
  "NO_QUALIFIED_OFFER",
  "DISCOVERY_ONLY",
  "PARTIAL_RESULT",
  "PROVIDER_UNAVAILABLE",
] as const;

export const GOLD_CRITICAL_SLICES = [
  "POSITIVE_OUTPUT",
  "NO_MATCH",
  "ZERO_PROVIDER_FOLLOWUP",
  "REFERENT_BINDING",
  "UNKNOWN_PRESERVATION",
  "PARTIAL_FAILURE",
  "INTERRUPT_RECOVERY",
  "PERSISTENCE_RECOVERY",
  "DISCOVERY_TIER",
  "GOAL_CORRECTION",
  "UNDO_RESTORE",
] as const;

export const GOLD_TARGET_ARCHETYPES = [
  "VERIFIED_HEADPHONES",
  "VERIFIED_HEADPHONES_ALT_MODEL",
  "VERIFIED_SMARTPHONE",
  "OPEN_MAJOR_APPLIANCE",
  "OPEN_HOME_OFFICE",
  "OPEN_TO_VERIFIED",
  "VERIFIED_PRIMARY_WITH_ACCESSORIES",
] as const;

export type GoldFixtureOutcome = typeof GOLD_FIXTURE_OUTCOMES[number];
export type GoldCriticalSlice = typeof GOLD_CRITICAL_SLICES[number];
export type BlueprintAxisKey = typeof BLUEPRINT_AXIS_KEYS[number];

export interface GoldBlueprintTurn {
  turnIndex: number;
  intent: string;
  mustObserve: string[];
}

export interface GoldBlueprintTask {
  taskId: string;
  family: EvaluationFamily;
  title: string;
  businessRisk: string;
  variationProfile: Record<BlueprintAxisKey, string>;
  turns: GoldBlueprintTurn[];
  fixtureOutcome: GoldFixtureOutcome;
  requiresQualifiedOutput: boolean;
  minRequiredFacts: number;
  capabilities: string[];
  invariants: string[];
  criticalSlices: GoldCriticalSlice[];
  independentReviewerBrief: string[];
}

export interface GoldBlueprint {
  schemaVersion: "interec-gold-blueprint-v1";
  blueprintVersion: string;
  status: "AUTHORING_CANDIDATE";
  eligibleForResumeMetrics: false;
  authoringRole: string;
  independenceBoundary: string;
  externalInvariantGates: Array<{ invariantId: string; gate: string }>;
  tasks: GoldBlueprintTask[];
}

export interface ProductContractCoverage {
  requiredCapabilities: string[];
  invariantIds: string[];
}

export interface GoldBlueprintSummary {
  taskCount: number;
  familyCounts: Record<string, number>;
  positiveTaskCount: number;
  plannedFactDenominator: number;
  fixtureOutcomeCounts: Record<string, number>;
  criticalSliceCounts: Record<string, number>;
  coveredCapabilities: string[];
  coveredInvariants: string[];
  semanticSha256: string;
}

const FAMILY_CAPABILITIES: Partial<Record<EvaluationFamily, string[]>> = {
  clarify_resume: ["clarification_resume"],
  compound_operations: ["compound_operations"],
  compare_existing: ["compare_existing", "referent_binding"],
  market_refilter: ["modify_goal"],
  preference_rerank: ["express_stance"],
  target_correction: ["correct_target"],
  reject_and_undo: ["reject_candidate", "undo"],
  focus_and_restart: ["focus_question", "refresh_and_restart"],
  unknown_facts: ["explain_with_unknown"],
  partial_provider_failure: ["provider_partial_failure"],
  interrupt_and_supersede: ["interrupt_and_resume"],
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`BLUEPRINT_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`BLUEPRINT_FIELD_UNKNOWN:${path}.${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`BLUEPRINT_FIELD_MISSING:${path}.${key}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`BLUEPRINT_FIELD_INVALID:${path}`);
  return value.trim();
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`BLUEPRINT_FIELD_INVALID:${path}`);
  return Number(value);
}

function texts(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`BLUEPRINT_FIELD_INVALID:${path}`);
  }
  const result = value.map((item) => String(item).trim());
  if (new Set(result).size !== result.length) throw new Error(`BLUEPRINT_FIELD_DUPLICATE:${path}`);
  return result;
}

function parseTask(value: unknown, index: number): GoldBlueprintTask {
  const path = `blueprint.tasks.${index}`;
  const item = record(value, path);
  exactKeys(item, ["taskId", "family", "title", "businessRisk", "variationProfile", "turns", "fixtureOutcome", "requiresQualifiedOutput", "minRequiredFacts", "capabilities", "invariants", "criticalSlices", "independentReviewerBrief"], path);
  const family = text(item["family"], `${path}.family`);
  if (!(EVALUATION_FAMILIES as readonly string[]).includes(family)) throw new Error(`BLUEPRINT_FAMILY_INVALID:${family}`);
  const outcome = text(item["fixtureOutcome"], `${path}.fixtureOutcome`);
  if (!(GOLD_FIXTURE_OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`BLUEPRINT_OUTCOME_INVALID:${outcome}`);
  const variation = record(item["variationProfile"], `${path}.variationProfile`);
  exactKeys(variation, BLUEPRINT_AXIS_KEYS, `${path}.variationProfile`);
  const turnsRaw = item["turns"];
  if (!Array.isArray(turnsRaw) || turnsRaw.length < 2 || turnsRaw.length > 4) throw new Error(`BLUEPRINT_TURNS_INVALID:${path}`);
  const turns = turnsRaw.map((value, turnIndex) => {
    const turnPath = `${path}.turns.${turnIndex}`;
    const turn = record(value, turnPath);
    exactKeys(turn, ["turnIndex", "intent", "mustObserve"], turnPath);
    return { turnIndex: integer(turn["turnIndex"], `${turnPath}.turnIndex`), intent: text(turn["intent"], `${turnPath}.intent`), mustObserve: texts(turn["mustObserve"], `${turnPath}.mustObserve`) };
  });
  if (turns.some((turn, turnIndex) => turn.turnIndex !== turnIndex + 1)) throw new Error(`BLUEPRINT_TURN_INDEX_INVALID:${path}`);
  if (typeof item["requiresQualifiedOutput"] !== "boolean") throw new Error(`BLUEPRINT_FIELD_INVALID:${path}.requiresQualifiedOutput`);
  const profile = {} as Record<BlueprintAxisKey, string>;
  for (const axis of BLUEPRINT_AXIS_KEYS) profile[axis] = text(variation[axis], `${path}.variationProfile.${axis}`);
  const criticalSlices = texts(item["criticalSlices"], `${path}.criticalSlices`);
  if (criticalSlices.some((slice) => !(GOLD_CRITICAL_SLICES as readonly string[]).includes(slice))) throw new Error(`BLUEPRINT_SLICE_INVALID:${path}`);
  return {
    taskId: text(item["taskId"], `${path}.taskId`),
    family: family as EvaluationFamily,
    title: text(item["title"], `${path}.title`),
    businessRisk: text(item["businessRisk"], `${path}.businessRisk`),
    variationProfile: profile,
    turns,
    fixtureOutcome: outcome as GoldFixtureOutcome,
    requiresQualifiedOutput: item["requiresQualifiedOutput"],
    minRequiredFacts: integer(item["minRequiredFacts"], `${path}.minRequiredFacts`),
    capabilities: texts(item["capabilities"], `${path}.capabilities`),
    invariants: texts(item["invariants"], `${path}.invariants`),
    criticalSlices: criticalSlices as GoldCriticalSlice[],
    independentReviewerBrief: texts(item["independentReviewerBrief"], `${path}.independentReviewerBrief`),
  };
}

export function parseGoldBlueprint(value: unknown): GoldBlueprint {
  const item = record(value, "blueprint");
  exactKeys(item, ["schemaVersion", "blueprintVersion", "status", "eligibleForResumeMetrics", "authoringRole", "independenceBoundary", "externalInvariantGates", "tasks"], "blueprint");
  if (item["schemaVersion"] !== "interec-gold-blueprint-v1") throw new Error("BLUEPRINT_SCHEMA_INVALID");
  if (item["status"] !== "AUTHORING_CANDIDATE") throw new Error("BLUEPRINT_STATUS_MUST_REMAIN_AUTHORING_CANDIDATE");
  if (item["eligibleForResumeMetrics"] !== false) throw new Error("BLUEPRINT_CANNOT_AUTHORIZE_RESUME_METRICS");
  if (!Array.isArray(item["tasks"])) throw new Error("BLUEPRINT_TASKS_INVALID");
  if (!Array.isArray(item["externalInvariantGates"]) || item["externalInvariantGates"].length === 0) throw new Error("BLUEPRINT_EXTERNAL_GATES_INVALID");
  const externalInvariantGates = item["externalInvariantGates"].map((value, index) => {
    const path = `blueprint.externalInvariantGates.${index}`;
    const gate = record(value, path);
    exactKeys(gate, ["invariantId", "gate"], path);
    return { invariantId: text(gate["invariantId"], `${path}.invariantId`), gate: text(gate["gate"], `${path}.gate`) };
  });
  return {
    schemaVersion: "interec-gold-blueprint-v1",
    blueprintVersion: text(item["blueprintVersion"], "blueprint.blueprintVersion"),
    status: "AUTHORING_CANDIDATE",
    eligibleForResumeMetrics: false,
    authoringRole: text(item["authoringRole"], "blueprint.authoringRole"),
    independenceBoundary: text(item["independenceBoundary"], "blueprint.independenceBoundary"),
    externalInvariantGates,
    tasks: item["tasks"].map(parseTask),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonical(entry[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintGoldBlueprint(blueprint: GoldBlueprint): string {
  return `sha256:${createHash("sha256").update(canonical(blueprint)).digest("hex")}`;
}

function axisDifference(left: GoldBlueprintTask, right: GoldBlueprintTask): number {
  return BLUEPRINT_AXIS_KEYS.filter((axis) => left.variationProfile[axis] !== right.variationProfile[axis]).length;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function validateGoldBlueprint(blueprint: GoldBlueprint, contract: ProductContractCoverage): GoldBlueprintSummary {
  if (blueprint.tasks.length !== 39) throw new Error(`BLUEPRINT_SCALE_INVALID:${blueprint.tasks.length}/39`);
  const ids = new Set<string>();
  const familyCounts: Record<string, number> = {};
  const fixtureOutcomeCounts: Record<string, number> = {};
  const criticalSliceCounts: Record<string, number> = {};
  const capabilities = new Set<string>();
  const invariants = new Set<string>();
  const knownCapabilities = new Set(contract.requiredCapabilities);
  const knownInvariants = new Set(contract.invariantIds);
  const externalGateIds = new Set<string>();
  for (const externalGate of blueprint.externalInvariantGates) {
    if (!knownInvariants.has(externalGate.invariantId)) throw new Error(`BLUEPRINT_EXTERNAL_INVARIANT_UNKNOWN:${externalGate.invariantId}`);
    if (externalGateIds.has(externalGate.invariantId)) throw new Error(`BLUEPRINT_EXTERNAL_INVARIANT_DUPLICATE:${externalGate.invariantId}`);
    externalGateIds.add(externalGate.invariantId);
    invariants.add(externalGate.invariantId);
  }
  for (const task of blueprint.tasks) {
    if (ids.has(task.taskId)) throw new Error(`BLUEPRINT_TASK_DUPLICATE:${task.taskId}`);
    ids.add(task.taskId);
    if (!new RegExp(`^gbv1-${task.family}-0[1-3]$`).test(task.taskId)) throw new Error(`BLUEPRINT_TASK_ID_INVALID:${task.taskId}`);
    increment(familyCounts, task.family);
    if (!(GOLD_TARGET_ARCHETYPES as readonly string[]).includes(task.variationProfile.targetArchetype)) {
      throw new Error(`BLUEPRINT_TARGET_ARCHETYPE_UNSUPPORTED:${task.taskId}:${task.variationProfile.targetArchetype}`);
    }
    increment(fixtureOutcomeCounts, task.fixtureOutcome);
    for (const slice of task.criticalSlices) increment(criticalSliceCounts, slice);
    for (const capability of task.capabilities) {
      if (!knownCapabilities.has(capability)) throw new Error(`BLUEPRINT_CAPABILITY_UNKNOWN:${task.taskId}:${capability}`);
      capabilities.add(capability);
    }
    for (const invariant of task.invariants) {
      if (!knownInvariants.has(invariant)) throw new Error(`BLUEPRINT_INVARIANT_UNKNOWN:${task.taskId}:${invariant}`);
      invariants.add(invariant);
    }
    const expectedPositive = task.fixtureOutcome === "QUALIFIED_RECOMMENDATION" || task.fixtureOutcome === "PARTIAL_RESULT";
    if (task.requiresQualifiedOutput !== expectedPositive) throw new Error(`BLUEPRINT_POSITIVE_FLAG_MISMATCH:${task.taskId}`);
    if (task.requiresQualifiedOutput && task.minRequiredFacts < 2) throw new Error(`BLUEPRINT_POSITIVE_FACTS_MIN:${task.taskId}`);
    if (!task.requiresQualifiedOutput && task.minRequiredFacts !== 0) throw new Error(`BLUEPRINT_NON_POSITIVE_FACTS_MUST_BE_ZERO:${task.taskId}`);
    for (const required of FAMILY_CAPABILITIES[task.family] ?? []) {
      if (!task.capabilities.includes(required)) throw new Error(`BLUEPRINT_FAMILY_CAPABILITY_MISSING:${task.taskId}:${required}`);
    }
  }
  for (const family of EVALUATION_FAMILIES) {
    const familyTasks = blueprint.tasks.filter((task) => task.family === family);
    if (familyTasks.length !== 3) throw new Error(`BLUEPRINT_FAMILY_COUNT:${family}:${familyTasks.length}/3`);
    for (let left = 0; left < familyTasks.length; left += 1) {
      for (let right = left + 1; right < familyTasks.length; right += 1) {
        const difference = axisDifference(familyTasks[left]!, familyTasks[right]!);
        if (difference < 2) throw new Error(`BLUEPRINT_VARIATION_WEAK:${family}:${familyTasks[left]!.taskId}:${familyTasks[right]!.taskId}:${difference}/2`);
      }
    }
  }
  const uncoveredCapabilities = contract.requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (uncoveredCapabilities.length) throw new Error(`BLUEPRINT_CAPABILITY_UNCOVERED:${uncoveredCapabilities.join(",")}`);
  const uncoveredInvariants = contract.invariantIds.filter((invariant) => !invariants.has(invariant));
  if (uncoveredInvariants.length) throw new Error(`BLUEPRINT_INVARIANT_UNCOVERED:${uncoveredInvariants.join(",")}`);
  const positiveTaskCount = blueprint.tasks.filter((task) => task.requiresQualifiedOutput).length;
  if (positiveTaskCount < 18) throw new Error(`BLUEPRINT_POSITIVE_COUNT:${positiveTaskCount}/18`);
  const plannedFactDenominator = blueprint.tasks.reduce((sum, task) => sum + task.minRequiredFacts * 3, 0);
  if (plannedFactDenominator < 108) throw new Error(`BLUEPRINT_FACT_DENOMINATOR:${plannedFactDenominator}/108`);
  const sliceMinimums: Partial<Record<GoldCriticalSlice, number>> = {
    POSITIVE_OUTPUT: 18,
    NO_MATCH: 3,
    ZERO_PROVIDER_FOLLOWUP: 12,
    REFERENT_BINDING: 9,
    UNKNOWN_PRESERVATION: 3,
    PARTIAL_FAILURE: 3,
    INTERRUPT_RECOVERY: 3,
    PERSISTENCE_RECOVERY: 3,
    DISCOVERY_TIER: 3,
    GOAL_CORRECTION: 3,
    UNDO_RESTORE: 3,
  };
  for (const [slice, minimum] of Object.entries(sliceMinimums)) {
    const actual = criticalSliceCounts[slice] ?? 0;
    if (actual < Number(minimum)) throw new Error(`BLUEPRINT_SLICE_COVERAGE:${slice}:${actual}/${minimum}`);
  }
  return {
    taskCount: blueprint.tasks.length,
    familyCounts,
    positiveTaskCount,
    plannedFactDenominator,
    fixtureOutcomeCounts,
    criticalSliceCounts,
    coveredCapabilities: [...capabilities].sort(),
    coveredInvariants: [...invariants].sort(),
    semanticSha256: fingerprintGoldBlueprint(blueprint),
  };
}
