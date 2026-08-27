import { DomainError } from "./errors.js";
import { compareDecimal } from "./money.js";
import { matchDiscoveryTokens, tokenizeDiscoveryText } from "./discovery-tokenizer.js";
import type { CandidateBinding, CandidateProjection, CandidateReferent, ShoppingGoal, WorkingSet } from "./conversation-types.js";

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function universe(set: WorkingSet): Map<string, CandidateProjection> {
  return new Map(set.pool.map((item) => [item.offerRef, item]));
}

function assertKnownRefs(set: WorkingSet, refs: string[]): void {
  const known = universe(set);
  const missing = refs.find((ref) => !known.has(ref));
  if (missing) throw new DomainError("WORKING_SET_OFFER_NOT_FOUND", missing);
}

function assertUniqueRefs(refs: string[], field: string): void {
  if (new Set(refs).size !== refs.length) {
    throw new DomainError("DUPLICATE_WORKING_SET_REFERENCE", `${field} contains duplicate offer references`);
  }
}

export function validateWorkingSet(set: WorkingSet): WorkingSet {
  if (!Number.isSafeInteger(set.version) || set.version < 1) throw new DomainError("INVALID_WORKING_SET_VERSION", `Invalid working-set version: ${set.version}`);
  if (!Number.isSafeInteger(set.boundGoalVersion) || set.boundGoalVersion < 1) throw new DomainError("INVALID_GOAL_VERSION", `Invalid bound goal version: ${set.boundGoalVersion}`);
  const poolRefs = set.pool.map((item) => item.offerRef);
  assertUniqueRefs(poolRefs, "pool");
  for (const [field, refs] of [
    ["displayOfferRefs", set.displayOfferRefs],
    ["mentionedOfferRefs", set.mentionedOfferRefs],
    ["comparisonOfferRefs", set.comparisonOfferRefs],
    ["rejectedOfferRefs", set.rejectedOfferRefs],
  ] as const) {
    assertUniqueRefs(refs, field);
    assertKnownRefs(set, refs);
  }
  if (set.comparisonOfferRefs.length === 1 || set.comparisonOfferRefs.length > 4) {
    throw new DomainError("INVALID_COMPARISON_SIZE", `Comparison set must be empty or contain 2-4 offers: ${set.comparisonOfferRefs.length}`);
  }
  if (set.displayOfferRefs.some((ref) => set.rejectedOfferRefs.includes(ref))) {
    throw new DomainError("REJECTED_OFFER_DISPLAYED", "Rejected offers cannot remain in the displayed working set");
  }
  if (set.comparisonOfferRefs.some((ref) => set.rejectedOfferRefs.includes(ref))) {
    throw new DomainError("REJECTED_OFFER_CANNOT_BE_COMPARED", "Rejected offers cannot remain in the comparison set");
  }
  if (set.focusOfferRef !== null) {
    assertKnownRefs(set, [set.focusOfferRef]);
    if (set.rejectedOfferRefs.includes(set.focusOfferRef)) {
      throw new DomainError("REJECTED_OFFER_CANNOT_BE_FOCUSED", `Rejected offer cannot remain focused: ${set.focusOfferRef}`);
    }
  }
  return structuredClone(set);
}

export function createWorkingSet(input: {
  version: number;
  boundGoalVersion: number;
  pool: CandidateProjection[];
  displayOfferRefs?: string[];
}): WorkingSet {
  const offerRefs = input.pool.map((item) => item.offerRef);
  if (new Set(offerRefs).size !== offerRefs.length) throw new DomainError("DUPLICATE_WORKING_SET_OFFER", "Offer refs must be unique");
  const display = input.displayOfferRefs ?? offerRefs;
  const set: WorkingSet = {
    version: input.version,
    boundGoalVersion: input.boundGoalVersion,
    pool: structuredClone(input.pool),
    displayOfferRefs: unique(display),
    mentionedOfferRefs: [],
    comparisonOfferRefs: [],
    rejectedOfferRefs: [],
    focusOfferRef: null,
  };
  return validateWorkingSet(set);
}

