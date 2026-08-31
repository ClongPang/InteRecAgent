import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fingerprintEvaluationAuthoringPlan, parseEvaluationAuthoringPlan } from "./evaluation-authoring-plan.js";
import { parseDevelopmentEvaluationCases, validateDevelopmentEvaluationCases } from "./development-evaluation-cases.js";

const planPath = resolve(process.env["INTEREC_EVALUATION_PLAN_PATH"] ?? "spec/evaluation/gold-v1/evaluation-authoring-plan.json");
const casesPath = resolve(process.env["INTEREC_DEVELOPMENT_EVALUATION_CASES_PATH"] ?? "spec/evaluation/gold-v1/development-evaluation-cases.json");
const plan = parseEvaluationAuthoringPlan(JSON.parse(readFileSync(planPath, "utf8")));
const cases = parseDevelopmentEvaluationCases(JSON.parse(readFileSync(casesPath, "utf8")));
validateDevelopmentEvaluationCases(cases, plan, fingerprintEvaluationAuthoringPlan(plan));

process.stdout.write(`${JSON.stringify({
  evaluationScope: cases.evaluationScope,
  eligibleForResumeMetrics: cases.eligibleForResumeMetrics,
  caseCount: cases.cases.length,
  userTurnCount: cases.cases.reduce((sum, entry) => sum + entry.userTurns.length, 0),
  fixtureSeeds: [...new Set(cases.cases.map((entry) => entry.fixtureSeed))].sort(),
  planVersion: cases.planVersion,
  planSemanticSha256: cases.planSemanticSha256,
}, null, 2)}\n`);
