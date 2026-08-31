import {
  DomainError,
  resolveReferents,
  validateTurnPlan,
  type TurnOperation,
  type TurnPlan,
  type WorkingSet,
} from "@interec/domain";

function stableOfferReferents(
  set: WorkingSet,
  referents: Parameters<typeof resolveReferents>[1],
  planned: { focusOfferRef: string | null; comparisonOfferRefs: string[] },
) {
  return referents.flatMap((referent) => {
    if (referent.kind === "FOCUS" && planned.focusOfferRef) return [{ kind: "OFFER_REF" as const, offerRef: planned.focusOfferRef }];
    if (referent.kind === "COMPARISON" && planned.comparisonOfferRefs.length > 0) {
      return planned.comparisonOfferRefs.map((offerRef) => ({ kind: "OFFER_REF" as const, offerRef }));
    }
    return resolveReferents(set, [referent]).map((offerRef) => ({ kind: "OFFER_REF" as const, offerRef }));
  });
}

export function normalizeUndoRevision(plan: TurnPlan, currentRevision: number, contents: string[] | undefined): TurnPlan {
  const explicitlyRequestsUndo = contents?.some((content) => /撤销|回到上一次|恢复上一次|undo/iu.test(content)) ?? false;
  if (!explicitlyRequestsUndo || currentRevision < 1) return plan;
  const ops = plan.ops.map((operation) => operation.kind === "UNDO_REVISION" && operation.revision >= currentRevision
    ? { ...operation, revision: currentRevision - 1 }
    : operation);
  return validateTurnPlan({ ...plan, ops });
}

export function stabilizePlanReferents(plan: TurnPlan, workingSet: WorkingSet | null): TurnPlan {
  if (!workingSet) return plan;
  const planned = {
    focusOfferRef: workingSet.focusOfferRef,
    comparisonOfferRefs: [...workingSet.comparisonOfferRefs],
  };
  let plannedDisplayOfferRefs = [...workingSet.displayOfferRefs];
  let restoredOfferRefs: string[] = [];
  const ops = plan.ops.map((operation): TurnOperation => {
    switch (operation.kind) {
      case "REJECT_OFFERS": {
        if (plannedDisplayOfferRefs.length === 0) return operation;
        const referents = operation.referents.flatMap((referent) => referent.kind === "TEXT" && /(?:current\s+)?last|最后/iu.test(referent.text)
          ? plannedDisplayOfferRefs.at(-1) ? [{ kind: "OFFER_REF" as const, offerRef: plannedDisplayOfferRefs.at(-1)! }] : []
          : stableOfferReferents(workingSet, [referent], planned));
        const rejected = new Set(referents.map((referent) => referent.offerRef));
        plannedDisplayOfferRefs = plannedDisplayOfferRefs.filter((offerRef) => !rejected.has(offerRef));
        return { ...operation, referents };
      }
      case "INSPECT_WORKING_SET": {
        if (plannedDisplayOfferRefs.length === 0 && restoredOfferRefs.length === 0) return operation;
        const referents = operation.referents.flatMap((referent) => referent.kind === "DISPLAY_RANK"
          && !workingSet.displayOfferRefs[referent.rank - 1]
          && restoredOfferRefs.length === 1
          ? [{ kind: "OFFER_REF" as const, offerRef: restoredOfferRefs[0]! }]
          : stableOfferReferents(workingSet, [referent], planned));
        return { ...operation, referents };
      }
      case "RESTORE_OFFERS": {
        restoredOfferRefs = workingSet.rejectedOfferRefs.length === 1
          ? [workingSet.rejectedOfferRefs[0]!]
          : operation.referents.flatMap((referent) => referent.kind === "DISPLAY_RANK" && workingSet.rejectedOfferRefs[referent.rank - 1]
            ? [workingSet.rejectedOfferRefs[referent.rank - 1]!]
            : stableOfferReferents(workingSet, [referent], planned).map((resolved) => resolved.offerRef));
        return { ...operation, referents: restoredOfferRefs.map((offerRef) => ({ kind: "OFFER_REF", offerRef })) };
      }
      case "SET_COMPARISON": {
        const referents = stableOfferReferents(workingSet, operation.referents, planned);
        planned.comparisonOfferRefs = referents.map((referent) => referent.offerRef);
        return { ...operation, referents };
      }
      case "SET_FOCUS": {
        if (operation.referent === null) {
          planned.focusOfferRef = null;
          return operation;
        }
        const refs = stableOfferReferents(workingSet, [operation.referent], planned);
        if (refs.length !== 1) throw new DomainError("FOCUS_REQUIRES_ONE_OFFER", `Focus resolved to ${refs.length} offers`);
        planned.focusOfferRef = refs[0]!.offerRef;
        return { ...operation, referent: refs[0]! };
      }
      default:
        return operation;
    }
  });
  return validateTurnPlan({ ...plan, ops });
}

function explicitOrdinalRanks(contents: string[]): number[] {
  const values = new Map<string, number>([
    ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5],
    ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10],
  ]);
  return [...new Set(contents.flatMap((content) => [...content.matchAll(/第\s*(\d+|[一二两三四五六七八九十])\s*(?:个|项|款)?/gu)].flatMap((match) => {
    const rank = /^\d+$/u.test(match[1]!) ? Number(match[1]) : values.get(match[1]!);
    return rank && Number.isSafeInteger(rank) ? [rank] : [];
  })))];
}

export function constrainOrdinalRejections(plan: TurnPlan, workingSet: WorkingSet | null, contents: string[] | undefined): TurnPlan {
  if (!workingSet || !contents) return plan;
  const ranks = explicitOrdinalRanks(contents);
  if (ranks.length === 0) return plan;
  const allowed = new Set(ranks.flatMap((rank) => workingSet.displayOfferRefs[rank - 1] ? [workingSet.displayOfferRefs[rank - 1]!] : []));
  if (contents.some((content) => /(?:然后|再|接着).{0,12}(?:现在)?最后一条.{0,8}(?:排除|不要)|(?:排除|不要).{0,12}(?:然后|再|接着).{0,12}(?:现在)?最后一条/iu.test(content))) {
    const afterExplicitRanks = workingSet.displayOfferRefs.filter((_, index) => !ranks.includes(index + 1));
    if (afterExplicitRanks.at(-1)) allowed.add(afterExplicitRanks.at(-1)!);
  }
  const ops = plan.ops.flatMap((operation): TurnOperation[] => {
    if (operation.kind !== "REJECT_OFFERS") return [operation];
    const referents = operation.referents.filter((referent) => referent.kind === "OFFER_REF" && allowed.has(referent.offerRef));
    return referents.length > 0 ? [{ ...operation, referents }] : [];
  });
  return validateTurnPlan({ ...plan, ops });
}
