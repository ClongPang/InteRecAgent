import type { GoldBlueprint } from "./gold-blueprint.js";

export const INTERNAL_FIXTURE_SEEDS = [
  "HEADPHONES_XM5",
  "HEADPHONES_XM4",
  "SMARTPHONE_IPHONE16PRO_256",
  "SMARTPHONE_PIXEL9PRO_256",
  "OPEN_WASHER",
  "OPEN_OFFICE_CHAIR",
  "OPEN_TO_HEADPHONES",
  "HEADPHONES_ACCESSORY_TRAPS",
] as const;

export interface InternalQualificationCase {
  taskId: string;
  fixtureSeed: typeof INTERNAL_FIXTURE_SEEDS[number];
  environmentAction: string;
  focusDisplayRank?: number;
  userTurns: string[];
}

export interface InternalQualificationCases {
  schemaVersion: "interec-internal-qualification-cases-v1";
  qualificationLevel: "INTERNAL_QUALIFICATION";
  eligibleForResumeMetrics: false;
  blueprintVersion: string;
  blueprintSemanticSha256: string;
  cases: InternalQualificationCase[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`QUALIFICATION_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, optionalKeys: readonly string[] = []): void {
  const allowed = new Set([...keys, ...optionalKeys]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`QUALIFICATION_FIELD_UNKNOWN:${path}.${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`QUALIFICATION_FIELD_MISSING:${path}.${key}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`QUALIFICATION_FIELD_INVALID:${path}`);
  return value.trim();
}

export function parseInternalQualificationCases(value: unknown): InternalQualificationCases {
  const item = record(value, "qualificationCases");
  exactKeys(item, ["schemaVersion", "qualificationLevel", "eligibleForResumeMetrics", "blueprintVersion", "blueprintSemanticSha256", "cases"], "qualificationCases");
  if (item["schemaVersion"] !== "interec-internal-qualification-cases-v1") throw new Error("QUALIFICATION_SCHEMA_INVALID");
  if (item["qualificationLevel"] !== "INTERNAL_QUALIFICATION") throw new Error("QUALIFICATION_LEVEL_INVALID");
  if (item["eligibleForResumeMetrics"] !== false) throw new Error("QUALIFICATION_CANNOT_AUTHORIZE_RESUME_METRICS");
  if (!Array.isArray(item["cases"])) throw new Error("QUALIFICATION_CASES_INVALID");
  const cases = item["cases"].map((value, index): InternalQualificationCase => {
    const path = `qualificationCases.cases.${index}`;
    const entry = record(value, path);
    exactKeys(entry, ["taskId", "fixtureSeed", "environmentAction", "userTurns"], path, ["focusDisplayRank"]);
    const fixtureSeed = text(entry["fixtureSeed"], `${path}.fixtureSeed`);
    if (!(INTERNAL_FIXTURE_SEEDS as readonly string[]).includes(fixtureSeed)) throw new Error(`QUALIFICATION_FIXTURE_SEED_INVALID:${fixtureSeed}`);
    if (!Array.isArray(entry["userTurns"]) || entry["userTurns"].length < 2 || entry["userTurns"].length > 4) throw new Error(`QUALIFICATION_TURNS_INVALID:${path}`);
    const focusDisplayRank = entry["focusDisplayRank"];
    if (focusDisplayRank !== undefined && (!Number.isSafeInteger(focusDisplayRank) || Number(focusDisplayRank) < 1 || Number(focusDisplayRank) > 20)) {
      throw new Error(`QUALIFICATION_FOCUS_RANK_INVALID:${path}`);
    }
    return {
      taskId: text(entry["taskId"], `${path}.taskId`),
      fixtureSeed: fixtureSeed as InternalQualificationCase["fixtureSeed"],
      environmentAction: text(entry["environmentAction"], `${path}.environmentAction`),
      ...(focusDisplayRank === undefined ? {} : { focusDisplayRank: Number(focusDisplayRank) }),
      userTurns: entry["userTurns"].map((turn, turnIndex) => text(turn, `${path}.userTurns.${turnIndex}`)),
    };
  });
  return {
    schemaVersion: "interec-internal-qualification-cases-v1",
    qualificationLevel: "INTERNAL_QUALIFICATION",
    eligibleForResumeMetrics: false,
    blueprintVersion: text(item["blueprintVersion"], "qualificationCases.blueprintVersion"),
    blueprintSemanticSha256: text(item["blueprintSemanticSha256"], "qualificationCases.blueprintSemanticSha256"),
    cases,
  };
}

const META_LANGUAGE = /\b(?:offerRef|provider|working[ _-]?set|gold|fixture|harness|turn)\b|评测器|评分器|测试夹具|候选引用/iu;

export function validateInternalQualificationCases(input: InternalQualificationCases, blueprint: GoldBlueprint, semanticSha256: string): void {
  if (input.blueprintVersion !== blueprint.blueprintVersion) throw new Error("QUALIFICATION_BLUEPRINT_VERSION_MISMATCH");
  if (input.blueprintSemanticSha256 !== semanticSha256) throw new Error("QUALIFICATION_BLUEPRINT_HASH_MISMATCH");
  if (input.cases.length !== blueprint.tasks.length) throw new Error(`QUALIFICATION_CASE_COUNT:${input.cases.length}/${blueprint.tasks.length}`);
  const ids = new Set<string>();
  const allMessages = new Set<string>();
  for (const testCase of input.cases) {
    if (ids.has(testCase.taskId)) throw new Error(`QUALIFICATION_CASE_DUPLICATE:${testCase.taskId}`);
    ids.add(testCase.taskId);
    const task = blueprint.tasks.find((candidate) => candidate.taskId === testCase.taskId);
    if (!task) throw new Error(`QUALIFICATION_TASK_UNKNOWN:${testCase.taskId}`);
    if (testCase.environmentAction !== task.variationProfile.environmentAction) throw new Error(`QUALIFICATION_ENVIRONMENT_MISMATCH:${testCase.taskId}`);
    if (testCase.userTurns.length !== task.turns.length) throw new Error(`QUALIFICATION_TURN_COUNT:${testCase.taskId}:${testCase.userTurns.length}/${task.turns.length}`);
    for (const message of testCase.userTurns) {
      if (message.length > 300) throw new Error(`QUALIFICATION_MESSAGE_TOO_LONG:${testCase.taskId}`);
      if (META_LANGUAGE.test(message)) throw new Error(`QUALIFICATION_META_LANGUAGE:${testCase.taskId}`);
      const normalized = message.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
      if (allMessages.has(normalized)) throw new Error(`QUALIFICATION_MESSAGE_DUPLICATE:${testCase.taskId}`);
      allMessages.add(normalized);
    }
  }
  for (const task of blueprint.tasks) if (!ids.has(task.taskId)) throw new Error(`QUALIFICATION_TASK_MISSING:${task.taskId}`);
}
