interface AdmissionIdentity {
  status: string;
  identityStrength: string;
}

const PUBLISHABLE_IDENTITY_STRENGTHS = new Set([
  "STRONG_IDENTIFIER_MATCH",
  "CURATED_TITLE_ALIAS_MATCH",
  "EXACT_LEXICAL_MATCH",
]);

export function countValues(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, "en-US")));
}

export function summarizeAdmissionIdentity(decisions: readonly AdmissionIdentity[]): {
  counts: Record<string, number>;
  onlyDeterministicPublished: boolean;
} {
  return {
    counts: countValues(decisions.map((decision) => decision.identityStrength)),
    onlyDeterministicPublished: decisions
      .filter((decision) => decision.status === "ELIGIBLE")
      .every((decision) => PUBLISHABLE_IDENTITY_STRENGTHS.has(decision.identityStrength)),
  };
}
