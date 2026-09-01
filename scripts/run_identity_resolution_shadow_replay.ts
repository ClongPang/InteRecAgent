import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  admitQuoteObservation,
  createQuoteObservation,
  resolveProductIdentity,
  resolveQuoteTarget,
  type QuoteAdmissionDecision,
} from "@interec/domain";
import {
  compareIdentityResolutionShadow,
  type FrozenLegacyAdmissionStatus,
} from "../packages/runtime/src/identity-resolution-observability.js";
import { trajectoryIdentitySnapshot } from "./identity-grounded-identity-fixture.js";

interface ShadowCase {
  id: string;
  title: string;
  fields?: Record<string, unknown>;
  frozenLegacyStatus: FrozenLegacyAdmissionStatus;
  allowActiveMorePermissive?: boolean;
  expected: {
    status: QuoteAdmissionDecision["status"];
    strength: QuoteAdmissionDecision["identityStrength"];
    disagreementCode: string | null;
  };
}

interface ShadowSpec {
  schemaVersion: number;
  registryVersion: number;
  cases: ShadowCase[];
}

const rawText = "Sony WH-1000XM5";
const targetIdentity = resolveProductIdentity(trajectoryIdentitySnapshot, {
  rawText,
  proposedModel: "WH-1000XM5",
  brand: "Sony",
});
const targetResolution = resolveQuoteTarget({
  rawText,
  proposedModel: "WH-1000XM5",
  brand: "Sony",
  identityResolution: targetIdentity,
});
assert.equal(targetResolution.status, "RESOLVED");
if (targetResolution.status !== "RESOLVED") throw new Error("SHADOW_TARGET_UNRESOLVED");

const specUrl = new URL("../spec/identity-resolution-shadow-replay.json", import.meta.url);
const spec = JSON.parse(await readFile(specUrl, "utf8")) as ShadowSpec;
assert.equal(spec.schemaVersion, 1);
assert.equal(spec.registryVersion, trajectoryIdentitySnapshot.registryVersion);
assert.ok(spec.cases.length >= 8);
assert.equal(new Set(spec.cases.map((value) => value.id)).size, spec.cases.length);

let agreements = 0;
let disagreements = 0;
for (const [index, item] of spec.cases.entries()) {
  const rawRecord = {
    id: `shadow-${item.id}`,
    title: item.title,
    price: { amount: "399", currency: "SGD" },
    merchant: "Shadow Merchant",
    url: `https://merchant.example/items/${index}`,
    ...structuredClone(item.fields ?? {}),
  };
  const observation = createQuoteObservation({
    rawRecord,
    recordIndex: index,
    artifactRef: "sha256:identity-shadow-replay",
    observedAt: "2026-09-01T00:00:00.000Z",
  });
  const active = admitQuoteObservation(observation, targetResolution.target, trajectoryIdentitySnapshot);
  const comparison = compareIdentityResolutionShadow(active, item.frozenLegacyStatus);
  assert.equal(active.status, item.expected.status, `${item.id}: active status`);
  assert.equal(active.identityStrength, item.expected.strength, `${item.id}: active strength`);
  assert.equal(comparison.disagreementCode, item.expected.disagreementCode, `${item.id}: shadow difference`);
  if (comparison.disagreementCode === "ACTIVE_MORE_PERMISSIVE") {
    assert.equal(item.allowActiveMorePermissive, true, `${item.id}: unapproved recall expansion`);
    assert.equal(active.identityStrength, "STRONG_IDENTIFIER_MATCH", `${item.id}: only strong identifiers may justify recall expansion`);
  }
  if (comparison.agreement) agreements += 1;
  else disagreements += 1;
}

console.log(`identity shadow replay: ${spec.cases.length} cases, ${agreements} agreements, ${disagreements} classified differences, 0 unexplained recall expansions`);
