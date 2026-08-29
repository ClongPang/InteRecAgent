import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fingerprintGoldBlueprint, parseGoldBlueprint } from "./gold-blueprint.js";
import { parseInternalQualificationCases, validateInternalQualificationCases } from "./internal-qualification-cases.js";

const blueprintPath = resolve(process.env["INTEREC_GOLD_BLUEPRINT_PATH"] ?? "spec/evaluation/gold-v1/authoring-blueprint.json");
const casesPath = resolve(process.env["INTEREC_INTERNAL_QUALIFICATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/internal-qualification-cases.json");
const blueprint = parseGoldBlueprint(JSON.parse(readFileSync(blueprintPath, "utf8")));
const cases = parseInternalQualificationCases(JSON.parse(readFileSync(casesPath, "utf8")));
validateInternalQualificationCases(cases, blueprint, fingerprintGoldBlueprint(blueprint));

process.stdout.write(`${JSON.stringify({
  qualificationLevel: cases.qualificationLevel,
  eligibleForResumeMetrics: cases.eligibleForResumeMetrics,
  caseCount: cases.cases.length,
  userTurnCount: cases.cases.reduce((sum, entry) => sum + entry.userTurns.length, 0),
  fixtureSeeds: [...new Set(cases.cases.map((entry) => entry.fixtureSeed))].sort(),
  blueprintVersion: cases.blueprintVersion,
  blueprintSemanticSha256: cases.blueprintSemanticSha256,
}, null, 2)}\n`);
