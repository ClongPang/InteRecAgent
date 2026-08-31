import { readFile } from "node:fs/promises";

const files = {
  review: await readFile(new URL("../packages/domain/src/plan-policy-review.ts", import.meta.url), "utf8"),
  protocol: await readFile(new URL("../packages/agent/src/protocol.ts", import.meta.url), "utf8"),
  executor: await readFile(new URL("../packages/agent/src/conversation-turn-executor.ts", import.meta.url), "utf8"),
  repository: await readFile(new URL("../packages/runtime/src/postgres-conversation-repository.ts", import.meta.url), "utf8"),
  migration: await readFile(new URL("../packages/runtime/conversation-migrations/0015_turn_plan_reviews.sql", import.meta.url), "utf8"),
  worker: await readFile(new URL("../packages/runtime/src/conversation-worker.ts", import.meta.url), "utf8"),
};

const required = [
  [files.review, 'decision: "APPROVED"'],
  [files.review, 'decision: "REPAIR_REQUIRED"'],
  [files.review, 'decision: "REJECTED"'],
  [files.review, "admissibleAlternatives"],
  [files.review, "without changing it"],
  [files.protocol, "planReview: committed.review"],
  [files.protocol, "Repair the proposed TurnPlan using the structured violations"],
  [files.executor, "maxPlanProposals"],
  [files.executor, "onPlanReviewed"],
  [files.executor, "approvedPlan: null"],
  [files.repository, "recordPlanReview"],
  [files.migration, "CREATE TABLE interec_agent.turn_plan_reviews"],
  [files.migration, "UNIQUE (turn_id, attempt, proposal_number)"],
  [files.worker, 'planAuthority: allTyped ? "STRUCTURED_INPUT" : "PI_AGENT"'],
];

for (const [source, token] of required) {
  if (!source.includes(token)) throw new Error(`P1_DRIFT: missing ${token}`);
}

if (files.executor.includes("const plan = policy.plan")) {
  throw new Error("P1_DRIFT: executor still executes a policy-rewritten semantic plan");
}

console.log("P1 locked: typed review, bounded repair, approved-only execution, append-only review ledger, explicit structured-input authority");