export function bindCandidateReferent(set: WorkingSet, referent: CandidateReferent): CandidateBinding {
  const known = universe(set);
  if (referent.kind === "OFFER_REF") {
    return known.has(referent.offerRef) ? { status: "RESOLVED", offerRefs: [referent.offerRef] } : { status: "NOT_FOUND", offerRefs: [] };
  }
  if (referent.kind === "DISPLAY_RANK") {
    if (!Number.isSafeInteger(referent.rank) || referent.rank < 1) return { status: "NOT_FOUND", offerRefs: [] };
    const offerRef = set.displayOfferRefs[referent.rank - 1];
    return offerRef ? { status: "RESOLVED", offerRefs: [offerRef] } : { status: "NOT_FOUND", offerRefs: [] };
  }
  if (referent.kind === "FOCUS") {
    return set.focusOfferRef && known.has(set.focusOfferRef) ? { status: "RESOLVED", offerRefs: [set.focusOfferRef] } : { status: "NOT_FOUND", offerRefs: [] };
  }
  if (referent.kind === "COMPARISON") {
    return set.comparisonOfferRefs.length > 0 ? { status: "RESOLVED", offerRefs: [...set.comparisonOfferRefs] } : { status: "NOT_FOUND", offerRefs: [] };
  }
  const needle = normalized(referent.text);
  if (!needle) return { status: "NOT_FOUND", offerRefs: [] };
  const tokens = needle.split(" ");
  const matches = set.pool
    .filter((item) => {
      const haystack = normalized([item.title, item.canonicalModel ?? "", item.merchant, item.categoryId].join(" "));
      return tokens.every((token) => haystack.includes(token));
    })
    .map((item) => item.offerRef);
  if (matches.length === 1) return { status: "RESOLVED", offerRefs: matches };
  if (matches.length > 1) return { status: "AMBIGUOUS", offerRefs: matches };
  return { status: "NOT_FOUND", offerRefs: [] };
}

export function resolveReferents(set: WorkingSet, referents: CandidateReferent[]): string[] {
  const refs = [];
  for (const referent of referents) {
    const binding = bindCandidateReferent(set, referent);
    if (binding.status === "NOT_FOUND") throw new DomainError("CANDIDATE_REFERENT_NOT_FOUND", JSON.stringify(referent));
    if (binding.status === "AMBIGUOUS") throw new DomainError("CANDIDATE_REFERENT_AMBIGUOUS", binding.offerRefs.join(","));
    refs.push(...binding.offerRefs);
  }
  return unique(refs);
}

export function rejectWorkingSetOffers(set: WorkingSet, refs: string[]): WorkingSet {
  assertKnownRefs(set, refs);
  const rejected = unique([...set.rejectedOfferRefs, ...refs]);
  const remainingComparison = set.comparisonOfferRefs.filter((ref) => !rejected.includes(ref));
  return {
    ...set,
    rejectedOfferRefs: rejected,
    displayOfferRefs: set.displayOfferRefs.filter((ref) => !rejected.includes(ref)),
    comparisonOfferRefs: remainingComparison.length >= 2 ? remainingComparison : [],
    focusOfferRef: set.focusOfferRef && rejected.includes(set.focusOfferRef) ? null : set.focusOfferRef,
  };
}

export function restoreWorkingSetOffers(set: WorkingSet, refs: string[]): WorkingSet {
  assertKnownRefs(set, refs);
  const rejected = set.rejectedOfferRefs.filter((ref) => !refs.includes(ref));
  const display = [...set.displayOfferRefs];
  for (const item of set.pool) {
    if (refs.includes(item.offerRef) && !display.includes(item.offerRef)) display.push(item.offerRef);
  }
  return { ...set, rejectedOfferRefs: rejected, displayOfferRefs: display };
}

export function setWorkingSetComparison(set: WorkingSet, refs: string[]): WorkingSet {
  const values = unique(refs);
  if (values.length < 2 || values.length > 4) throw new DomainError("INVALID_COMPARISON_SIZE", String(values.length));
  assertKnownRefs(set, values);
  if (values.some((ref) => set.rejectedOfferRefs.includes(ref))) throw new DomainError("REJECTED_OFFER_CANNOT_BE_COMPARED", values.join(","));
  return { ...set, comparisonOfferRefs: values, mentionedOfferRefs: unique([...set.mentionedOfferRefs, ...values]) };
}

export function setWorkingSetFocus(set: WorkingSet, ref: string | null): WorkingSet {
  if (ref !== null) assertKnownRefs(set, [ref]);
  if (ref !== null && set.rejectedOfferRefs.includes(ref)) {
    throw new DomainError("REJECTED_OFFER_CANNOT_BE_FOCUSED", `Rejected offer cannot become the conversation focus: ${ref}`);
  }
  return { ...set, focusOfferRef: ref, mentionedOfferRefs: ref ? unique([...set.mentionedOfferRefs, ref]) : set.mentionedOfferRefs };
}

