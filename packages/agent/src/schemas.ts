import { MAX_TURN_OPERATIONS } from "@interec/domain";
import { Type } from "typebox";

// This is the model-facing wire shape, not the trusted domain Money type. Some
// OpenAI-compatible providers represent an explicitly absent budget as empty
// strings. Accept that bounded placeholder here so the deterministic Host can
// discard it from the proposal before strict domain validation.
const money = Type.Object({ amount: Type.String({ maxLength: 64 }), currency: Type.String({ maxLength: 8 }) }, { additionalProperties: false });
const target = Type.Object({
  categoryId: Type.String({ minLength: 1, maxLength: 100 }),
  targetText: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  canonicalModel: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  itemRole: Type.Union([Type.Literal("PRIMARY_PRODUCT"), Type.Literal("ACCESSORY"), Type.Literal("REPLACEMENT_PART"), Type.Literal("BUNDLE"), Type.Literal("SERVICE")]),
  condition: Type.Union([Type.Literal("NEW"), Type.Literal("REFURBISHED"), Type.Literal("USED"), Type.Literal("ANY")]),
}, { additionalProperties: false });
const constraintValue = Type.Union([Type.String({ maxLength: 300 }), Type.Number(), Type.Boolean(), Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })]);
const entity = Type.Object({
  kind: Type.Union([Type.Literal("OFFER"), Type.Literal("MODEL"), Type.Literal("BRAND"), Type.Literal("CATEGORY")]),
  value: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const base = {
  opId: Type.String({ minLength: 1, maxLength: 80 }),
  sourceMessageOrdinal: Type.Integer({ minimum: 0, maximum: 7 }),
  sourceSpan: Type.Optional(Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })),
};
const worldBase = {
  opId: base.opId,
  sourceMessageOrdinal: Type.Optional(base.sourceMessageOrdinal),
  sourceSpan: base.sourceSpan,
};
const referent = Type.Union([
  Type.Object({ kind: Type.Literal("OFFER_REF"), offerRef: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("DISPLAY_RANK"), rank: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("FOCUS") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("COMPARISON") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("TEXT"), text: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
]);

export const turnOperationSchema = Type.Union([
  Type.Object({ ...base, kind: Type.Literal("GOAL_SET_TARGET"), target }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_CLEAR_TARGET") }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_SET_BUDGET"), budget: money }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_CLEAR_BUDGET") }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_SET_RETRIEVAL_MARKETS"), markets: Type.Array(Type.String({ minLength: 2, maxLength: 8 }), { maxItems: 8 }) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_SET_DELIVERY_DESTINATION"), destination: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_SET_STOCK_PREFERENCE"), preference: Type.Union([Type.Literal("ANY"), Type.Literal("KNOWN_IN_STOCK")]) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_UPSERT_CONSTRAINT"), constraint: Type.Object({ key: Type.String({ minLength: 1, maxLength: 100 }), operator: Type.Union([Type.Literal("EQ"), Type.Literal("IN"), Type.Literal("LTE"), Type.Literal("GTE"), Type.Literal("CONTAINS")]), value: constraintValue }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_REMOVE_CONSTRAINT"), key: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_UPSERT_PREFERENCE"), preference: Type.Object({ key: Type.String({ minLength: 1, maxLength: 100 }), value: constraintValue, weight: Type.Number({ minimum: 0, maximum: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_REMOVE_PREFERENCE"), key: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_EXCLUDE_ENTITY"), entity }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_RESTORE_ENTITY"), entity }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_ADD_GAP"), gap: Type.Object({ slotId: Type.String({ minLength: 1, maxLength: 100 }), reasonCodes: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ ...base, kind: Type.Literal("GOAL_RESOLVE_GAP"), slotId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("REJECT_OFFERS"), referents: Type.Array(referent, { minItems: 1, maxItems: 4 }), reasonCode: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("RESTORE_OFFERS"), referents: Type.Array(referent, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("SET_COMPARISON"), referents: Type.Array(referent, { minItems: 2, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("SET_FOCUS"), referent: Type.Union([referent, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({
    ...worldBase,
    kind: Type.Literal("INSPECT_WORKING_SET"),
    referents: Type.Array(referent, { maxItems: 4 }),
    fields: Type.Array(Type.Union([
      Type.Literal("PRICE"),
      Type.Literal("MERCHANT"),
      Type.Literal("MARKET"),
      Type.Literal("STOCK"),
      Type.Literal("MODEL"),
      Type.Literal("CONDITION"),
      Type.Literal("RANKING_REASON"),
      Type.Literal("WARRANTY"),
    ]), { minItems: 1, maxItems: 8 }),
  }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("INSPECT_RESEARCH_COVERAGE") }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("REFILTER_WORKING_SET") }, { additionalProperties: false }),
  Type.Object({
    ...worldBase,
    kind: Type.Literal("RESEARCH_OFFERS"),
    reasonCode: Type.Union([
      Type.Literal("USER_REQUESTED_REFRESH"),
      Type.Literal("GOAL_BECAME_RESEARCH_READY"),
      Type.Literal("TARGET_CHANGED"),
      Type.Literal("INSUFFICIENT_COVERAGE"),
      Type.Literal("STALE_EVIDENCE"),
    ]),
    queryVariant: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("REQUEST_CLARIFICATION"), slotId: Type.String({ minLength: 1, maxLength: 100 }), reasonCode: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ ...worldBase, kind: Type.Literal("UNDO_REVISION"), revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
]);

export const turnPlanSchema = Type.Object({
  userIntentSummary: Type.String({ minLength: 1, maxLength: 400 }),
  ops: Type.Array(turnOperationSchema, { minItems: 1, maxItems: MAX_TURN_OPERATIONS }),
  leftover: Type.Optional(Type.Array(Type.Object({ operation: turnOperationSchema, conditionCode: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { maxItems: 4 })),
}, { additionalProperties: false });

const assistantBlockSchema = Type.Union([
  Type.Object({
    type: Type.Literal("TRANSITION"),
    transitionCode: Type.Union([
      Type.Literal("STATE_UPDATED"),
      Type.Literal("EVIDENCE_SUMMARY"),
      Type.Literal("EVIDENCE_COMPARISON"),
      Type.Literal("RESEARCH_COMPLETED"),
      Type.Literal("CHECKED_PREMISE"),
    ]),
    // Provider compatibility: harmless receipt IDs attached to a transition
    // are accepted here and discarded before the Host sees the proposal.
    claimIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 12 })),
  }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("CLAIM"), claimId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("COMPARISON"), claimIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 2, maxItems: 12 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("QUESTION"), slotId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("DISCLOSURE"), disclosureCode: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
]);

export const assistantEnvelopeSchema = Type.Object({
  outcome: Type.Union([Type.Literal("CHAT"), Type.Literal("CLARIFICATION"), Type.Literal("DISCOVERY"), Type.Literal("RECOMMENDATION"), Type.Literal("NO_MATCH"), Type.Literal("DEGRADED")]),
  blocks: Type.Array(assistantBlockSchema, { minItems: 1, maxItems: 20 }),
  // Keep this as a regular array schema for OpenAI-compatible providers. Empty
  // tuples are rejected by some providers even though they are valid JSON Schema.
  nextMoves: Type.Array(Type.String(), { maxItems: 0 }),
}, { additionalProperties: false });
