import { readFile } from "node:fs/promises";

const relevance = await readFile(new URL("../packages/domain/src/query-product-relevance.ts", import.meta.url), "utf8");
const kernel = await readFile(new URL("../packages/domain/src/kernel.ts", import.meta.url), "utf8");
const repository = await readFile(new URL("../packages/runtime/src/conversation-search-repository.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../packages/runtime/conversation-migrations/0017_esci_candidate_admission.sql", import.meta.url), "utf8");
const dataset = JSON.parse(await readFile(new URL("../spec/evaluation/esci-admission-v2/cases.json", import.meta.url), "utf8"));

const mappings = {
  EXACT: "MAIN_RECOMMENDATION",
  SUBSTITUTE: "ALTERNATIVE_COHORT",
  COMPLEMENT: "RELATED_COHORT",
  IRRELEVANT: "INELIGIBLE",
  UNRESOLVED: "INSUFFICIENT_EVIDENCE",
};
for (const [label, cohort] of Object.entries(mappings)) {
  if (!relevance.includes(`${label}: "${cohort}"`)) throw new Error(`P2_DRIFT: missing ${label} -> ${cohort}`);
}
for (const token of [
  "STRUCTURED_SEMANTIC_EVIDENCE_CONFLICT",
  "eligibleForMainRanking: assessment.label === \"EXACT\"",
  "if (!candidateAdmission.eligibleForMainRanking)",
  "queryProductRelevance",
  "candidateAdmission",
]) {
  if (!`${relevance}\n${kernel}`.includes(token)) throw new Error(`P2_DRIFT: missing ${token}`);
}
for (const token of ["relevance_label", "relevance_json", "admission_cohort", "relevance_policy_version"]) {
  if (!repository.includes(token) || !migration.includes(token)) throw new Error(`P2_DRIFT: qualification ledger missing ${token}`);
}
const categories = new Set(dataset.cases.map((item) => item.target.categoryId));
const labels = new Set(dataset.cases.map((item) => item.expected));
if (categories.size < 4) throw new Error("P2_DRIFT: evaluation is not cross-category");
for (const label of Object.keys(mappings)) if (!labels.has(label)) throw new Error(`P2_DRIFT: evaluation misses ${label}`);

console.log(`P2 locked: ${dataset.cases.length} ESCI cases across ${categories.size} categories; non-EXACT cohorts cannot enter main ranking`);