export function markWorkingSetMentioned(set: WorkingSet, refs: string[]): WorkingSet {
  assertKnownRefs(set, refs);
  return { ...set, mentionedOfferRefs: unique([...set.mentionedOfferRefs, ...refs]) };
}

export function refilterWorkingSetByMarkets(set: WorkingSet, markets: string[]): WorkingSet {
  const allowed = new Set(markets.map((item) => item.toUpperCase()));
  return {
    ...set,
    displayOfferRefs: set.pool
      .filter((item) => allowed.has(item.retrievalMarket.toUpperCase()) && !set.rejectedOfferRefs.includes(item.offerRef))
      .map((item) => item.offerRef),
  };
}

function candidateMatchesGoalView(candidate: CandidateProjection, goal: ShoppingGoal): boolean {
  if (goal.retrievalMarkets.length > 0 && !goal.retrievalMarkets.some((market) => market.toUpperCase() === candidate.retrievalMarket.toUpperCase())) return false;
  if (goal.budget?.currency.toUpperCase() === "CNY" && compareDecimal(candidate.cnyAmount, goal.budget.amount) > 0) return false;
  if (goal.stockPreference === "KNOWN_IN_STOCK" && candidate.stock !== "IN_STOCK") return false;
  if (goal.target) {
    if (candidate.categoryId !== goal.target.categoryId) return false;
    // Discovery candidates intentionally retain UNKNOWN identity fields. Lack
    // of proof is not a contradiction; only a known, conflicting role should
    // remove a candidate from the conversational view.
    if (candidate.itemRole !== "UNKNOWN" && candidate.itemRole !== goal.target.itemRole) return false;
    if (goal.target.canonicalModel && candidate.canonicalModel?.toUpperCase() !== goal.target.canonicalModel.toUpperCase()) return false;
    if (goal.target.condition !== "ANY" && candidate.condition !== goal.target.condition && candidate.condition !== "UNKNOWN") return false;
  }
  return !goal.exclusions.some((entity) => {
    if (entity.kind === "OFFER") return entity.value === candidate.offerRef;
    if (entity.kind === "MODEL") return candidate.canonicalModel?.toUpperCase() === entity.value.toUpperCase();
    if (entity.kind === "CATEGORY") return candidate.categoryId.toUpperCase() === entity.value.toUpperCase();
    return false;
  });
}

export function reprojectWorkingSetForGoal(set: WorkingSet, goal: ShoppingGoal): WorkingSet {
  const visible = new Set(set.pool
    .filter((candidate) => candidateMatchesGoalView(candidate, goal) && !set.rejectedOfferRefs.includes(candidate.offerRef))
    .map((candidate) => candidate.offerRef));
  const comparison = set.comparisonOfferRefs.filter((offerRef) => visible.has(offerRef));
  const poolOrder = new Map(set.pool.map((candidate, index) => [candidate.offerRef, index]));
  const candidateByRef = universe(set);
  const preferenceScore = (candidate: CandidateProjection): number => {
    const candidateTokens = tokenizeDiscoveryText([candidate.title, candidate.canonicalModel, candidate.categoryId, candidate.merchant].filter(Boolean).join(" "));
    return goal.preferences.reduce((score, preference) => {
      const value = Array.isArray(preference.value) ? preference.value.join(" ") : String(preference.value);
      const queryTokens = tokenizeDiscoveryText(value);
      return queryTokens.length > 0 && matchDiscoveryTokens(candidateTokens, queryTokens).coverage === 1
        ? score + preference.weight
        : score;
    }, 0);
  };
  const displayOfferRefs = set.pool.map((candidate) => candidate.offerRef)
    .filter((offerRef) => visible.has(offerRef))
    .sort((left, right) => {
      const scoreOrder = preferenceScore(candidateByRef.get(right)!) - preferenceScore(candidateByRef.get(left)!);
      return scoreOrder || poolOrder.get(left)! - poolOrder.get(right)!;
    });
  return validateWorkingSet({
    ...set,
    displayOfferRefs,
    comparisonOfferRefs: comparison.length >= 2 ? comparison : [],
    focusOfferRef: set.focusOfferRef && visible.has(set.focusOfferRef) ? set.focusOfferRef : null,
  });
}

export function rerankWorkingSetByPrice(set: WorkingSet): WorkingSet {
  const known = universe(set);
  return {
    ...set,
    displayOfferRefs: [...set.displayOfferRefs].sort((left, right) => {
      const compared = compareDecimal(known.get(left)!.cnyAmount, known.get(right)!.cnyAmount);
      return compared === 0 ? left.localeCompare(right) : compared;
    }),
  };
}
